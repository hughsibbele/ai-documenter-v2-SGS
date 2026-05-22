"use server";

import { createAdminDbClient } from "@ai-documenter/db/admin";
import { getServerDbClient } from "@/lib/supabase/server";
import { resolveIframeToken } from "@/lib/iframe/resolve";
import { submitReflectionToCanvas } from "@/lib/finalize/canvas-submit";
import { notifySuperGrader } from "@/lib/finalize/super-grader";
import { isAssignmentInSuperGraderScope } from "@/lib/super-grader/scope";

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

  // 3.5. Ask super-grader if it's tracking this assignment. When in scope,
  //      super-grader owns the final Canvas post — we skip our own Canvas
  //      write but still ship the envelope so SG has the data to post.
  //      Fail-open: any error keeps us on the normal Canvas path so a
  //      transient SG outage doesn't silently suppress submissions.
  const scope = await isAssignmentInSuperGraderScope(
    ctx.teacherAssignment.canvas_assignment_id,
  );

  if (scope.in_scope) {
    await admin
      .from("reflection_sessions")
      .update({
        state: "submitted",
        submitted_at: new Date().toISOString(),
      })
      .eq("id", session.id);

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
  //    so the dashboard can flag it for the teacher.
  if (!canvasResult.ok && refreshedSession?.state !== "submitted") {
    await admin
      .from("reflection_sessions")
      .update({ state: "failed" })
      .eq("id", session.id);
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
