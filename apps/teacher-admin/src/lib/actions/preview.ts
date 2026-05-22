"use server";

import { createAdminDbClient } from "@ai-documenter/db/admin";
import { getCurrentTeacher } from "@/lib/auth/teacher";
import { generateObjectiveSummary } from "@/lib/finalize/objective-summary";
import { buildSubmissionBody } from "@/lib/finalize/canvas-submit";
import {
  buildContextSections,
  generateCoachTurn,
  HARDCODED_FINAL_QUESTION,
} from "@/lib/socratic/turns";
import type { ReflectionMessage } from "@/lib/socratic/types";

// All three actions are teacher-authed only, take everything they need as
// arguments (no DB reads of student/session state), and write nothing
// anywhere. The teacher's daily Gemini-call cap still applies — preview
// can't bypass the rate-limit gate.
//
// The teacher-typed "intake" stays in browser state across the round-trip
// and is passed back to the server on every call. The objective summary
// generated at bootstrap is similarly returned to the client and shipped
// back on later calls — preview never persists it.

export type PreviewIntake = {
  chats: { tool: "gemini" | "chatgpt" | "claude"; url: string }[];
  pasteFallbackText: string;
  firstDraft: string;
};

const PREVIEW_ANON_TOKEN = "Student_PREVIEW";
// Preview is teacher-only and uses synthetic teacher-typed content — no
// student PII to scrub. As of Phase 0 of REMEDIATION_PLAN.md, the scrub
// boundary lives at the caller (in socratic.ts for real students) so we
// simply don't invoke it here; generateObjectiveSummary no longer scrubs
// internally either. Caller contract: pre-scrubbed (or scrub-exempt) session.

// Shape generateObjectiveSummary expects. Mirrors the padding done at the
// real call site in socratic.ts so the helper's type signature is satisfied.
function buildSyntheticSession(
  intake: PreviewIntake,
  reflectionMessages: ReflectionMessage[],
  objectiveSummary: string | null,
) {
  return {
    id: "preview",
    state: "in_progress" as const,
    first_draft: intake.firstDraft,
    paste_fallback_text: intake.pasteFallbackText.trim() || null,
    ai_chats: intake.chats
      .filter((c) => c.url.trim().length > 0)
      .map((c) => ({
        tool: c.tool,
        url: c.url.trim(),
        transcript_text: null,
      })),
    ai_tools_used: Array.from(
      new Set(
        intake.chats.filter((c) => c.url.trim()).map((c) => c.tool),
      ),
    ),
    objective_summary: objectiveSummary,
    reflection_messages: reflectionMessages,
    time_spent_estimate: null,
    canvas_submission_id: null,
    completed_at: null,
    completion_code: "",
    created_at: "",
    expires_at: "",
    student_id: "preview",
    submitted_at: null,
    teacher_assignment_id: "preview",
  };
}

async function loadPromptOrFail(
  promptId: string,
): Promise<
  | { ok: true; body: string }
  | { ok: false; error: string }
> {
  const admin = createAdminDbClient();
  const { data: prompt } = await admin
    .from("prompts")
    .select("body, purpose")
    .eq("id", promptId)
    .maybeSingle();
  if (!prompt) return { ok: false, error: "Prompt not found." };
  if (prompt.purpose !== "reflection") {
    return { ok: false, error: "Only reflection prompts can be previewed." };
  }
  return { ok: true, body: prompt.body };
}

// ---------------------------------------------------------------------------

export type PreviewBootstrapResult =
  | {
      ok: true;
      messages: ReflectionMessage[];
      objectiveSummary: string;
    }
  | { ok: false; error: string };

