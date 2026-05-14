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
import { getCurrentTeacher } from "@/lib/auth/teacher";
import { getServerDbClient } from "@/lib/supabase/server";
import type {
  CreatePromptResult,
  DeletePromptResult,
  SavePromptResult,
} from "./prompts.types";

export async function createPrompt(args: {
  label: string;
  body: string;
  studentFacingQuestion?: string | null;
}): Promise<CreatePromptResult> {
  const teacher = await getCurrentTeacher();
  const label = args.label.trim();
  const body = args.body;
  const studentFacingQuestion = args.studentFacingQuestion?.trim() || null;

  if (!label) return { ok: false, message: "Label can't be empty" };
  if (!body.trim()) return { ok: false, message: "Prompt body can't be empty" };

  const supabase = await getServerDbClient();
  const { data, error } = await supabase
    .from("prompts")
    .insert({
      teacher_id: teacher.id,
      scope: "teacher",
      label,
      body,
      student_facing_question: studentFacingQuestion,
      is_default: false,
    })
    .select("id")
    .single();

  if (error || !data) {
    if (error?.code === "23505") {
      return { ok: false, message: "You already have a prompt with that label" };
    }
    return { ok: false, message: error?.message ?? "Couldn't create prompt" };
  }

  revalidatePath("/dashboard/prompts");
  revalidatePath("/dashboard");
  return { ok: true, promptId: data.id };
}

export async function savePrompt(
  promptId: string,
  args: {
    label?: string;
    body?: string;
    studentFacingQuestion?: string | null;
  },
): Promise<SavePromptResult> {
  const teacher = await getCurrentTeacher();
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
      return { ok: false, message: "Prompt body can't be empty" };
    updates.body = args.body;
  }
  if (args.studentFacingQuestion !== undefined) {
    const q = args.studentFacingQuestion?.trim() || null;
    updates.student_facing_question = q;
  }
  if (Object.keys(updates).length === 0) {
    return { ok: true };
  }

  const supabase = await getServerDbClient();
  const { error } = await supabase
    .from("prompts")
    .update(updates)
    .eq("id", promptId)
    .eq("teacher_id", teacher.id);

  if (error) {
    if (error.code === "23505") {
      return { ok: false, message: "You already have a prompt with that label" };
    }
    return { ok: false, message: error.message };
  }

  revalidatePath("/dashboard/prompts");
  revalidatePath("/dashboard");
  return { ok: true };
}

export async function deletePrompt(promptId: string): Promise<DeletePromptResult> {
  const teacher = await getCurrentTeacher();
  if (!teacher.canvas_host || !teacher.canvas_token_encrypted) {
    return { ok: false, message: "Canvas isn't connected" };
  }

  const admin = createAdminDbClient();

  // Validate prompt exists, is owned, and isn't the default.
  const { data: target } = await admin
    .from("prompts")
    .select("id, label, is_default, teacher_id")
    .eq("id", promptId)
    .eq("teacher_id", teacher.id)
    .maybeSingle();

  if (!target) return { ok: false, message: "Prompt not found" };
  if (target.is_default)
    return { ok: false, message: "The Default prompt can't be deleted" };

  // Find the teacher's actual default prompt (we'll reassign course defaults
  // to it).
  const { data: defaultPrompt } = await admin
    .from("prompts")
    .select("id")
    .eq("teacher_id", teacher.id)
    .eq("is_default", true)
    .single();

  if (!defaultPrompt) {
    return {
      ok: false,
      message: "No default prompt found — can't reassign safely",
    };
  }

  // Decrypt token for Canvas uninstall calls.
  let token: string;
  try {
    token = decryptSecret(teacher.canvas_token_encrypted, readKeyFromEnv());
  } catch (err) {
    return {
      ok: false,
      message: `Token decrypt failed: ${(err as Error).message}`,
    };
  }
  const config: CanvasConfig = { host: teacher.canvas_host, token };

  // Load every teacher_assignment using this prompt + its current install state.
  const { data: bindings } = await admin
    .from("teacher_assignments")
    .select("id, canvas_course_id, canvas_assignment_id")
    .eq("teacher_id", teacher.id)
    .eq("prompt_id", promptId);

  let uninstalledCount = 0;
  for (const ta of bindings ?? []) {
    // Pull current install_state row to know if it's actually installed in Canvas.
    const { data: state } = await admin
      .from("assignment_install_state")
      .select("status")
      .eq("teacher_id", teacher.id)
      .eq("canvas_assignment_id", ta.canvas_assignment_id)
      .maybeSingle();

    if (state?.status === "installed") {
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
        // Continue — if Canvas is unreachable for one assignment, we still
        // want the prompt deleted so the teacher isn't stuck. Mark the row
        // as failed so it's visible in the dashboard.
        await admin
          .from("assignment_install_state")
          .update({
            status: "failed",
            last_error:
              err instanceof CanvasError
                ? err.message
                : (err as Error).message,
          })
          .eq("teacher_id", teacher.id)
          .eq("canvas_assignment_id", ta.canvas_assignment_id);
        continue;
      }
    }

    // Mark the install state uninstalled regardless of Canvas reachability.
    await admin
      .from("assignment_install_state")
      .upsert(
        {
          teacher_id: teacher.id,
          canvas_course_id: ta.canvas_course_id,
          canvas_assignment_id: ta.canvas_assignment_id,
          status: "uninstalled",
          uninstalled_at: new Date().toISOString(),
        },
        { onConflict: "teacher_id,canvas_assignment_id" },
      );
  }

  // teacher_assignments has FK ON DELETE RESTRICT against prompts, so the
  // bindings need to be deleted before the prompt row.
  if (bindings && bindings.length > 0) {
    await admin
      .from("teacher_assignments")
      .delete()
      .eq("teacher_id", teacher.id)
      .eq("prompt_id", promptId);
  }

  // Reassign any course-level default policies to the teacher's Default.
  const { data: policiesUsing } = await admin
    .from("course_install_policies")
    .select("id")
    .eq("teacher_id", teacher.id)
    .eq("default_prompt_id", promptId);

  const reassignedPolicyCount = policiesUsing?.length ?? 0;
  if (reassignedPolicyCount > 0) {
    await admin
      .from("course_install_policies")
      .update({ default_prompt_id: defaultPrompt.id })
      .eq("teacher_id", teacher.id)
      .eq("default_prompt_id", promptId);
  }

  // Finally remove the prompt row.
  const { error: delError } = await admin
    .from("prompts")
    .delete()
    .eq("id", promptId)
    .eq("teacher_id", teacher.id);

  if (delError) {
    return { ok: false, message: delError.message };
  }

  revalidatePath("/dashboard/prompts");
  revalidatePath("/dashboard");
  return {
    ok: true,
    uninstalledCount,
    reassignedPolicyCount,
  };
}
