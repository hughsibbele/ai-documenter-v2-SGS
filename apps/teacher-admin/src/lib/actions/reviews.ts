"use server";

import { revalidatePath } from "next/cache";
import { createAdminDbClient } from "@ai-documenter/db/admin";
import { getCurrentTeacher } from "@/lib/auth/teacher";
import { submitReflectionToCanvas } from "@/lib/finalize/canvas-submit";
import { isAssignmentInSuperGraderScope } from "@/lib/super-grader/scope";

export type ResendToCanvasResult =
  | { ok: true; submissionId: number }
  | { ok: false; message: string };

/**
 * Retry the Canvas auto-submit for a reflection_session that previously
 * failed. The teacher initiates this from the per-assignment review page.
 *
 * Auth check: load the session, walk to teacher_assignment, and verify the
 * teacher_id matches the calling teacher. We use the admin client to read
 * across student-self RLS, then enforce ownership manually.
 *
 * Side effects on success: reflection_sessions.state → 'submitted',
 * canvas_submission_id populated, submission_attempts logged.
 */
export async function resendToCanvas(
  reflectionSessionId: string,
): Promise<ResendToCanvasResult> {
  const teacher = await getCurrentTeacher();
  const admin = createAdminDbClient();

  const { data: session } = await admin
    .from("reflection_sessions")
    .select("*")
    .eq("id", reflectionSessionId)
    .maybeSingle();

  if (!session) {
    return { ok: false, message: "Couldn't find that reflection." };
  }

  // Phase 2 state fence: refuse to re-POST if the row is already in
  // 'submitted' with a canvas_submission_id. The original audit C3 case
  // — teacher re-clicks Resend → duplicate gradebook comment / body
  // overwrite — closes here. The remaining valid resend targets are
  // 'failed' (Canvas POST errored) and 'completed' (finalize never
  // landed for some reason).
  if (session.state === "submitted" && session.canvas_submission_id) {
    return {
      ok: false,
      message:
        "This reflection has already been submitted to Canvas. Refresh to see the current state.",
    };
  }

  const { data: ta } = await admin
    .from("teacher_assignments")
    .select("*")
    .eq("id", session.teacher_assignment_id)
    .maybeSingle();

  if (!ta || ta.teacher_id !== teacher.id) {
    return { ok: false, message: "You don't own that reflection." };
  }

  const { data: student } = await admin
    .from("students")
    .select("*")
    .eq("id", session.student_id)
    .maybeSingle();

  if (!student) {
    return { ok: false, message: "Couldn't load the student." };
  }

  // Refuse the resend if super-grader is now tracking this assignment —
  // super-grader owns the Canvas post, and retrying here would create a
  // duplicate the moment the teacher posts via SG.
  const scope = await isAssignmentInSuperGraderScope(ta.canvas_assignment_id);
  if (scope.in_scope) {
    return {
      ok: false,
      message:
        "This assignment is routed via super-grader. Post the grade + comment from super-grader instead of resending here.",
    };
  }

  const result = await submitReflectionToCanvas({
    session,
    teacher,
    teacherAssignment: ta,
    student,
  });

  if (!result.ok) {
    return { ok: false, message: result.error };
  }

  revalidatePath(
    `/dashboard/reviews/${ta.canvas_course_id}/${ta.canvas_assignment_id}`,
  );
  return { ok: true, submissionId: result.submissionId };
}
