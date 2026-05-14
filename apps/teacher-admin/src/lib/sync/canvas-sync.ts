import "server-only";
import {
  CanvasError,
  type CanvasAssignment,
  type CanvasConfig,
  type CanvasCourse,
  listCourseAssignments,
  listTeachingCourses,
} from "@ai-documenter/canvas";
import { decryptSecret, readKeyFromEnv } from "@ai-documenter/crypto";
import type { TablesInsert } from "@ai-documenter/db";
import { createAdminDbClient } from "@ai-documenter/db/admin";
import { isActiveTerm } from "./active-term";

// Pulls the teacher's courses + assignments from Canvas and upserts them into
// the cache tables. Pure utility — used by the on-demand "Refresh" server
// action AND by the nightly cron.
//
// Always uses the service-role admin client because:
// (a) the cron has no user session,
// (b) the cache tables only have SELECT policies for user context — writes
//     go through service role by design.

export type SyncResult =
  | {
      ok: true;
      teacherId: string;
      courseCount: number;
      assignmentCount: number;
      durationMs: number;
    }
  | {
      ok: false;
      teacherId: string;
      message: string;
      durationMs: number;
    };

export async function syncTeacherCanvasData(
  teacherId: string,
): Promise<SyncResult> {
  const start = Date.now();
  const admin = createAdminDbClient();

  const { data: teacher, error: tErr } = await admin
    .from("teachers")
    .select("id, canvas_host, canvas_token_encrypted")
    .eq("id", teacherId)
    .maybeSingle();

  if (tErr || !teacher) {
    return {
      ok: false,
      teacherId,
      message: tErr?.message ?? "teacher not found",
      durationMs: Date.now() - start,
    };
  }
  if (!teacher.canvas_host || !teacher.canvas_token_encrypted) {
    return {
      ok: false,
      teacherId,
      message: "Canvas not connected for this teacher",
      durationMs: Date.now() - start,
    };
  }

  let token: string;
  try {
    token = decryptSecret(teacher.canvas_token_encrypted, readKeyFromEnv());
  } catch (err) {
    return {
      ok: false,
      teacherId,
      message: `Token decrypt failed: ${(err as Error).message}`,
      durationMs: Date.now() - start,
    };
  }

  const config: CanvasConfig = { host: teacher.canvas_host, token };

  let courses: CanvasCourse[];
  try {
    courses = await listTeachingCourses(config);
  } catch (err) {
    return {
      ok: false,
      teacherId,
      message:
        err instanceof CanvasError
          ? err.message
          : `Canvas listTeachingCourses failed: ${(err as Error).message}`,
      durationMs: Date.now() - start,
    };
  }

  // Only pull assignments for courses in the active academic-year term.
  // Older courses still get cached (so we can list them in the "Other terms"
  // section) but their assignment data isn't refreshed — typical EHS teachers
  // have ~7 active-term courses out of ~70 lifetime courses, so this cuts
  // sync time roughly 10x.
  const activeCourses = courses.filter((c) => isActiveTerm(c.term?.name ?? null));
  const assignmentsByCourse = await mapWithConcurrency(
    activeCourses,
    4,
    async (course) => {
      try {
        const list = await listCourseAssignments(config, course.id, {
          includeUnpublished: true,
        });
        return { courseId: course.id, list };
      } catch {
        return { courseId: course.id, list: [] as CanvasAssignment[] };
      }
    },
  );

  const courseRows: TablesInsert<"canvas_course_cache">[] = courses.map(
    (c) => ({
      teacher_id: teacherId,
      canvas_course_id: String(c.id),
      name: c.name,
      course_code: c.course_code ?? null,
      workflow_state: c.workflow_state,
      start_at: c.start_at ?? null,
      end_at: c.end_at ?? null,
      term_name: c.term?.name ?? null,
      term_start_at: c.term?.start_at ?? null,
      term_end_at: c.term?.end_at ?? null,
      last_synced_at: new Date().toISOString(),
    }),
  );

  const assignmentRows: TablesInsert<"canvas_assignment_cache">[] =
    assignmentsByCourse.flatMap(({ courseId, list }) =>
      list.map((a) => ({
        teacher_id: teacherId,
        canvas_course_id: String(courseId),
        canvas_assignment_id: String(a.id),
        name: a.name,
        description: a.description ?? null,
        due_at: a.due_at ?? null,
        points_possible: a.points_possible ?? null,
        workflow_state: a.workflow_state,
        published: a.published ?? null,
        last_synced_at: new Date().toISOString(),
      })),
    );

  // Upsert (INSERT ... ON CONFLICT DO UPDATE).
  if (courseRows.length > 0) {
    const { error } = await admin
      .from("canvas_course_cache")
      .upsert(courseRows, {
        onConflict: "teacher_id,canvas_course_id",
      });
    if (error) {
      return {
        ok: false,
        teacherId,
        message: `Course upsert failed: ${error.message}`,
        durationMs: Date.now() - start,
      };
    }
  }

  if (assignmentRows.length > 0) {
    const { error } = await admin
      .from("canvas_assignment_cache")
      .upsert(assignmentRows, {
        onConflict: "teacher_id,canvas_assignment_id",
      });
    if (error) {
      return {
        ok: false,
        teacherId,
        message: `Assignment upsert failed: ${error.message}`,
        durationMs: Date.now() - start,
      };
    }
  }

  // Delete cache rows that no longer exist in Canvas (course or assignment
  // was removed). Match on this teacher only.
  const liveCourseIds = new Set(courseRows.map((r) => r.canvas_course_id));
  const liveAssignmentIds = new Set(
    assignmentRows.map((r) => r.canvas_assignment_id),
  );

  await pruneStaleCourses(admin, teacherId, liveCourseIds);
  await pruneStaleAssignments(admin, teacherId, liveAssignmentIds);

  await admin
    .from("teachers")
    .update({ last_canvas_sync_at: new Date().toISOString() })
    .eq("id", teacherId);

  return {
    ok: true,
    teacherId,
    courseCount: courseRows.length,
    assignmentCount: assignmentRows.length,
    durationMs: Date.now() - start,
  };
}

