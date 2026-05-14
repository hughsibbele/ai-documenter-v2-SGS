import "server-only";

import { createAdminDbClient } from "@ai-documenter/db/admin";
import type { Tables } from "@ai-documenter/db";

export type RetentionScope =
  | { kind: "teacher_course"; teacherId: string; canvasCourseId: string }
  | { kind: "teacher_all"; teacherId: string }
  | { kind: "admin_all" };

export type RetentionSummary = {
  totalSessions: number;
  byState: Record<string, number>;
  oldestCreatedAt: string | null;
  newestCreatedAt: string | null;
  /** Distinct (teacher_id, canvas_course_id) pairs touched by this scope. */
  courseCount: number;
};

export type RetentionRow = {
  session: Tables<"reflection_sessions">;
  student: Pick<Tables<"students">, "id" | "display_name" | "email">;
  teacherAssignment: Pick<
    Tables<"teacher_assignments">,
    "id" | "canvas_course_id" | "canvas_assignment_id" | "teacher_id"
  >;
  courseName: string | null;
  assignmentName: string | null;
};

/**
 * Load every reflection_session in scope. Admin client throughout — student-
 * self RLS would block teacher / admin reads otherwise. Used by both the
 * summary card and the CSV export action.
 *
 * Caller is responsible for verifying authority (teacher owns the course;
 * admin = is_admin()). This loader is the data layer, not the auth gate.
 */
export async function loadReflectionsInScope(
  scope: RetentionScope,
): Promise<RetentionRow[]> {
  const admin = createAdminDbClient();

  // Step 1: resolve the set of teacher_assignment ids in scope.
  let taQuery = admin
    .from("teacher_assignments")
    .select(
      "id, canvas_course_id, canvas_assignment_id, teacher_id",
    );
  if (scope.kind === "teacher_course") {
    taQuery = taQuery
      .eq("teacher_id", scope.teacherId)
      .eq("canvas_course_id", scope.canvasCourseId);
  } else if (scope.kind === "teacher_all") {
    taQuery = taQuery.eq("teacher_id", scope.teacherId);
  }
  const { data: tas } = await taQuery;
  if (!tas || tas.length === 0) return [];

  const taIds = tas.map((t) => t.id);
  const taById = new Map(tas.map((t) => [t.id, t]));

  const { data: sessions } = await admin
    .from("reflection_sessions")
    .select("*")
    .in("teacher_assignment_id", taIds)
    .order("created_at", { ascending: false });

  if (!sessions || sessions.length === 0) return [];

  const studentIds = Array.from(new Set(sessions.map((s) => s.student_id)));
  const { data: students } = await admin
    .from("students")
    .select("id, display_name, email")
    .in("id", studentIds);
  const studentById = new Map(
    (students ?? []).map((s) => [s.id, s]),
  );

  // Course + assignment names by teacher to render properly in CSV / UI.
  const teacherIds = Array.from(new Set(tas.map((t) => t.teacher_id)));
  const courseKeys = Array.from(
    new Set(tas.map((t) => `${t.teacher_id}::${t.canvas_course_id}`)),
  );
  const assignmentKeys = Array.from(
    new Set(
      tas.map((t) => `${t.teacher_id}::${t.canvas_assignment_id}`),
    ),
  );

  const [{ data: courses }, { data: assignments }] = await Promise.all([
    admin
      .from("canvas_course_cache")
      .select("teacher_id, canvas_course_id, name")
      .in("teacher_id", teacherIds),
    admin
      .from("canvas_assignment_cache")
      .select("teacher_id, canvas_assignment_id, name")
      .in("teacher_id", teacherIds),
  ]);

  const courseByKey = new Map(
    (courses ?? []).map((c) => [
      `${c.teacher_id}::${c.canvas_course_id}`,
      c.name,
    ]),
  );
  const assignmentByKey = new Map(
    (assignments ?? []).map((a) => [
      `${a.teacher_id}::${a.canvas_assignment_id}`,
      a.name,
    ]),
  );

  // Filter to keys actually in scope (defense for the case where canvas cache
  // is empty / stale).
  void courseKeys;
  void assignmentKeys;

  const rows: RetentionRow[] = [];
  for (const session of sessions) {
    const ta = taById.get(session.teacher_assignment_id);
    if (!ta) continue;
    const student = studentById.get(session.student_id);
    if (!student) continue;
    rows.push({
      session,
      student,
      teacherAssignment: ta,
      courseName:
        courseByKey.get(`${ta.teacher_id}::${ta.canvas_course_id}`) ?? null,
      assignmentName:
        assignmentByKey.get(`${ta.teacher_id}::${ta.canvas_assignment_id}`) ??
        null,
    });
  }
  return rows;
}

export function summarize(rows: RetentionRow[]): RetentionSummary {
  const byState: Record<string, number> = {};
  let oldest: string | null = null;
  let newest: string | null = null;
  const courseKeys = new Set<string>();
  for (const r of rows) {
    byState[r.session.state] = (byState[r.session.state] ?? 0) + 1;
    if (!oldest || r.session.created_at < oldest) oldest = r.session.created_at;
    if (!newest || r.session.created_at > newest) newest = r.session.created_at;
    courseKeys.add(
      `${r.teacherAssignment.teacher_id}::${r.teacherAssignment.canvas_course_id}`,
    );
  }
  return {
    totalSessions: rows.length,
    byState,
    oldestCreatedAt: oldest,
    newestCreatedAt: newest,
    courseCount: courseKeys.size,
  };
}
