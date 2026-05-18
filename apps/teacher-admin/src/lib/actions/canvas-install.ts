"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import {
  CanvasError,
  buildReflectionBlock,
  getAssignment,
  removeReflectionBlock,
  replaceOrAppendReflectionBlock,
  updateAssignmentDescription,
  type CanvasConfig,
} from "@ai-documenter/canvas";
import { decryptSecret, readKeyFromEnv } from "@ai-documenter/crypto";
import { createAdminDbClient } from "@ai-documenter/db/admin";
import type { Tables } from "@ai-documenter/db";
import { getCurrentTeacher } from "@/lib/auth/teacher";
import type {
  AssignmentResult,
  InstallActionResult,
} from "./canvas-install.types";

type AdminClient = ReturnType<typeof createAdminDbClient>;
type Prompt = Tables<"prompts">;
type Policy = Tables<"course_install_policies">;
type TeacherAssignment = Tables<"teacher_assignments">;

export async function installOnAssignments(
  canvasCourseId: string,
  canvasAssignmentIds: string[],
  promptId: string,
  useSubmissionBody: boolean,
): Promise<InstallActionResult> {
  return runForAssignments(
    canvasCourseId,
    canvasAssignmentIds,
    "install",
    promptId,
    useSubmissionBody,
  );
}

export async function uninstallFromAssignments(
  canvasCourseId: string,
  canvasAssignmentIds: string[],
): Promise<InstallActionResult> {
  return runForAssignments(
    canvasCourseId,
    canvasAssignmentIds,
    "uninstall",
    null,
    false,
  );
}

async function runForAssignments(
  canvasCourseId: string,
  canvasAssignmentIds: string[],
  op: "install" | "uninstall",
  promptId: string | null,
  useSubmissionBody: boolean,
): Promise<InstallActionResult> {
  const teacher = await getCurrentTeacher();
  if (!teacher.canvas_host || !teacher.canvas_token_encrypted) {
    return failAll(canvasAssignmentIds, "Canvas not connected");
  }

  let token: string;
  try {
    token = decryptSecret(teacher.canvas_token_encrypted, readKeyFromEnv());
  } catch (err) {
    return failAll(canvasAssignmentIds, `Token decrypt failed: ${(err as Error).message}`);
  }

  const config: CanvasConfig = { host: teacher.canvas_host, token };
  const admin = createAdminDbClient();

  let prompt: Prompt | null = null;
  if (op === "install") {
    if (!promptId) {
      return failAll(canvasAssignmentIds, "No prompt selected");
    }
    prompt = await loadPrompt(admin, teacher.id, promptId);
    if (!prompt) {
      return failAll(canvasAssignmentIds, "Prompt not found or not yours");
    }
  }

  // `NEXT_PUBLIC_APP_URL` is the app origin where the standalone reflection
  // lives (and now everything else — pre-M1 there were two apps; post-merge
  // there's just one).
  const appBaseUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (op === "install" && !appBaseUrl) {
    return failAll(
      canvasAssignmentIds,
      "NEXT_PUBLIC_APP_URL is not set; cannot build reflection URL",
    );
  }

  // Ensure a course policy exists (uses the chosen prompt as the course
  // default if no policy was set yet — auto-install will pick this up later).
  if (op === "install" && prompt) {
    await ensurePolicy(admin, teacher.id, canvasCourseId, prompt.id);
  }

  // Sequential rather than parallel: Canvas dislikes burst writes from a
  // single token, and per-assignment latency is small.
  const results: AssignmentResult[] = [];
  for (const aid of canvasAssignmentIds) {
    try {
      const r =
        op === "install"
          ? await installOne(
              admin,
              config,
              teacher.id,
              canvasCourseId,
              aid,
              prompt!,
              appBaseUrl!,
              useSubmissionBody,
            )
          : await uninstallOne(admin, config, teacher.id, canvasCourseId, aid);
      results.push(r);
    } catch (err) {
      results.push({
        canvasAssignmentId: aid,
        ok: false,
        status: "failed",
        message:
          err instanceof CanvasError
            ? err.message
            : (err as Error).message,
      });
    }
  }

  revalidatePath("/dashboard");

  return {
    results,
    successCount: results.filter((r) => r.ok).length,
    failureCount: results.filter((r) => !r.ok).length,
  };
}

