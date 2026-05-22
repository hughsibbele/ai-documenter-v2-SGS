import type { Tables } from "@ai-documenter/db";

export type CanvasCourseCache = Tables<"canvas_course_cache">;
export type CanvasAssignmentCache = Tables<"canvas_assignment_cache">;
export type AssignmentInstallState = Tables<"assignment_install_state">;
export type Prompt = Tables<"prompts">;

export type PromptOption = Pick<Prompt, "id" | "label" | "is_default">;

/** M6.18a: persisted 3-checkbox destination triple. Null when no
 *  teacher_assignments row exists yet (assignment never installed). */
export type DestinationState = {
  drive: boolean;
  comment: boolean;
  submission: boolean;
};

export type AssignmentWithInstall = CanvasAssignmentCache & {
  install: AssignmentInstallState | null;
  /** Label of the prompt currently bound to this assignment (via teacher_assignments). */
  promptLabel: string | null;
  /** How many reflection_sessions students have started/completed for this
   * assignment. Populated alongside the install state so the dashboard row
   * can link straight into /dashboard/reviews/... without an extra query. */
  reflectionCount: number;
  /** M6.18a: persisted destination triple, or null when no
   *  teacher_assignments row exists yet. The bar pre-fills from this when
   *  the teacher selects a previously-installed row, falling back to
   *  per-app defaults otherwise. */
  destination: DestinationState | null;
  /** True when super-grader is tracking this assignment. When true, AID
   *  skips its own Canvas-write path (comment / submission body) — SG
   *  owns the final post. Surfaced as a row badge in the dashboard. */
  inSuperGraderScope: boolean;
};

export type CourseGroup = {
  course: CanvasCourseCache;
  assignments: AssignmentWithInstall[];
  autoInstall: boolean;
  installedCount: number;
};
