import "server-only";

import { randomUUID } from "node:crypto";
import {
  CanvasError,
  buildReflectionBlock,
  getAssignment,
  replaceOrAppendReflectionBlock,
  updateAssignmentDescription,
  type CanvasConfig,
} from "@ai-documenter/canvas";
import { decryptSecret, readKeyFromEnv } from "@ai-documenter/crypto";
import { createAdminDbClient } from "@ai-documenter/db/admin";
import { resolveCardTextForTeacher } from "@/lib/card-text/resolve";

type AdminClient = ReturnType<typeof createAdminDbClient>;

export type AutoInstallSweepResult =
  | {
      ok: true;
      teacherId: string;
      coursesScanned: number;
      installed: { canvasCourseId: string; canvasAssignmentId: string }[];
      failures: {
        canvasCourseId: string;
        canvasAssignmentId: string;
        error: string;
      }[];
    }
  | { ok: false; teacherId: string; error: string };

/**
 * Sweep one teacher for newly-encountered published assignments in courses
 * with `auto_install_new_assignments = true`, and install the reflection
 * card on each.
 *
 * Runs after `syncTeacherCanvasData` has refreshed the assignment cache, so
 * "new" here means: present in `canvas_assignment_cache`, published, and
 * has no `assignment_install_state` row OR has status='uninstalled'.
 *
 * Uses the service-role admin client end-to-end — the cron has no user
 * session, and the writes (teacher_assignments + assignment_install_state)
 * are intentionally service-role-owned in this codebase.
 */
export async function autoInstallNewAssignmentsForTeacher(
  teacherId: string,
  appBaseUrl: string,
): Promise<AutoInstallSweepResult> {
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

  const { data: policies } = await admin
    .from("course_install_policies")
    .select(
      "canvas_course_id, default_prompt_id, auto_install_new_assignments, auto_install_enabled_at",
    )
    .eq("teacher_id", teacherId)
    .eq("auto_install_new_assignments", true);

  if (!policies || policies.length === 0) {
    return {
      ok: true,
      teacherId,
      coursesScanned: 0,
      installed: [],
      failures: [],
    };
  }

  const installed: { canvasCourseId: string; canvasAssignmentId: string }[] = [];
  const failures: {
    canvasCourseId: string;
    canvasAssignmentId: string;
    error: string;
  }[] = [];

  for (const policy of policies) {
    // Belt-and-suspenders: without an enabled_at timestamp we can't tell
    // "new" from "pre-existing," so refuse to install anything. The
    // setCourseAutoInstall action always sets enabled_at on the off→on flip,
    // so a null here means an in-flight schema state (e.g. the migration
    // ran but a stale policy row hasn't been touched yet).
    if (!policy.auto_install_enabled_at) continue;

    // Eligible = published AND first cached AFTER auto-install was enabled.
    // Anything that was already in our cache when the teacher flipped the
    // toggle is a pre-existing assignment and stays untouched. This is the
    // semantics fix for "auto-install installed on every assignment" — the
    // prior code skipped only on install_state existence, which fired on
    // pristine courses with no prior installs.
    const { data: assignments } = await admin
      .from("canvas_assignment_cache")
      .select("canvas_assignment_id, published, workflow_state, first_seen_at")
      .eq("teacher_id", teacherId)
      .eq("canvas_course_id", policy.canvas_course_id)
      .gt("first_seen_at", policy.auto_install_enabled_at);

    const publishedAssignmentIds = (assignments ?? [])
      .filter(
        (a) => a.published === true && a.workflow_state === "published",
      )
      .map((a) => a.canvas_assignment_id);

    if (publishedAssignmentIds.length === 0) continue;

    // Within the post-enable set, also skip anything the teacher has
    // explicitly touched (installed manually + later uninstalled, or a
    // previous auto-install). install_state row existence = "stop being
    // helpful, the teacher has an opinion about this one already."
    const { data: existingStates } = await admin
      .from("assignment_install_state")
      .select("canvas_assignment_id, status")
      .eq("teacher_id", teacherId)
      .eq("canvas_course_id", policy.canvas_course_id)
      .in("canvas_assignment_id", publishedAssignmentIds);

    const seenAssignmentIds = new Set(
      (existingStates ?? []).map((s) => s.canvas_assignment_id),
    );
    const newAssignmentIds = publishedAssignmentIds.filter(
      (id) => !seenAssignmentIds.has(id),
    );

    if (newAssignmentIds.length === 0) continue;

    for (const aid of newAssignmentIds) {
      try {
        await installReflectionCardServiceRole(
          admin,
          config,
          teacherId,
          policy.canvas_course_id,
          aid,
          policy.default_prompt_id,
          appBaseUrl,
        );
        installed.push({
          canvasCourseId: policy.canvas_course_id,
          canvasAssignmentId: aid,
        });
      } catch (err) {
        failures.push({
          canvasCourseId: policy.canvas_course_id,
          canvasAssignmentId: aid,
          error:
            err instanceof CanvasError
              ? `Canvas ${err.status}: ${err.message}`
              : (err as Error).message,
        });
      }
    }
  }

  return {
    ok: true,
    teacherId,
    coursesScanned: policies.length,
    installed,
    failures,
  };
}

