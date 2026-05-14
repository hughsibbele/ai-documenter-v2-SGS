import "server-only";
import { createAdminDbClient } from "@ai-documenter/db/admin";
import type { Tables } from "@ai-documenter/db";

export type IframeContext = {
  teacherAssignment: Tables<"teacher_assignments">;
  prompt: Tables<"prompts">;
  courseName: string | null;
  assignmentName: string | null;
};

// Resolve an iframe_token to the bound teacher_assignment + prompt + display
// names. Uses the service-role admin client because the cache tables are
// service-role-only on write and the visiting student isn't authed yet.
//
// Note: prompt.student_facing_question (added in M3.1) is the short, official
// question shown to students; prompt.body remains the Gemini system prompt.
export async function resolveIframeToken(
  iframeToken: string,
): Promise<IframeContext | null> {
  if (!iframeToken || iframeToken.length < 16) return null;

  const admin = createAdminDbClient();

  const { data: ta } = await admin
    .from("teacher_assignments")
    .select("*")
    .eq("iframe_token", iframeToken)
    .maybeSingle();

  if (!ta) return null;

  const [{ data: prompt }, { data: assignment }, { data: course }] =
    await Promise.all([
      admin.from("prompts").select("*").eq("id", ta.prompt_id).maybeSingle(),
      admin
        .from("canvas_assignment_cache")
        .select("name")
        .eq("teacher_id", ta.teacher_id)
        .eq("canvas_assignment_id", ta.canvas_assignment_id)
        .maybeSingle(),
      admin
        .from("canvas_course_cache")
        .select("name")
        .eq("teacher_id", ta.teacher_id)
        .eq("canvas_course_id", ta.canvas_course_id)
        .maybeSingle(),
    ]);

  if (!prompt) return null;

  return {
    teacherAssignment: ta,
    prompt,
    courseName: course?.name ?? null,
    assignmentName: assignment?.name ?? null,
  };
}

/** Fallback shown when a reflection prompt hasn't had its student-facing
 * question set yet (older teacher prompts created before M3.1, or someone
 * manually inserted a row). Keeps the UI from rendering empty space. */
export const DEFAULT_STUDENT_FACING_QUESTION =
  "Reflect on how you used AI for this assignment. What was your process? Where did the AI help your thinking, and where did it just give you an answer?";
