import type { Tables } from "@ai-documenter/db";

export type CanvasCourseCache = Tables<"canvas_course_cache">;
export type CanvasAssignmentCache = Tables<"canvas_assignment_cache">;
export type AssignmentInstallState = Tables<"assignment_install_state">;
export type Prompt = Tables<"prompts">;

export type PromptOption = Pick<Prompt, "id" | "label" | "is_default">;

export type AssignmentWithInstall = CanvasAssignmentCache & {
  install: AssignmentInstallState | null;
  /** Label of the prompt currently bound to this assignment (via teacher_assignments). */
  promptLabel: string | null;
  /** How many reflection_sessions students have started/completed for this
   * assignment. Populated alongside the install state so the dashboard row
   * can link straight into /dashboard/reviews/... without an extra query. */
  reflectionCount: number;
};

export type CourseGroup = {
  course: CanvasCourseCache;
  assignments: AssignmentWithInstall[];
  autoInstall: boolean;
  installedCount: number;
};