/**
 * Same logic as `installOne` in `canvas-install.ts`, but with no
 * `getCurrentTeacher` dependency — the cron has no user session. Kept
 * separate to avoid passing the admin client through a public action.
 */
async function installReflectionCardServiceRole(
  admin: AdminClient,
  config: CanvasConfig,
  teacherId: string,
  canvasCourseId: string,
  canvasAssignmentId: string,
  promptId: string,
  appBaseUrl: string,
): Promise<void> {
  // teacher_assignments — keep iframe_token stable across reinstalls.
  let iframeToken: string;
  const { data: existing } = await admin
    .from("teacher_assignments")
    .select("id, iframe_token")
    .eq("teacher_id", teacherId)
    .eq("canvas_assignment_id", canvasAssignmentId)
    .maybeSingle();

  if (existing) {
    iframeToken = existing.iframe_token;
    if (promptId) {
      await admin
        .from("teacher_assignments")
        .update({ prompt_id: promptId })
        .eq("id", existing.id);
    }
  } else {
    iframeToken = randomUUID().replaceAll("-", "");
    const { error } = await admin.from("teacher_assignments").insert({
      teacher_id: teacherId,
      canvas_course_id: canvasCourseId,
      canvas_assignment_id: canvasAssignmentId,
      prompt_id: promptId,
      iframe_token: iframeToken,
    });
    if (error) throw new Error(error.message);
  }

  // Splice the reflection card into the Canvas description. M6.15b: resolve
  // effective per-teacher card text so an auto-install picks up the same
  // overrides a manual install would.
  const assignment = await getAssignment(
    config,
    canvasCourseId,
    canvasAssignmentId,
  );
  const existingDescription = assignment.description ?? "";
  const cardText = await resolveCardTextForTeacher(teacherId);
  const block = buildReflectionBlock({
    appBaseUrl,
    iframeToken,
    promptVersion: 1,
    text: cardText,
  });
  const newDescription = replaceOrAppendReflectionBlock(
    existingDescription,
    block,
    iframeToken,
  );
  if (newDescription !== existingDescription) {
    await updateAssignmentDescription(
      config,
      canvasCourseId,
      canvasAssignmentId,
      newDescription,
    );
  }

  await admin
    .from("assignment_install_state")
    .upsert(
      {
        teacher_id: teacherId,
        canvas_course_id: canvasCourseId,
        canvas_assignment_id: canvasAssignmentId,
        status: "installed",
        iframe_token: iframeToken,
        installed_at: new Date().toISOString(),
        uninstalled_at: null,
        last_error: null,
      },
      { onConflict: "teacher_id,canvas_assignment_id" },
    );
}
