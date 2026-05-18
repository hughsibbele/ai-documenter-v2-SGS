import "server-only";

import {
  chatWithGemini,
  GeminiError,
  type GeminiMessage,
} from "@ai-documenter/gemini";
import {
  buildRateLimitMessage,
  checkAndReserveGeminiCall,
} from "@/lib/gemini/rate-limit";
import type { ReflectionMessage } from "./types";

export type { ReflectionMessage };

// Hardcoded second AI message (no Gemini call) — used by the real student
// flow and the teacher preview to keep the second question deterministic.
export const HARDCODED_FINAL_QUESTION =
  "What have you learned about working with AI from this assignment? What, if anything, will you do differently next time?";

type AiChat = { tool: string; url: string; transcript_text: string | null };

// Builds the "context block" Gemini sees ahead of each coach turn: first
// draft, objective summary, AI chats / transcripts, paste fallback. Shared by
// the real reflection (socratic.ts) and the teacher preview (preview.ts).
export function buildContextSections(
  session: {
    first_draft: string | null;
    ai_chats: unknown;
    paste_fallback_text: string | null;
  },
  objectiveSummary: string,
): string {
  const sections: string[] = [];

  const draft = (session.first_draft ?? "").trim();
  if (draft) {
    sections.push("## Student's first-draft reflection (their own words)");
    sections.push(draft);
  }

  if (objectiveSummary.trim()) {
    sections.push("## Objective summary of the AI use (already shared with the student)");
    sections.push(objectiveSummary.trim());
  }

  const chats = (session.ai_chats as AiChat[] | null) ?? [];
  const chatRows = chats.filter((c) => c.url || c.transcript_text);
  if (chatRows.length > 0) {
    sections.push("## AI chats the student used");
    for (const c of chatRows) {
      sections.push(`### ${c.tool}`);
      if (c.url) sections.push(`Share link: ${c.url}`);
      if (c.transcript_text) {
        sections.push("", "Transcript:", c.transcript_text);
      }
    }
  }

  const paste = (session.paste_fallback_text ?? "").trim();
  if (paste) {
    sections.push("## Pasted AI conversation(s)");
    sections.push(paste);
  }

  return sections.length > 0
    ? sections.join("\n\n")
    : "(No context yet for this reflection.)";
}

export type CoachPhase = "alignment_question" | "closing";

export async function generateCoachTurn(args: {
  phase: CoachPhase;
  promptBody: string;
  teacherId: string;
  anonToken: string;
  contextSections: string;
  priorTurns: ReflectionMessage[];
}): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const systemPrompt = buildCoachSystemPrompt(
    args.promptBody,
    args.phase,
    args.anonToken,
  );

  const geminiMessages: GeminiMessage[] = [
    { role: "user", text: args.contextSections },
    ...args.priorTurns.map(
      (m): GeminiMessage => ({
        role: m.role === "ai" ? "model" : "user",
        text: m.text,
      }),
    ),
  ];

  geminiMessages.push({
    role: "user",
    text:
      args.phase === "alignment_question"
        ? "Now write your next message to the student: ONE Socratic question about how the AI use described in the objective summary aligned with the learning goals of this assignment. Under 80 words. Just the question — no preamble, no summary restatement."
        : "Now write your closing message: a warm, brief (60–100 words) summary that ties together what the student reflected on across both of their answers. Do not ask a question. End on a forward-looking note.",
  });

  const gate = await checkAndReserveGeminiCall(args.teacherId);
  if (!gate.allowed) {
    return { ok: false, error: buildRateLimitMessage(gate) };
  }

  try {
    const result = await chatWithGemini({
      apiKey: process.env.GEMINI_API_KEY ?? "",
      model: process.env.GEMINI_MODEL || undefined,
      systemPrompt,
      messages: geminiMessages,
      urlContext: false,
      temperature: args.phase === "alignment_question" ? 0.5 : 0.4,
      maxOutputTokens: 4096,
    });
    const text = result.text.trim();
    if (!text) return { ok: false, error: "Gemini returned an empty reply." };
    return { ok: true, text };
  } catch (err) {
    const status = err instanceof GeminiError ? err.status : 0;
    if (status === 429) {
      return {
        ok: false,
        error: "We've hit our rate limit. Wait a few seconds and try again.",
      };
    }
    return { ok: false, error: (err as Error).message };
  }
}

function buildCoachSystemPrompt(
  promptBody: string,
  phase: CoachPhase,
  anonToken: string,
): string {
  return [
    promptBody.trim(),
    "",
    "Constraints for this conversation:",
    `- Refer to the student as "you". If you must use a name, use ${anonToken}.`,
    "- Don't apologize for technical issues; treat the student's first draft as ground truth.",
    "- Don't use markdown headings or lists. Plain prose only.",
    "- One short paragraph per turn.",
    "",
    phase === "alignment_question"
      ? "Your job right now is to ask exactly ONE Socratic question about how the student's AI use aligned with the learning goals of this assignment (which the teacher's prompt body above describes, or which you should infer reasonably if not specified). Connect it to something concrete from the objective summary or first draft. Do not summarize the student's work back to them."
      : "Your job right now is to write a warm closing summary (60–100 words) tying together what the student reflected on across both of their answers. No new question. End on a brief forward-looking note.",
  ].join("\n");
}