export async function previewBootstrapReflection(input: {
  promptId: string;
  intake: PreviewIntake;
}): Promise<PreviewBootstrapResult> {
  const teacher = await getCurrentTeacher();
  const promptRes = await loadPromptOrFail(input.promptId);
  if (!promptRes.ok) return promptRes;

  const session = buildSyntheticSession(input.intake, [], null);

  const summaryRes = await generateObjectiveSummary({
    session,
    teacherId: teacher.id,
    anonToken: PREVIEW_ANON_TOKEN,
  });
  if (!summaryRes.ok) {
    return {
      ok: false,
      error: `Couldn't generate the objective summary: ${summaryRes.error}`,
    };
  }

  const alignmentRes = await generateCoachTurn({
    phase: "alignment_question",
    promptBody: promptRes.body,
    teacherId: teacher.id,
    anonToken: PREVIEW_ANON_TOKEN,
    contextSections: buildContextSections(session, summaryRes.summary),
    priorTurns: [],
  });
  if (!alignmentRes.ok) {
    return {
      ok: false,
      error: `Couldn't generate the coach's question: ${alignmentRes.error}`,
    };
  }

  const now = new Date().toISOString();
  return {
    ok: true,
    objectiveSummary: summaryRes.summary,
    messages: [
      { role: "ai", text: summaryRes.summary, ts: now },
      { role: "ai", text: alignmentRes.text, ts: now },
    ],
  };
}

// ---------------------------------------------------------------------------

export type PreviewTurnResult =
  | {
      ok: true;
      messages: ReflectionMessage[];
      conversationDone: boolean;
    }
  | { ok: false; error: string };

export async function previewNextSocraticTurn(input: {
  promptId: string;
  intake: PreviewIntake;
  objectiveSummary: string;
  priorMessages: ReflectionMessage[];
  studentMessage: string;
}): Promise<PreviewTurnResult> {
  const teacher = await getCurrentTeacher();
  const studentMsg = input.studentMessage.trim();
  if (!studentMsg) {
    return { ok: false, error: "Empty message." };
  }

  // Mirrors the state-machine branches in socratic.ts. Lengths 2 and 4 are
  // the only legal entry points for a student turn; everything else is a
  // no-op idle return.
  if (input.priorMessages.length === 2) {
    const now = new Date().toISOString();
    const newMessages: ReflectionMessage[] = [
      ...input.priorMessages,
      { role: "student", text: studentMsg, ts: now },
      { role: "ai", text: HARDCODED_FINAL_QUESTION, ts: now },
    ];
    return { ok: true, messages: newMessages, conversationDone: false };
  }

  if (input.priorMessages.length === 4) {
    const promptRes = await loadPromptOrFail(input.promptId);
    if (!promptRes.ok) return promptRes;

    const now = new Date().toISOString();
    const withStudent: ReflectionMessage[] = [
      ...input.priorMessages,
      { role: "student", text: studentMsg, ts: now },
    ];
    const session = buildSyntheticSession(
      input.intake,
      input.priorMessages,
      input.objectiveSummary,
    );
    const closingRes = await generateCoachTurn({
      phase: "closing",
      promptBody: promptRes.body,
      teacherId: teacher.id,
      anonToken: PREVIEW_ANON_TOKEN,
      contextSections: buildContextSections(session, input.objectiveSummary),
      priorTurns: withStudent,
    });
    if (!closingRes.ok) {
      return {
        ok: true,
        conversationDone: true,
        messages: [
          ...withStudent,
          {
            role: "ai",
            text:
              "Thanks for reflecting. Your responses will be submitted to Canvas alongside this conversation.",
            ts: now,
          },
        ],
      };
    }
    return {
      ok: true,
      conversationDone: true,
      messages: [
        ...withStudent,
        { role: "ai", text: closingRes.text, ts: now },
      ],
    };
  }

  return {
    ok: true,
    messages: input.priorMessages,
    conversationDone: input.priorMessages.length >= 6,
  };
}

// ---------------------------------------------------------------------------

// Render the exact HTML body the student's Canvas submission would carry, so
// the teacher sees what their students send. Pure formatting — no Gemini, no
// DB. Auth-gated only because there's no reason to expose it to anon callers.

export async function previewBuildSubmissionBody(input: {
  intake: PreviewIntake;
  objectiveSummary: string;
  messages: ReflectionMessage[];
}): Promise<{ ok: true; html: string } | { ok: false; error: string }> {
  await getCurrentTeacher();
  const html = buildSubmissionBody({
    iframeToken: "preview",
    firstDraft: input.intake.firstDraft,
    objectiveSummary: input.objectiveSummary,
    reflectionMessages: input.messages,
    aiChats: input.intake.chats
      .filter((c) => c.url.trim().length > 0)
      .map((c) => ({
        tool: c.tool,
        url: c.url.trim(),
        transcript_text: null,
      })),
    pasteFallback: input.intake.pasteFallbackText,
  });
  return { ok: true, html };
}
