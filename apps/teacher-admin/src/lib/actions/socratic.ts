"use server";

import { createAdminDbClient } from "@ai-documenter/db/admin";
import {
  chatWithGemini,
  GeminiError,
  type GeminiMessage,
} from "@ai-documenter/gemini";
import { getServerDbClient } from "@/lib/supabase/server";
import { resolveIframeToken } from "@/lib/iframe/resolve";
import { generateObjectiveSummary } from "@/lib/finalize/objective-summary";
import {
  buildRateLimitMessage,
  checkAndReserveGeminiCall,
} from "@/lib/gemini/rate-limit";
import { scrubSessionForGemini } from "@/lib/scrub/session";

export type ReflectionMessage = {
  role: "ai" | "student";
  text: string;
  ts: string;
};

export type SocraticTurnInput = {
  iframeToken: string;
  /** Empty string for the bootstrap call (no student message yet). */
  studentMessage: string;
};

export type SocraticTurnResult =
  | {
      ok: true;
      messages: ReflectionMessage[];
      conversationDone: boolean;
    }
  | { ok: false; error: string };

const HARDCODED_FINAL_QUESTION =
  "What have you learned about working with AI from this assignment? What, if anything, will you do differently next time?";

// State machine (lengths in reflection_messages):
//
//   0 → bootstrap: generate objective summary (AI msg 0) + alignment question
//       (AI msg 1) as TWO separate AI messages. After: length = 2.
//   2 → student answers alignment Q → append student turn + hardcoded final
//       question. After: length = 4.
//   4 → student answers final Q → append student turn + Gemini-generated
//       closing summary. After: length = 6. State → 'completed'.
//   6 → conversationDone = true; idle resume returns current.
//
// Three Gemini calls per full conversation: summary, alignment Q, closing.
// Final Q is hardcoded (no Gemini call) for determinism.
export async function nextSocraticTurn(
  input: SocraticTurnInput,
): Promise<SocraticTurnResult> {
  const ctx = await resolveIframeToken(input.iframeToken);
  if (!ctx) {
    return { ok: false, error: "This reflection link is no longer valid." };
  }

  const supabase = await getServerDbClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { ok: false, error: "You're not signed in." };
  }

  const admin = createAdminDbClient();
  const { data: student } = await admin
    .from("students")
    .select("id, display_name, anon_token")
    .eq("auth_user_id", user.id)
    .maybeSingle();
  if (!student) {
    return { ok: false, error: "Your student account isn't set up yet." };
  }

  const { data: session } = await admin
    .from("reflection_sessions")
    .select(
      "id, state, reflection_messages, ai_chats, paste_fallback_text, first_draft, objective_summary",
    )
    .eq("teacher_assignment_id", ctx.teacherAssignment.id)
    .eq("student_id", student.id)
    .in("state", ["in_progress", "completed", "submitted"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!session) {
    return {
      ok: false,
      error: "No active reflection. Start by completing the intake form.",
    };
  }

  const prior =
    (session.reflection_messages as ReflectionMessage[] | null) ?? [];
  const studentMsg = input.studentMessage.trim();
  const isDone = session.state === "completed" || session.state === "submitted";

  // Idle resume.
  if (isDone || (studentMsg === "" && prior.length > 0)) {
    return { ok: true, messages: prior, conversationDone: isDone };
  }

  // ---- Bootstrap: summary + alignment question ----
  if (prior.length === 0) {
    // Scrub free-text fields against the course roster once; both Gemini
    // calls below see the same scrubbed view.
    const scrubbedSession = await scrubSessionForGemini(
      session,
      ctx.teacherAssignment.canvas_course_id,
    );

    const summaryRes = await generateObjectiveSummary({
      session: {
        ...scrubbedSession,
        // Pad the rest of the session row for the type's sake; the helper
        // only reads a subset.
        ai_tools_used: null,
        canvas_submission_id: null,
        completed_at: null,
        completion_code: "",
        created_at: "",
        expires_at: "",
        student_id: student.id,
        submitted_at: null,
        teacher_assignment_id: ctx.teacherAssignment.id,
        time_spent_estimate: null,
      },
      teacherId: ctx.teacherAssignment.teacher_id,
      canvasCourseId: ctx.teacherAssignment.canvas_course_id,
      anonToken: student.anon_token,
    });
    if (!summaryRes.ok) {
      return {
        ok: false,
        error: `Couldn't generate the objective summary: ${summaryRes.error}`,
      };
    }

    const alignmentRes = await generateCoachTurn({
      phase: "alignment_question",
      promptBody: ctx.prompt.body,
      teacherId: ctx.teacherAssignment.teacher_id,
      anonToken: student.anon_token,
      contextSections: buildContextSections(scrubbedSession, summaryRes.summary),
      priorTurns: [],
    });
    if (!alignmentRes.ok) {
      return {
        ok: false,
        error: `Couldn't generate the coach's question: ${alignmentRes.error}`,
      };
    }

    const now = new Date().toISOString();
    const newMessages: ReflectionMessage[] = [
      { role: "ai", text: summaryRes.summary, ts: now },
      { role: "ai", text: alignmentRes.text, ts: now },
    ];

    await admin
      .from("reflection_sessions")
      .update({
        reflection_messages: newMessages,
        objective_summary: summaryRes.summary,
      })
      .eq("id", session.id);

    return { ok: true, messages: newMessages, conversationDone: false };
  }

  // ---- Student answers Q1 → append student turn + hardcoded final Q ----
  if (prior.length === 2 && studentMsg !== "") {
    const now = new Date().toISOString();
    const newMessages: ReflectionMessage[] = [
      ...prior,
      { role: "student", text: studentMsg, ts: now },
      { role: "ai", text: HARDCODED_FINAL_QUESTION, ts: now },
    ];
    await admin
      .from("reflection_sessions")
      .update({ reflection_messages: newMessages })
      .eq("id", session.id);
    return { ok: true, messages: newMessages, conversationDone: false };
  }

  // ---- Student answers Q2 → append + Gemini-generated closing → completed ----
  if (prior.length === 4 && studentMsg !== "") {
    const now = new Date().toISOString();
    const withStudent: ReflectionMessage[] = [
      ...prior,
      { role: "student", text: studentMsg, ts: now },
    ];
    const scrubbedSession = await scrubSessionForGemini(
      session,
      ctx.teacherAssignment.canvas_course_id,
    );
    const closingRes = await generateCoachTurn({
      phase: "closing",
      promptBody: ctx.prompt.body,
      teacherId: ctx.teacherAssignment.teacher_id,
      anonToken: student.anon_token,
      contextSections: buildContextSections(
        scrubbedSession,
        session.objective_summary ?? "",
      ),
      priorTurns: withStudent,
    });
    if (!closingRes.ok) {
      // Don't block conversation completion on a closing-summary failure;
      // emit a brief fallback so the student sees something land.
      const finalMessages: ReflectionMessage[] = [
        ...withStudent,
        {
          role: "ai",
          text:
            "Thanks for reflecting. Your responses will be submitted to Canvas alongside this conversation.",
          ts: now,
        },
      ];
      await admin
        .from("reflection_sessions")
        .update({
          reflection_messages: finalMessages,
          state: "completed",
          completed_at: now,
        })
        .eq("id", session.id);
      return { ok: true, messages: finalMessages, conversationDone: true };
    }

    const finalMessages: ReflectionMessage[] = [
      ...withStudent,
      { role: "ai", text: closingRes.text, ts: now },
    ];
    await admin
      .from("reflection_sessions")
      .update({
        reflection_messages: finalMessages,
        state: "completed",
        completed_at: now,
      })
      .eq("id", session.id);
    return { ok: true, messages: finalMessages, conversationDone: true };
  }

  // Fallback: unknown state — just return what we have.
  return { ok: true, messages: prior, conversationDone: isDone };
}

// ---------------------------------------------------------------------------
// Gemini call for the reflection-prompt-driven turns (alignment Q + closing).
// The objective summary uses its own dedicated helper in /lib/finalize/.

type CoachPhase = "alignment_question" | "closing";

async function generateCoachTurn(args: {
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

  // Final user-instruction nudge per phase. Comes AFTER the conversation
  // turns so the model has the freshest context.
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
      // Generous budget — Gemini 3's thinking tokens count against this. At
      // lower caps (~256/512) the visible reply lands mid-sentence.
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

// ---------------------------------------------------------------------------

type AiChat = { tool: string; url: string; transcript_text: string | null };

function buildContextSections(
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