async function installOne(
  admin: AdminClient,
  config: CanvasConfig,
  teacherId: string,
  canvasCourseId: string,
  canvasAssignmentId: string,
  prompt: Prompt,
  appBaseUrl: string,
  useSubmissionBody: boolean,
): Promise<AssignmentResult> {
  // 1. teacher_assignments row (one per Canvas assignment) — keeps the
  //    iframe_token stable across re-installs. Updates prompt_id and
  //    use_submission_body to reflect the teacher's latest choices.
  const ta = await ensureTeacherAssignment(
    admin,
    teacherId,
    canvasCourseId,
    canvasAssignmentId,
    prompt.id,
    useSubmissionBody,
  );

  // 2. Read current description from Canvas.
  const assignment = await getAssignment(config, canvasCourseId, canvasAssignmentId);
  const existing = assignment.description ?? "";

  // 3. Build the marker-wrapped EHS card. The student app reads the prompt
  //    body live via teacher_assignments.prompt_id → prompts.body; the marker
  //    only needs to carry our identity (iframe-token) and a schema version.
  //    The block builder constructs both the CTA href (/r/<token>) and the
  //    logo img src (/brand/ehs-horizontal.webp) from the app origin.
  const block = buildReflectionBlock({
    appBaseUrl,
    iframeToken: ta.iframe_token,
    promptVersion: 1,
  });

  // 4. Splice into the existing description and PUT — but skip the PUT if
  //    the resulting HTML is identical (re-install with the same prompt is a
  //    no-op). The token-aware variant of replaceOrAppendReflectionBlock
  //    recognizes our existing block via marker comments, falls back to a
  //    bare card by token, and ALSO catches pre-M2 legacy iframe blocks for
  //    reinstall-time cleanup. End state: exactly one card in the description.
  const newDescription = replaceOrAppendReflectionBlock(
    existing,
    block,
    ta.iframe_token,
  );
  if (newDescription !== existing) {
    await updateAssignmentDescription(
      config,
      canvasCourseId,
      canvasAssignmentId,
      newDescription,
    );
  }

  // 5. Mark installed in our DB.
  await admin
    .from("assignment_install_state")
    .upsert(
      {
        teacher_id: teacherId,
        canvas_course_id: canvasCourseId,
        canvas_assignment_id: canvasAssignmentId,
        status: "installed",
        iframe_token: ta.iframe_token,
        installed_at: new Date().toISOString(),
        uninstalled_at: null,
        last_error: null,
      },
      { onConflict: "teacher_id,canvas_assignment_id" },
    );

  return {
    canvasAssignmentId,
    ok: true,
    status: "installed",
  };
}

async function uninstallOne(
  admin: AdminClient,
  config: CanvasConfig,
  teacherId: string,
  canvasCourseId: string,
  canvasAssignmentId: string,
): Promise<AssignmentResult> {
  // Look up the iframe_token so we can also catch comment-stripped iframes
  // that no longer carry our marker comments. If no row exists, fall back to
  // marker-only detection.
  const { data: ta } = await admin
    .from("teacher_assignments")
    .select("iframe_token")
    .eq("teacher_id", teacherId)
    .eq("canvas_assignment_id", canvasAssignmentId)
    .maybeSingle();

  const assignment = await getAssignment(config, canvasCourseId, canvasAssignmentId);
  const existing = assignment.description ?? "";
  const cleaned = removeReflectionBlock(existing, ta?.iframe_token);
  if (cleaned !== existing) {
    await updateAssignmentDescription(
      config,
      canvasCourseId,
      canvasAssignmentId,
      cleaned,
    );
  }

  await admin
    .from("assignment_install_state")
    .upsert(
      {
        teacher_id: teacherId,
        canvas_course_id: canvasCourseId,
        canvas_assignment_id: canvasAssignmentId,
        status: "uninstalled",
        uninstalled_at: new Date().toISOString(),
        last_error: null,
      },
      { onConflict: "teacher_id,canvas_assignment_id" },
    );

  return {
    canvasAssignmentId,
    ok: true,
    status: "uninstalled",
  };
}

