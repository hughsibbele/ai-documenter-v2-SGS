import "server-only";

import {
  CanvasError,
  listCourseStudents,
  type CanvasConfig,
} from "@ai-documenter/canvas";
import { decryptSecret, readKeyFromEnv } from "@ai-documenter/crypto";
import { createAdminDbClient } from "@ai-documenter/db/admin";

export type RosterStudent = {
  canvas_user_id: string;
  name: string;
  email: string | null;
};

export type RosterSyncResult =
  | {
      ok: true;
      teacherId: string;
      coursesSynced: number;
      totalStudents: number;
      failures: { canvasCourseId: string; error: string }[];
    }
  | { ok: false; teacherId: string; error: string };

/**
 * Pull Canvas rosters for every active-term course this teacher owns and
 * upsert into `course_rosters`. Called from the nightly cron after the
 * assignment-cache refresh, so it benefits from the same Canvas latency
 * bucket without doubling the rate-limit pressure on a single API token.
 *
 * Each per-course pull is wrapped in try/catch so one bad course (deleted
 * in Canvas mid-sync, permission glitch, etc.) doesn't fail the whole pass.
 */
export async function syncTeacherRosters(
  teacherId: string,
): Promise<RosterSyncResult> {
  const admin = createAdminDbClient();

  const { data: teacher } = await admin
    .from("teachers")
    .select("id, canvas_host, canvas_token_encrypted")
    .eq("id", teacherId)
    .maybeSingle();
  if (!teacher) {
    return { ok: false, teacherId, error: "teacher not found" };
  }
  if (!teacher.canvas_host || !teacher.canvas_token_encrypted) {
    return { ok: false, teacherId, error: "Canvas not connected" };
  }

  let token: string;
  try {
    token = decryptSecret(teacher.canvas_token_encrypted, readKeyFromEnv());
  } catch (err) {
    return {
      ok: false,
      teacherId,
      error: `Token decrypt failed: ${(err as Error).message}`,
    };
  }
  const config: CanvasConfig = { host: teacher.canvas_host, token };

  // Roster sync rides on the assignment cache — only courses that are in
  // the active-term cache. Old courses don't need a fresh roster.
  const { data: courses } = await admin
    .from("canvas_course_cache")
    .select("canvas_course_id")
    .eq("teacher_id", teacherId);
  if (!courses || courses.length === 0) {
    return {
      ok: true,
      teacherId,
      coursesSynced: 0,
      totalStudents: 0,
      failures: [],
    };
  }

  const failures: { canvasCourseId: string; error: string }[] = [];
  let totalStudents = 0;
  let coursesSynced = 0;

  for (const c of courses) {
    try {
      const users = await listCourseStudents(config, c.canvas_course_id);
      const students: RosterStudent[] = users.map((u) => ({
        canvas_user_id: String(u.id),
        name: u.name,
        email: u.primary_email ?? u.login_id ?? null,
      }));
      const { error } = await admin
        .from("course_rosters")
        .upsert(
          {
            teacher_id: teacherId,
            canvas_course_id: c.canvas_course_id,
            students: students as unknown as never,
            last_synced_at: new Date().toISOString(),
          },
          { onConflict: "teacher_id,canvas_course_id" },
        );
      if (error) {
        failures.push({
          canvasCourseId: c.canvas_course_id,
          error: error.message,
        });
        continue;
      }
      coursesSynced += 1;
      totalStudents += students.length;
    } catch (err) {
      failures.push({
        canvasCourseId: c.canvas_course_id,
        error:
          err instanceof CanvasError
            ? `Canvas ${err.status}: ${err.message}`
            : (err as Error).message,
      });
    }
  }

  return { ok: true, teacherId, coursesSynced, totalStudents, failures };
}
