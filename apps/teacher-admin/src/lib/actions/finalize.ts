"use server";

import { createAdminDbClient } from "@ai-documenter/db/admin";
import { getServerDbClient } from "@/lib/supabase/server";
import { resolveIframeToken } from "@/lib/iframe/resolve";
import { submitReflectionToCanvas } from "@/lib/finalize/canvas-submit";
import { notifySuperGrader } from "@/lib/finalize/super-grader";
import { isAssignmentInSuperGraderScope } from "@/lib/super-grader/scope";
import {
  saveReflectionToDrive,
  type AiChat,
  type ReflectionMessage,
} from "@/lib/google/save-reflection";

export type FinalizeReflectionInput = {
  iframeToken: string;
};

export type FinalizeReflectionResult =
  | {
      ok: true;
      /** True if Canvas accepted the auto-submission. */
      canvasSubmitted: boolean;
      /** True when the assignment is in super-grader's scope and AID
       *  deliberately skipped its own Canvas write — super-grader owns
       *  the final Canvas post. Mutually exclusive with canvasSubmitted. */
      routedViaSuperGrader: boolean;
      /** Always populated. Surface it to the student when canvasSubmitted=false
       *  AND routedViaSuperGrader=false (the genuine-failure case). */
      completionCode: string;
      /** Present when Canvas POST failed. */
      canvasError: string | null;
      /** True if an objective summary was generated (it's optional — failure
       * doesn't block Canvas submit). */
      summaryGenerated: boolean;
      /** True if the super-grader webhook went through. */
      webhookDelivered: boolean;
    }
  | { ok: false; error: string };

/**
 * Run the closing pipeline after the student finishes the Socratic
 * conversation. Idempotent: callable safely on a `submitted` session (just
 * returns the existing state).
 *
 * Sequence:
 *   1. Validate session is in a finishable state (`completed` or `failed`).
 *   2. POST to Canvas as the student — backfills canvas_user_id on first
 *      encounter. Failure here surfaces the completion code to the student.
 *   3. Fire webhook to super-grader (fire-and-forget shape; we await it for
 *      a single log line but don't expose its failure to the student).
 *
 * The objective summary is already populated on the session — it's generated
 * during the Socratic conversation (turn 0), not here. Finalize just consumes
 * what's already on the row.
 *
 * The student never sees the super-grader status — even if it failed, super-
 * grader will pull-on-view next time the teacher loads the assignment.
 */
