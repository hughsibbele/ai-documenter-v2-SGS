"use server";

import { createAdminDbClient } from "@ai-documenter/db/admin";
import type { Json } from "@ai-documenter/db";
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
      "id, state, reflection_messages, ai_chats, paste_fallback_text, first_draft, objective_summary, prompt_body_snapshot, roster_snapshot",
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

  // Phase 1: prefer the prompt body frozen at intake time. Mid-conversation
  // teacher edits (auto-save commits every keystroke) cannot reach back and
  // change what the Gemini system prompt is for this reflection. Legacy
  // (pre-snapshot) sessions fall back to the live `prompts` row.
  const promptBody = session.prompt_body_snapshot ?? ctx.prompt.body;

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
      session: scrubbedSession,
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
      promptBody,
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

    // Phase 2: atomic state-fenced advance. If another caller raced this
    // bootstrap (e.g., a page refresh during the 5–10s Gemini call), the
    // RPC's expected_length=0 fence will fail and we'll return the
    // existing row's state instead of clobbering it.
    const applied = await advanceTurn(admin, {
      sessionId: session.id,
      expectedLength: 0,
      newMessages,
      newState: "in_progress",
      objectiveSummary: summaryRes.summary,
    });
    if (!applied) {
      console.warn(
        `[nextSocraticTurn bootstrap] no_op session=${session.id} — another caller advanced first`,
      );
      return await reReadAndReturn(admin, session.id);
    }

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
    const applied = await advanceTurn(admin, {
      sessionId: session.id,
      expectedLength: 2,
      newMessages,
      newState: "in_progress",
    });
    if (!applied) {
      console.warn(
        `[nextSocraticTurn Q1->Q2] no_op session=${session.id} — another caller advanced first`,
      );
      return await reReadAndReturn(admin, session.id);
    }
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
      promptBody,
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
      const applied = await advanceTurn(admin, {
        sessionId: session.id,
        expectedLength: 4,
        newMessages: finalMessages,
        newState: "completed",
        completedAt: now,
      });
      if (!applied) {
        console.warn(
          `[nextSocraticTurn closing-fallback] no_op session=${session.id} — another caller advanced first`,
        );
        return await reReadAndReturn(admin, session.id);
      }
      return { ok: true, messages: finalMessages, conversationDone: true };
    }

    const finalMessages: ReflectionMessage[] = [
      ...withStudent,
      { role: "ai", text: closingRes.text, ts: now },
    ];
    const applied = await advanceTurn(admin, {
      sessionId: session.id,
      expectedLength: 4,
      newMessages: finalMessages,
      newState: "completed",
      completedAt: now,
    });
    if (!applied) {
      console.warn(
        `[nextSocraticTurn closing] no_op session=${session.id} — another caller advanced first`,
      );
      return await reReadAndReturn(admin, session.id);
    }
    return { ok: true, messages: finalMessages, conversationDone: true };
  }

  // Fallback: unknown state — just return what we have.
  return { ok: true, messages: prior, conversationDone: isDone };
}

// ---------------------------------------------------------------------------

type AdvanceArgs = {
  sessionId: string;
  expectedLength: number;
  newMessages: ReflectionMessage[];
  newState: "in_progress" | "completed";
  objectiveSummary?: string;
  completedAt?: string;
};

/**
 * Phase 2: invoke the advance_socratic_turn RPC. Returns true when the
 * UPDATE applied (we hold the advance), false when another caller raced us
 * and the row's length/state no longer match the expected fence.
 */
async function advanceTurn(
  admin: ReturnType<typeof createAdminDbClient>,
  args: AdvanceArgs,
): Promise<boolean> {
  const { data, error } = await admin.rpc("advance_socratic_turn", {
    p_session_id: args.sessionId,
    p_expected_length: args.expectedLength,
    p_new_messages: args.newMessages as unknown as Json,
    p_new_state: args.newState,
    p_objective_summary: args.objectiveSummary,
    p_completed_at: args.completedAt,
  });
  if (error) {
    throw new Error(`advance_socratic_turn rpc failed: ${error.message}`);
  }
  return (data ?? 0) > 0;
}

/**
 * Phase 2: idempotent recovery path when the advance fence rejects our
 * write because another caller (refresh, retry, visibilitychange) advanced
 * first. Re-reads the row and returns whatever its current state encodes,
 * so the caller's UX renders the winning payload instead of erroring or
 * looping.
 */
async function reReadAndReturn(
  admin: ReturnType<typeof createAdminDbClient>,
  sessionId: string,
): Promise<SocraticTurnResult> {
  const { data: fresh } = await admin
    .from("reflection_sessions")
    .select("state, reflection_messages, objective_summary")
    .eq("id", sessionId)
    .maybeSingle();
  if (!fresh) {
    return { ok: false, error: "Session disappeared during advance." };
  }
  const messages =
    (fresh.reflection_messages as ReflectionMessage[] | null) ?? [];
  const isDone =
    fresh.state === "completed" || fresh.state === "submitted";
  return {
    ok: true,
    messages,
    conversationDone: isDone,
    objectiveSummary: fresh.objective_summary ?? undefined,
  };
}