async function mapWithConcurrency<T, U>(
  items: T[],
  limit: number,
  fn: (t: T) => Promise<U>,
): Promise<U[]> {
  const out: U[] = new Array(items.length);
  let i = 0;
  async function worker() {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      out[idx] = await fn(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

type AdminClient = ReturnType<typeof createAdminDbClient>;

// Cap IN-list length so the encoded URL doesn't blow past server limits.
// Postgres itself handles much larger lists fine; this is defense for the
// supabase-js HTTP layer.
const PRUNE_BATCH = 500;

async function pruneStaleCourses(
  admin: AdminClient,
  teacherId: string,
  liveIds: Set<string>,
): Promise<void> {
  const { data } = await admin
    .from("canvas_course_cache")
    .select("canvas_course_id")
    .eq("teacher_id", teacherId);
  if (!data) return;
  const stale = data
    .map((r) => r.canvas_course_id)
    .filter((id) => !liveIds.has(id));
  for (let i = 0; i < stale.length; i += PRUNE_BATCH) {
    const chunk = stale.slice(i, i + PRUNE_BATCH);
    await admin
      .from("canvas_course_cache")
      .delete()
      .eq("teacher_id", teacherId)
      .in("canvas_course_id", chunk);
  }
}

async function pruneStaleAssignments(
  admin: AdminClient,
  teacherId: string,
  liveIds: Set<string>,
): Promise<void> {
  const { data } = await admin
    .from("canvas_assignment_cache")
    .select("canvas_assignment_id")
    .eq("teacher_id", teacherId);
  if (!data) return;
  const stale = data
    .map((r) => r.canvas_assignment_id)
    .filter((id) => !liveIds.has(id));
  for (let i = 0; i < stale.length; i += PRUNE_BATCH) {
    const chunk = stale.slice(i, i + PRUNE_BATCH);
    await admin
      .from("canvas_assignment_cache")
      .delete()
      .eq("teacher_id", teacherId)
      .in("canvas_assignment_id", chunk);
  }
}