async function loadPrompt(
  admin: AdminClient,
  teacherId: string,
  promptId: string,
): Promise<Prompt | null> {
  const { data } = await admin
    .from("prompts")
    .select("*")
    .eq("id", promptId)
    .maybeSingle();
  if (!data) return null;
  // System prompts (teacher_id IS NULL) are shared across all teachers;
  // teacher-scoped prompts must belong to the calling teacher. Only
  // reflection-purpose prompts are installable — objective_summary lives
  // in the same table but is admin infrastructure.
  if (data.purpose !== "reflection") return null;
  if (data.scope === "system") return data;
  if (data.scope === "teacher" && data.teacher_id === teacherId) return data;
  return null;
}

async function ensurePolicy(
  admin: AdminClient,
  teacherId: string,
  canvasCourseId: string,
  defaultPromptId: string,
): Promise<Policy> {
  const { data: existing } = await admin
    .from("course_install_policies")
    .select("*")
    .eq("teacher_id", teacherId)
    .eq("canvas_course_id", canvasCourseId)
    .maybeSingle();

  if (existing) return existing;

  const { data: created, error } = await admin
    .from("course_install_policies")
    .insert({
      teacher_id: teacherId,
      canvas_course_id: canvasCourseId,
      default_prompt_id: defaultPromptId,
    })
    .select("*")
    .single();

  if (error || !created) {
    throw new Error(`Couldn't create course policy: ${error?.message ?? "unknown"}`);
  }
  return created;
}

async function ensureTeacherAssignment(
  admin: AdminClient,
  teacherId: string,
  canvasCourseId: string,
  canvasAssignmentId: string,
  promptId: string,
  useSubmissionBody: boolean,
): Promise<TeacherAssignment> {
  const { data: existing } = await admin
    .from("teacher_assignments")
    .select("*")
    .eq("teacher_id", teacherId)
    .eq("canvas_assignment_id", canvasAssignmentId)
    .maybeSingle();

  if (existing) {
    const promptChanged = existing.prompt_id !== promptId;
    const modeChanged = existing.use_submission_body !== useSubmissionBody;
    if (promptChanged || modeChanged) {
      const { data: updated, error } = await admin
        .from("teacher_assignments")
        .update({ prompt_id: promptId, use_submission_body: useSubmissionBody })
        .eq("id", existing.id)
        .select("*")
        .single();
      if (error || !updated) {
        throw new Error(
          `Couldn't update teacher assignment: ${error?.message ?? "unknown"}`,
        );
      }
      return updated;
    }
    return existing;
  }

  const { data: created, error } = await admin
    .from("teacher_assignments")
    .insert({
      teacher_id: teacherId,
      canvas_course_id: canvasCourseId,
      canvas_assignment_id: canvasAssignmentId,
      prompt_id: promptId,
      iframe_token: randomUUID().replaceAll("-", ""),
      use_submission_body: useSubmissionBody,
    })
    .select("*")
    .single();

  if (error || !created) {
    throw new Error(`Couldn't create teacher assignment: ${error?.message ?? "unknown"}`);
  }
  return created;
}

function failAll(
  canvasAssignmentIds: string[],
  message: string,
): InstallActionResult {
  const results: AssignmentResult[] = canvasAssignmentIds.map((id) => ({
    canvasAssignmentId: id,
    ok: false,
    status: "failed",
    message,
  }));
  return {
    results,
    successCount: 0,
    failureCount: results.length,
  };
}
