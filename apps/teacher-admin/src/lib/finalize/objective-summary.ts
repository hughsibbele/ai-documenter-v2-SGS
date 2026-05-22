import "server-only";

import {
  chatWithGemini,
  GeminiError,
  type GeminiMessage,
} from "@ai-documenter/gemini";
import { createAdminDbClient } from "@ai-documenter/db/admin";
import type { Tables } from "@ai-documenter/db";
import {
  buildRateLimitMessage,
  checkAndReserveGeminiCall,
} from "@/lib/gemini/rate-limit";

// Only the fields buildSummaryInput actually reads — narrows the input so
// callers don't have to pad the full ReflectionSession shape (audit L3).
type SummarizableSession = Pick<
  Tables<"reflection_sessions">,
  | "first_draft"
  | "paste_fallback_text"
  | "ai_chats"
  | "reflection_messages"
>;

export type ObjectiveSummaryInput = {
  /**
   * The session to summarize. Caller is responsible for scrubbing free-text
   * fields via `scrubSessionForGemini` BEFORE calling this — Phase 0 of the
   * remediation plan moved the scrub to the caller so the boundary is
   * explicit (and so preview flows that pass synthetic teacher-typed data
   * can opt out cleanly).
   */
  session: SummarizableSession;
  /** Owner of the teacher_assignment this session belongs to. Used to
   *  scope the daily Gemini-call cap. */
  teacherId: string;
  /**
   * Stable per-student Student_xxxxxx token. Plumbed in by the orchestrator
   * so the prompt has something to refer to the student by if it needs to
   * (it shouldn't — the seeded prompt instructs Gemini to leave tokens
   * as-is and never use real names). The session row itself contains no
   * student PII; this token is the only identity anchor in the input.
   */
  anonToken: string;
};

export type ObjectiveSummaryResult =
  | { ok: true; summary: string; citedUrls: string[] }
  | { ok: false; error: string };

type AiChat = { tool: string; url: string; transcript_text: string | null };
type ReflectionMessage = { role: "ai" | "student"; text: string; ts: string };

/**
 * Generates the ~100-word objective summary of a student's AI use for an
 * assignment. Server-side only. Pure: doesn't write to the DB — the
 * orchestrator (finalizeReflection) persists the result and handles routing
 * the summary to super-grader / teacher review.
 *
 * The system prompt (admin-edited, `purpose='objective_summary'`, `is_default`)
 * instructs Gemini to:
 *   - lead with what the student actually did (concrete, specific)
 *   - leave `Student_xxxxxx` tokens as-is, never use real names
 *   - flag transcript/reflection mismatches as facts (not judgments)
 *   - output one paragraph of plain prose, no markdown
 *
 * Failure modes:
 *   - The seeded prompt row is missing  → returns ok:false ("not configured")
 *   - Gemini errors / empty response   → returns ok:false (rate-limit message
 *                                         if 429, otherwise the underlying message)
 *
 * Anonymization: free-text scrubbing happens at the caller (Phase 0 contract).
 * Structured PII is already absent from the session row by construction
 * (display_name is never copied in).
 */
export async function generateObjectiveSummary(
  input: ObjectiveSummaryInput,
): Promise<ObjectiveSummaryResult> {
  const admin = createAdminDbClient();
  const { data: prompt, error: promptError } = await admin
    .from("prompts")
    .select("body")
    .eq("scope", "system")
    .eq("purpose", "objective_summary")
    .eq("is_default", true)
    .maybeSingle();

  if (promptError) {
    return {
      ok: false,
      error: `Couldn't load objective-summary prompt: ${promptError.message}`,
    };
  }
  if (!prompt?.body) {
    return {
      ok: false,
      error: "Objective-summary system prompt is not configured.",
    };
  }

  const inputText = buildSummaryInput(input.session, input.anonToken);
  const messages: GeminiMessage[] = [{ role: "user", text: inputText }];

  const gate = await checkAndReserveGeminiCall(input.teacherId);
  if (!gate.allowed) {
    return { ok: false, error: buildRateLimitMessage(gate) };
  }

  try {
    const result = await chatWithGemini({
      apiKey: process.env.GEMINI_API_KEY ?? "",
      model: process.env.GEMINI_MODEL || undefined,
      systemPrompt: prompt.body,
      messages,
      // url-context lets Gemini fetch ChatGPT/Claude share links if present.
      // Gemini share pages are typically JS-rendered and won't yield content;
      // paste-fallback covers those, so the URL fetch is best-effort here too.
      urlContext: true,
      // Lower than the Socratic temperature — descriptive prose, not creative.
      temperature: 0.3,
      // Generous budget — Gemini 3's thinking tokens count against this, so
      // anything below ~4k can chop the visible output mid-sentence.
      maxOutputTokens: 4096,
    });
    const summary = result.text.trim();
    if (!summary) {
      return { ok: false, error: "Gemini returned an empty summary." };
    }
    return { ok: true, summary, citedUrls: result.citedUrls };
  } catch (err) {
    const status = err instanceof GeminiError ? err.status : 0;
    if (status === 429) {
      return {
        ok: false,
        error: "Rate-limited by Gemini while generating the summary.",
      };
    }
    return { ok: false, error: (err as Error).message };
  }
}

// ---------------------------------------------------------------------------

function buildSummaryInput(
  session: SummarizableSession,
  anonToken: string,
): string {
  const sections: string[] = [
    `Student token: ${anonToken}`,
    "",
    "## Student's first-draft reflection (their own words, before coaching)",
    (session.first_draft ?? "").trim() || "(none submitted)",
  ];

  const chats = (session.ai_chats as AiChat[] | null) ?? [];
  const chatRows = chats.filter((c) => c.url || c.transcript_text);
  if (chatRows.length > 0) {
    sections.push("", "## AI chats the student used");
    for (const c of chatRows) {
      sections.push(`### ${c.tool}`);
      if (c.url) sections.push(`Share link: ${c.url}`);
      if (c.transcript_text) {
        sections.push("", "Transcript:", c.transcript_text);
      }
    }
  }

  const paste = (session.paste_fallback_text ?? "").trim();
  if (paste.length > 0) {
    sections.push("", "## Pasted AI conversation(s)", paste);
  }

  const messages = (session.reflection_messages as ReflectionMessage[] | null) ?? [];
  if (messages.length > 0) {
    sections.push("", "## Socratic reflection conversation");
    for (const m of messages) {
      const speaker = m.role === "ai" ? "Coach" : "Student";
      sections.push(`**${speaker}:** ${m.text}`);
    }
  }

  return sections.join("\n");
}