export async function finalizeReflection(
  input: FinalizeReflectionInput,
): Promise<FinalizeReflectionResult> {
  // 1. Auth + context.
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
    .select("*")
    .eq("auth_user_id", user.id)
    .maybeSingle();
  if (!student) {
    return { ok: false, error: "Your student account isn't set up yet." };
  }

  // 2. Load the session that just completed.
  const { data: session } = await admin
    .from("reflection_sessions")
    .select("*")
    .eq("teacher_assignment_id", ctx.teacherAssignment.id)
    .eq("student_id", student.id)
    .in("state", ["completed", "submitted", "failed"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!session) {
    return {
      ok: false,
      error: "No completed reflection to finalize.",
    };
  }

  // Idempotent fast path: already submitted, no work to do. An SG-routed
  // session is also state='submitted' but has no canvas_submission_id —
  // distinguishable here so the response carries the right flag.
  if (session.state === "submitted") {
    return {
      ok: true,
      canvasSubmitted: Boolean(session.canvas_submission_id),
      routedViaSuperGrader: !session.canvas_submission_id,
      completionCode: session.completion_code,
      canvasError: null,
      summaryGenerated: session.objective_summary !== null,
      webhookDelivered: true, // assume previously delivered; not retrying
    };
  }

  // 3. Load the teacher (canvas token + host live there).
  const { data: teacher } = await admin
    .from("teachers")
    .select("*")
    .eq("id", ctx.teacherAssignment.teacher_id)
    .single();
  if (!teacher) {
    return { ok: false, error: "Couldn't load the teacher for this assignment." };
  }

  const summaryGenerated = session.objective_summary !== null;

  // M7.3 — auto-save the full reflection (objective summary + Q/A +
  // pasted transcript) to the teacher's Drive folder. Runs BEFORE
  // Canvas submission so the Canvas body can carry the Drive link in
  // place of the inline pasted transcript. Best-effort: a Drive
  // failure (missing token, quota, network) is logged but never blocks
  // Canvas write or the webhook. Idempotent via drive_doc_url sentinel.
  //
  // Gated by post_to_drive_at_session (Phase 1 snapshot) — defaults
  // true so AID matches the M7 "Drive is non-optional" invariant; a
  // teacher who flipped post_to_drive=false on their assignment has
  // that intent persisted on session creation and we honor it here.
  let driveDocUrl: string | null = session.drive_doc_url ?? null;
  const postToDrive =
    session.post_to_drive_at_session ?? ctx.teacherAssignment.post_to_drive;
  if (!driveDocUrl && postToDrive) {
    try {
      const refs = await saveReflectionToDrive({
        id: session.id,
        teacher_id: teacher.id,
        student_id: student.id,
        canvas_assignment_id: ctx.teacherAssignment.canvas_assignment_id,
        first_draft: session.first_draft,
        objective_summary: session.objective_summary,
        reflection_messages:
          (session.reflection_messages as ReflectionMessage[] | null) ?? [],
        ai_chats: (session.ai_chats as AiChat[] | null) ?? [],
        paste_fallback_text: session.paste_fallback_text,
        completed_at: session.completed_at,
        created_at: session.created_at,
      });
      driveDocUrl = refs.doc.webViewLink;
      await admin
        .from("reflection_sessions")
        .update({
          drive_doc_id: refs.doc.id,
          drive_doc_url: refs.doc.webViewLink,
        })
        .eq("id", session.id);
      // Mutate the in-memory row so downstream consumers (canvas-submit
      // body builder, super-grader envelope) see the Drive URL on this
      // turn without a re-fetch.
      session.drive_doc_id = refs.doc.id;
      session.drive_doc_url = refs.doc.webViewLink;
    } catch (err) {
      console.error(
        `[finalize] Drive save failed for session ${session.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  // 3.5. Ask super-grader if it's tracking this assignment. When in scope,
  //      super-grader owns the final Canvas post — we skip our own Canvas
  //      write but still ship the envelope so SG has the data to post.
  //      Fail-open: any error keeps us on the normal Canvas path so a
  //      transient SG outage doesn't silently suppress submissions.
  const scope = await isAssignmentInSuperGraderScope(
    ctx.teacherAssignment.canvas_assignment_id,
  );

  if (scope.in_scope) {
    // Phase 2: state-fenced UPDATE. A concurrent finalize call (refresh
    // during the 10-15s Canvas POST, browser auto-retry, visibilitychange
    // collision) won't re-flip the row's state if it's already moved past
    // 'completed' — the fence treats zero-rows-affected as "another caller
    // beat us, the row already says what we wanted to write" and we just
    // return the existing state via the next select.
    await admin
      .from("reflection_sessions")
      .update({
        state: "submitted",
        submitted_at: new Date().toISOString(),
      })
      .eq("id", session.id)
      .eq("state", "completed");

    const { data: refreshedSession } = await admin
      .from("reflection_sessions")
      .select("*")
      .eq("id", session.id)
      .single();

    let webhookDelivered = false;
    if (refreshedSession) {
      const webhookResult = await notifySuperGrader({
        session: refreshedSession,
        teacher,
        teacherAssignment: ctx.teacherAssignment,
        student,
      });
      if (webhookResult.ok) {
        webhookDelivered = true;
      } else if (!webhookResult.skipped) {
        console.error(
          `[finalize] super-grader webhook failed for session ${session.id} (routed via SG): ${webhookResult.error}`,
        );
      }
    }

    return {
      ok: true,
      canvasSubmitted: false,
      routedViaSuperGrader: true,
      completionCode: session.completion_code,
      canvasError: null,
      summaryGenerated,
      webhookDelivered,
    };
  }

  // 4. Submit to Canvas as the student.
  const canvasResult = await submitReflectionToCanvas({
    session,
    teacher,
    teacherAssignment: ctx.teacherAssignment,
    student,
  });

  // Refresh the student row after possible canvas_user_id backfill, so the
  // super-grader envelope has the canonical fields.
  let refreshedStudent = student;
  if (canvasResult.ok && !student.canvas_user_id) {
    const { data: re } = await admin
      .from("students")
      .select("*")
      .eq("id", student.id)
      .maybeSingle();
    if (re) refreshedStudent = re;
  }

  // 6. Reload the session for the latest state (canvas_submission_id may have
  //    just been set) before notifying super-grader.
  const { data: refreshedSession } = await admin
    .from("reflection_sessions")
    .select("*")
    .eq("id", session.id)
    .single();

  // 7. Fire webhook to super-grader. Awaited so we can return a single
  //    status to the client, but failures don't impact the student.
  let webhookDelivered = false;
  if (refreshedSession) {
    const webhookResult = await notifySuperGrader({
      session: refreshedSession,
      teacher,
      teacherAssignment: ctx.teacherAssignment,
      student: refreshedStudent,
    });
    if (webhookResult.ok) {
      webhookDelivered = true;
    } else if (!webhookResult.skipped) {
      console.error(
        `[finalize] super-grader webhook failed for session ${session.id}: ${webhookResult.error}`,
      );
    }
  }

  // 8. If Canvas failed but completed_at is set, mark session state='failed'
  //    so the dashboard can flag it for the teacher. Phase 2 state fence:
  //    only flip 'completed' → 'failed'. A concurrent finalize that DID
  //    succeed and moved the row to 'submitted' must win.
  if (!canvasResult.ok && refreshedSession?.state !== "submitted") {
    await admin
      .from("reflection_sessions")
      .update({ state: "failed" })
      .eq("id", session.id)
      .eq("state", "completed");
  }

  return {
    ok: true,
    canvasSubmitted: canvasResult.ok,
    routedViaSuperGrader: false,
    completionCode: session.completion_code,
    canvasError: canvasResult.ok ? null : canvasResult.error,
    summaryGenerated,
    webhookDelivered,
  };
}
