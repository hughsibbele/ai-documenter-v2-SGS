"use server";

import { revalidatePath } from "next/cache";
import { createAdminDbClient } from "@ai-documenter/db/admin";
import { getCurrentTeacher } from "@/lib/auth/teacher";

export type SetAutoInstallResult =
  | { ok: true; enabled: boolean }
  | { ok: false; message: string };

/**
 * Persist the per-course auto-install toggle. Upserts
 * `course_install_policies.auto_install_new_assignments` for the (teacher,
 * course) pair. The nightly cron picks this up: on each sync, any newly-
 * encountered published assignment in a policy-enabled course gets the
 * reflection card installed automatically using the course's default prompt.
 *
 * If no policy row exists yet (teacher hasn't installed anything in this
 * course before), we need a `default_prompt_id` — fall back to the system
 * Default. Returns an error if even the system Default is missing.
 */
export async function setCourseAutoInstall(
  canvasCourseId: string,
  enabled: boolean,
): Promise<SetAutoInstallResult> {
  const teacher = await getCurrentTeacher();
  const admin = createAdminDbClient();

  const { data: existing } = await admin
    .from("course_install_policies")
    .select("id, default_prompt_id")
    .eq("teacher_id", teacher.id)
    .eq("canvas_course_id", canvasCourseId)
    .maybeSingle();

  // `auto_install_enabled_at` is the baseline timestamp: only assignments
  // first cached AFTER this moment get auto-installed. Without it the sweep
  // would treat every pristine assignment as "new" and install on all of
  // them. Set it whenever we flip from off → on; on off, clear it so a
  // future re-enable starts fresh.
  const enabledAt = enabled ? new Date().toISOString() : null;

  if (existing) {
    const { error } = await admin
      .from("course_install_policies")
      .update({
        auto_install_new_assignments: enabled,
        auto_install_enabled_at: enabledAt,
      })
      .eq("id", existing.id);
    if (error) return { ok: false, message: error.message };
    revalidatePath("/dashboard");
    return { ok: true, enabled };
  }

  // No policy yet — seed one. Need a default_prompt_id; use the system
  // Default reflection prompt.
  const { data: defaultPrompt } = await admin
    .from("prompts")
    .select("id")
    .eq("scope", "system")
    .eq("purpose", "reflection")
    .eq("is_default", true)
    .maybeSingle();

  if (!defaultPrompt) {
    return {
      ok: false,
      message:
        "Auto-install needs a default prompt and no system Default reflection prompt is configured. Set one in /admin/prompts first.",
    };
  }

  const { error } = await admin.from("course_install_policies").insert({
    teacher_id: teacher.id,
    canvas_course_id: canvasCourseId,
    default_prompt_id: defaultPrompt.id,
    auto_install_new_assignments: enabled,
    auto_install_enabled_at: enabledAt,
  });
  if (error) return { ok: false, message: error.message };

  revalidatePath("/dashboard");
  return { ok: true, enabled };
}
