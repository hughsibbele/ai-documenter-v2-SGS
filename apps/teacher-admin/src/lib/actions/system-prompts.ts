"use server";

import { revalidatePath } from "next/cache";
import {
  CanvasError,
  getAssignment,
  removeReflectionBlock,
  updateAssignmentDescription,
  type CanvasConfig,
} from "@ai-documenter/canvas";
import { decryptSecret, readKeyFromEnv } from "@ai-documenter/crypto";
import { createAdminDbClient } from "@ai-documenter/db/admin";
import { getCurrentAdminEmail } from "@/lib/auth/admin";
import type {
  CreateSystemPromptResult,
  DeleteSystemPromptResult,
  SaveSystemPromptResult,
} from "./system-prompts.types";

export async function createSystemPrompt(args: {
  label: string;
  body: string;
  studentFacingQuestion?: string | null;
}): Promise<CreateSystemPromptResult> {
  const adminEmail = await getCurrentAdminEmail();
  if (!adminEmail) return { ok: false, message: "Admin only" };

  const label = args.label.trim();
  const body = args.body;
  const studentFacingQuestion = args.studentFacingQuestion?.trim() || null;
  if (!label) return { ok: false, message: "Label can't be empty" };
  if (!body.trim()) return { ok: false, message: "Body can't be empty" };

  const admin = createAdminDbClient();
  const { data, error } = await admin
    .from("prompts")
    .insert({
      label,
      body,
      student_facing_question: studentFacingQuestion,
      scope: "system",
      teacher_id: null,
      is_default: false,
      // The "+ New system prompt" UI only creates reflection prompts.
      // The objective_summary prompt is seeded once via migration.
      purpose: "reflection",
    })
    .select("id")
    .single();

  if (error || !data) {
    if (error?.code === "23505") {
      return { ok: false, message: "A system prompt with that label already exists" };
    }
    return { ok: false, message: error?.message ?? "Couldn't create prompt" };
  }

  revalidatePath("/admin/prompts");
  revalidatePath("/dashboard/prompts");
  revalidatePath("/dashboard");
  return { ok: true, promptId: data.id };
}

export async function saveSystemPrompt(
  promptId: string,
  args: {
    label?: string;
    body?: string;
    studentFacingQuestion?: string | null;
  },
): Promise<SaveSystemPromptResult> {
  const adminEmail = await getCurrentAdminEmail();
  if (!adminEmail) return { ok: false, message: "Admin only" };

  const updates: {
    label?: string;
    body?: string;
    student_facing_question?: string | null;
  } = {};
  if (args.label !== undefined) {
    const label = args.label.trim();
    if (!label) return { ok: false, message: "Label can't be empty" };
    updates.label = label;
  }
  if (args.body !== undefined) {
    if (!args.body.trim())
      return { ok: false, message: "Body can't be empty" };
    updates.body = args.body;
  }
  if (args.studentFacingQuestion !== undefined) {
    const q = args.studentFacingQuestion?.trim() || null;
    updates.student_facing_question = q;
  }
  if (Object.keys(updates).length === 0) return { ok: true };

  const admin = createAdminDbClient();
  const { error } = await admin
    .from("prompts")
    .update(updates)
    .eq("id", promptId)
    .eq("scope", "system");

  if (error) {
    if (error.code === "23505") {
      return { ok: false, message: "A system prompt with that label already exists" };
    }
    return { ok: false, message: error.message };
  }

  revalidatePath("/admin/prompts");
  revalidatePath("/dashboard/prompts");
  revalidatePath("/dashboard");
  return { ok: true };
}

