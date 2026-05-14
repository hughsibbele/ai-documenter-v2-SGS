import "server-only";

import { createAdminDbClient } from "@ai-documenter/db/admin";
import type { Tables } from "@ai-documenter/db";
import { getServerDbClient } from "@/lib/supabase/server";

export type ReflectionMessage = {
  role: "ai" | "student";
  text: string;
  ts: string;
};

export type AiChat = {
  tool: string;
  url: string;
  transcript_text: string | null;
};

export type StudentSummary = Pick<
  Tables<"students">,
  "id" | "display_name" | "email" | "anon_token" | "canvas_user_id"
>;

export type SubmissionAttempt = Tables<"submission_attempts">;

export type ReflectionView = {
  session: Tables<"reflection_sessions">;
  student: StudentSummary;
  latestAttempt: SubmissionAttempt | null;
};

export type AssignmentReviewBundle = {
  teacherAssignment: Tables<"teacher_assignments">;
  courseName: string | null;
  assignmentName: string | null;
  reflections: ReflectionView[];
};

/**
 * Load every reflection_session for a (teacher, course, assignment) tuple.
 *
 * Ownership is enforced by the first query: the teacher_assignments row is
 * fetched via the cookie-context client, which means RLS only returns it if
 * the current teacher owns it. Subsequent reads happen via the admin client
 * because reflection_sessions + students have student-self RLS that blocks
 * teachers from reading directly.
 *
 * Returns `null` if the teacher doesn't own the assignment (or it doesn't
 * exist). The page renders 404 in that case.
 */
export async function loadAssignmentReview(
  canvasCourseId: string,
  canvasAssignmentId: string,
): Promise<AssignmentReviewBundle | null> {
  const supabase = await getServerDbClient();

  const { data: ta } = await supabase
    .from("teacher_assignments")
    .select("*")
    .eq("canvas_course_id", canvasCourseId)
    .eq("canvas_assignment_id", canvasAssignmentId)
    .maybeSingle();

  if (!ta) return null;

  const admin = createAdminDbClient();

  const [
    { data: sessions },
    { data: course },
    { data: assignment },
  ] = await Promise.all([
    admin
      .from("reflection_sessions")
      .select("*")
      .eq("teacher_assignment_id", ta.id)
      .order("submitted_at", { ascending: false, nullsFirst: false })
      .order("completed_at", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false }),
    admin
      .from("canvas_course_cache")
      .select("name")
      .eq("teacher_id", ta.teacher_id)
      .eq("canvas_course_id", ta.canvas_course_id)
      .maybeSingle(),
    admin
      .from("canvas_assignment_cache")
      .select("name")
      .eq("teacher_id", ta.teacher_id)
      .eq("canvas_assignment_id", ta.canvas_assignment_id)
      .maybeSingle(),
  ]);

  const sessionRows = sessions ?? [];

  // Batch-fetch students + most-recent submission_attempts.
  const studentIds = Array.from(new Set(sessionRows.map((s) => s.student_id)));
  const sessionIds = sessionRows.map((s) => s.id);

  const [{ data: students }, { data: attempts }] = await Promise.all([
    studentIds.length
      ? admin
          .from("students")
          .select("id, display_name, email, anon_token, canvas_user_id")
          .in("id", studentIds)
      : Promise.resolve({ data: [] as StudentSummary[] }),
    sessionIds.length
      ? admin
          .from("submission_attempts")
          .select("*")
          .in("reflection_session_id", sessionIds)
          .order("attempted_at", { ascending: false })
      : Promise.resolve({ data: [] as SubmissionAttempt[] }),
  ]);

  const studentById = new Map<string, StudentSummary>(
    (students ?? []).map((s) => [s.id, s]),
  );
  // First attempt per session wins (rows pre-sorted DESC by attempted_at).
  const latestAttemptBySession = new Map<string, SubmissionAttempt>();
  for (const a of attempts ?? []) {
    if (!latestAttemptBySession.has(a.reflection_session_id)) {
      latestAttemptBySession.set(a.reflection_session_id, a);
    }
  }

  const reflections: ReflectionView[] = sessionRows
    .map((session) => {
      const student = studentById.get(session.student_id);
      if (!student) return null; // shouldn't happen, but guards against orphan rows
      return {
        session,
        student,
        latestAttempt: latestAttemptBySession.get(session.id) ?? null,
      };
    })
    .filter((r): r is ReflectionView => r !== null);

  return {
    teacherAssignment: ta,
    courseName: course?.name ?? null,
    assignmentName: assignment?.name ?? null,
    reflections,
  };
}

export type ReviewIndexEntry = {
  canvasCourseId: string;
  courseName: string | null;
  courseCode: string | null;
  termName: string | null;
  canvasAssignmentId: string;
  assignmentName: string | null;
  dueAt: string | null;
  totalReflections: number;
  submittedCount: number;
  failedCount: number;
  inProgressCount: number;
};

/**
 * Load the Reviews index — every installed assignment for the current teacher
 * plus a per-status count of reflection_sessions for each. Used by
 * `/dashboard/reviews`.
 *
 * The "installed" filter is intentional: an uninstalled assignment doesn't
 * appear here even if it has historical reflections, since reaching it from
 * the dashboard would be confusing. We can revisit if teachers want a
 * history view of removed assignments.
 */
