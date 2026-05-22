"use server";

import { createAdminDbClient } from "@ai-documenter/db/admin";
import { getServerDbClient } from "@/lib/supabase/server";
import { resolveIframeToken } from "@/lib/iframe/resolve";
import { generateObjectiveSummary } from "@/lib/finalize/objective-summary";
import { RosterMissingError, scrubSessionForGemini } from "@/lib/scrub/session";
import {
  buildContextSections,
  generateCoachTurn,
  HARDCODED_FINAL_QUESTION,
} from "@/lib/socratic/turns";
import type { ReflectionMessage } from "@/lib/socratic/types";

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
      /** Only set on the bootstrap turn — the summary just written to
       * `reflection_sessions.objective_summary`. The client uses this to seed
       * its local objectiveSummary state, since the auth-state refresh that
       * preceded ConversationScreen mount happened *before* the bootstrap and
       * so missed the write. See M4.9 race fix. */
      objectiveSummary?: string;
    }
  | { ok: false; error: string };

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
    // calls below see the same scrubbed view. Phase 0: fail-closed —
    // scrubSessionForGemini throws RosterMissingError when the roster isn't
    // usable, and we refuse to call Gemini rather than ship raw PII.
    let scrubbedSession;
    try {
      scrubbedSession = await scrubSessionForGemini(
        session,
        ctx.teacherAssignment.canvas_course_id,
      );
    } catch (err) {
      if (err instanceof RosterMissingError) {
        console.warn(
          `[nextSocraticTurn bootstrap] roster_missing session=${session.id} reason=${err.reason}`,
        );
        return { ok: false, error: "roster_missing" };
      }
      throw err;
    }

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

    return {
      ok: true,
      messages: newMessages,
      conversationDone: false,
      objectiveSummary: summaryRes.summary,
    };
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
    // Phase 0: fail-closed scrub before the closing Gemini call.
    let scrubbedSession;
    try {
      scrubbedSession = await scrubSessionForGemini(
        session,
        ctx.teacherAssignment.canvas_course_id,
      );
    } catch (err) {
      if (err instanceof RosterMissingError) {
        console.warn(
          `[nextSocraticTurn closing] roster_missing session=${session.id} reason=${err.reason}`,
        );
        return { ok: false, error: "roster_missing" };
      }
      throw err;
    }
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