export async function deleteSystemPrompt(
  promptId: string,
): Promise<DeleteSystemPromptResult> {
  const adminEmail = await getCurrentAdminEmail();
  if (!adminEmail) return { ok: false, message: "Admin only" };

  const admin = createAdminDbClient();

  const { data: target } = await admin
    .from("prompts")
    .select("id, label, is_default, scope, purpose")
    .eq("id", promptId)
    .eq("scope", "system")
    .maybeSingle();

  if (!target) return { ok: false, message: "System prompt not found" };
  if (target.purpose === "objective_summary")
    return { ok: false, message: "The objective summary prompt can't be deleted" };
  if (target.is_default)
    return { ok: false, message: "The Default system prompt can't be deleted" };

  // Find the seeded system Default to reassign course policies that pointed
  // at the prompt being deleted.
  const { data: defaultPrompt } = await admin
    .from("prompts")
    .select("id")
    .eq("scope", "system")
    .eq("is_default", true)
    .single();

  if (!defaultPrompt) {
    return {
      ok: false,
      message: "No system Default found — can't reassign safely",
    };
  }

  // Cross-teacher: find every teacher_assignment using this prompt, grouped
  // by teacher so we can use each teacher's Canvas token for the uninstall.
  const { data: bindings } = await admin
    .from("teacher_assignments")
    .select("id, teacher_id, canvas_course_id, canvas_assignment_id")
    .eq("prompt_id", promptId);

  let uninstalledCount = 0;
  if (bindings && bindings.length > 0) {
    // Cache per-teacher Canvas configs so we decrypt each token once.
    const configByTeacher = new Map<string, CanvasConfig | null>();

    for (const ta of bindings) {
      let config = configByTeacher.get(ta.teacher_id);
      if (config === undefined) {
        const { data: t } = await admin
          .from("teachers")
          .select("canvas_host, canvas_token_encrypted")
          .eq("id", ta.teacher_id)
          .single();
        if (!t || !t.canvas_host || !t.canvas_token_encrypted) {
          configByTeacher.set(ta.teacher_id, null);
          config = null;
        } else {
          try {
            const token = decryptSecret(t.canvas_token_encrypted, readKeyFromEnv());
            config = { host: t.canvas_host, token };
          } catch {
            config = null;
          }
          configByTeacher.set(ta.teacher_id, config);
        }
      }

      // Check whether it's actually installed in Canvas right now.
      const { data: state } = await admin
        .from("assignment_install_state")
        .select("status")
        .eq("teacher_id", ta.teacher_id)
        .eq("canvas_assignment_id", ta.canvas_assignment_id)
        .maybeSingle();

      if (state?.status === "installed" && config) {
        try {
          const a = await getAssignment(
            config,
            ta.canvas_course_id,
            ta.canvas_assignment_id,
          );
          const cleaned = removeReflectionBlock(a.description ?? "");
          if (cleaned !== (a.description ?? "")) {
            await updateAssignmentDescription(
              config,
              ta.canvas_course_id,
              ta.canvas_assignment_id,
              cleaned,
            );
          }
          uninstalledCount += 1;
        } catch (err) {
          await admin
            .from("assignment_install_state")
            .update({
              status: "failed",
              last_error:
                err instanceof CanvasError
                  ? err.message
                  : (err as Error).message,
            })
            .eq("teacher_id", ta.teacher_id)
            .eq("canvas_assignment_id", ta.canvas_assignment_id);
          continue;
        }
      }

      await admin
        .from("assignment_install_state")
        .upsert(
          {
            teacher_id: ta.teacher_id,
            canvas_course_id: ta.canvas_course_id,
            canvas_assignment_id: ta.canvas_assignment_id,
            status: "uninstalled",
            uninstalled_at: new Date().toISOString(),
          },
          { onConflict: "teacher_id,canvas_assignment_id" },
        );
    }

    await admin
      .from("teacher_assignments")
      .delete()
      .eq("prompt_id", promptId);
  }

  // Reassign course-level defaults that point at the prompt being deleted.
  const { data: policiesUsing } = await admin
    .from("course_install_policies")
    .select("id")
    .eq("default_prompt_id", promptId);

  const reassignedPolicyCount = policiesUsing?.length ?? 0;
  if (reassignedPolicyCount > 0) {
    await admin
      .from("course_install_policies")
      .update({ default_prompt_id: defaultPrompt.id })
      .eq("default_prompt_id", promptId);
  }

  const { error: delError } = await admin
    .from("prompts")
    .delete()
    .eq("id", promptId)
    .eq("scope", "system");
  if (delError) return { ok: false, message: delError.message };

  revalidatePath("/admin/prompts");
  revalidatePath("/dashboard/prompts");
  revalidatePath("/dashboard");
  return { ok: true, uninstalledCount, reassignedPolicyCount };
}