export async function loadReviewsIndex(
  teacherId: string,
): Promise<ReviewIndexEntry[]> {
  const admin = createAdminDbClient();

  const [
    { data: teacherAssignments },
    { data: installs },
    { data: courses },
    { data: assignments },
    { data: sessions },
  ] = await Promise.all([
    admin
      .from("teacher_assignments")
      .select("id, canvas_course_id, canvas_assignment_id")
      .eq("teacher_id", teacherId),
    admin
      .from("assignment_install_state")
      .select("canvas_course_id, canvas_assignment_id, status")
      .eq("teacher_id", teacherId)
      .eq("status", "installed"),
    admin
      .from("canvas_course_cache")
      .select("canvas_course_id, name, course_code, term_name")
      .eq("teacher_id", teacherId),
    admin
      .from("canvas_assignment_cache")
      .select("canvas_assignment_id, canvas_course_id, name, due_at")
      .eq("teacher_id", teacherId),
    // Sessions across all of this teacher's assignments. Filter to the
    // teacher's teacher_assignment ids client-side after grouping; supabase
    // doesn't support a server-side filter that joins on teacher_id without
    // a view.
    (async () => {
      const tas = await admin
        .from("teacher_assignments")
        .select("id")
        .eq("teacher_id", teacherId);
      const ids = (tas.data ?? []).map((t) => t.id);
      if (ids.length === 0) return { data: [] };
      return admin
        .from("reflection_sessions")
        .select("teacher_assignment_id, state")
        .in("teacher_assignment_id", ids);
    })(),
  ]);

  const installedSet = new Set(
    (installs ?? []).map(
      (i) => `${i.canvas_course_id}::${i.canvas_assignment_id}`,
    ),
  );

  const taIndex = new Map<string, { courseId: string; assignmentId: string }>(
    (teacherAssignments ?? []).map((t) => [
      t.id,
      {
        courseId: t.canvas_course_id,
        assignmentId: t.canvas_assignment_id,
      },
    ]),
  );

  const courseByCanvasId = new Map(
    (courses ?? []).map((c) => [c.canvas_course_id, c]),
  );
  const assignmentByKey = new Map(
    (assignments ?? []).map((a) => [
      `${a.canvas_course_id}::${a.canvas_assignment_id}`,
      a,
    ]),
  );

  // Tally session counts per (course, assignment) by following the
  // teacher_assignment_id back through taIndex.
  type Counts = {
    total: number;
    submitted: number;
    failed: number;
    inProgress: number;
  };
  const countsByKey = new Map<string, Counts>();
  for (const s of sessions ?? []) {
    const ta = taIndex.get(s.teacher_assignment_id);
    if (!ta) continue;
    const key = `${ta.courseId}::${ta.assignmentId}`;
    const existing = countsByKey.get(key) ?? {
      total: 0,
      submitted: 0,
      failed: 0,
      inProgress: 0,
    };
    existing.total += 1;
    if (s.state === "submitted") existing.submitted += 1;
    else if (s.state === "failed") existing.failed += 1;
    else if (s.state === "in_progress" || s.state === "started")
      existing.inProgress += 1;
    countsByKey.set(key, existing);
  }

  const entries: ReviewIndexEntry[] = [];
  for (const ta of teacherAssignments ?? []) {
    const key = `${ta.canvas_course_id}::${ta.canvas_assignment_id}`;
    if (!installedSet.has(key)) continue;
    const counts = countsByKey.get(key) ?? {
      total: 0,
      submitted: 0,
      failed: 0,
      inProgress: 0,
    };
    if (counts.total === 0) continue; // skip assignments no student has touched yet
    const course = courseByCanvasId.get(ta.canvas_course_id);
    const assignment = assignmentByKey.get(key);
    entries.push({
      canvasCourseId: ta.canvas_course_id,
      courseName: course?.name ?? null,
      courseCode: course?.course_code ?? null,
      termName: course?.term_name ?? null,
      canvasAssignmentId: ta.canvas_assignment_id,
      assignmentName: assignment?.name ?? null,
      dueAt: assignment?.due_at ?? null,
      totalReflections: counts.total,
      submittedCount: counts.submitted,
      failedCount: counts.failed,
      inProgressCount: counts.inProgress,
    });
  }

  // Sort: due-soonest first, no-due-date last, then alphabetical.
  return entries.sort((a, b) => {
    const aDue = a.dueAt ? Date.parse(a.dueAt) : Number.POSITIVE_INFINITY;
    const bDue = b.dueAt ? Date.parse(b.dueAt) : Number.POSITIVE_INFINITY;
    if (aDue !== bDue) return bDue - aDue; // most recent dues first
    return (a.assignmentName ?? "").localeCompare(b.assignmentName ?? "");
  });
}

/**
 * Look up reflection counts grouped by canvas_assignment_id for a single
 * teacher. Used by the dashboard accordion to render "View N reflections"
 * links inline without re-querying per row.
 */
export async function loadReflectionCountsByAssignment(
  teacherId: string,
): Promise<Map<string, number>> {
  const admin = createAdminDbClient();
  const { data: tas } = await admin
    .from("teacher_assignments")
    .select("id, canvas_assignment_id")
    .eq("teacher_id", teacherId);

  const ids = (tas ?? []).map((t) => t.id);
  if (ids.length === 0) return new Map();

  const taIdToAssignment = new Map<string, string>(
    (tas ?? []).map((t) => [t.id, t.canvas_assignment_id]),
  );

  const { data: sessions } = await admin
    .from("reflection_sessions")
    .select("teacher_assignment_id")
    .in("teacher_assignment_id", ids);

  const counts = new Map<string, number>();
  for (const s of sessions ?? []) {
    const aid = taIdToAssignment.get(s.teacher_assignment_id);
    if (!aid) continue;
    counts.set(aid, (counts.get(aid) ?? 0) + 1);
  }
  return counts;
}
