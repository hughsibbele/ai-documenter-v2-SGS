import { CanvasError } from "./error";
import { canvasFetch, paginate } from "./fetch";
import type { CanvasAssignment, CanvasConfig } from "./types";

/**
 * List assignments for a course. By default returns published only.
 * Pass `includeUnpublished: true` to include drafts (the install flow filters
 * them out, but the manage view may want to see them).
 */
export async function listCourseAssignments(
  config: CanvasConfig,
  canvasCourseId: string | number,
  options: { includeUnpublished?: boolean } = {},
): Promise<CanvasAssignment[]> {
  const path =
    `/courses/${canvasCourseId}/assignments?` +
    "include[]=submission_types&per_page=100";
  const all = await paginate<CanvasAssignment>(config, path);
  if (options.includeUnpublished) return all;
  return all.filter((a) => a.workflow_state === "published");
}

/**
 * Fetch a single assignment, including its current `description` HTML.
 * Required before install/reinstall so we can patch the description in place.
 */
export async function getAssignment(
  config: CanvasConfig,
  canvasCourseId: string | number,
  canvasAssignmentId: string | number,
): Promise<CanvasAssignment> {
  const res = await canvasFetch(
    config,
    `/courses/${canvasCourseId}/assignments/${canvasAssignmentId}`,
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new CanvasError(
      `Canvas GET assignment ${canvasAssignmentId} returned ${res.status}.`,
      res.status,
      body,
    );
  }
  return (await res.json()) as CanvasAssignment;
}

/**
 * PUT a new `description` onto an existing assignment. Used by the install
 * flow after `replaceOrAppendIframeBlock` has patched the marker block in.
 *
 * Returns the updated assignment (Canvas echoes the full record).
 */
export async function updateAssignmentDescription(
  config: CanvasConfig,
  canvasCourseId: string | number,
  canvasAssignmentId: string | number,
  description: string,
): Promise<CanvasAssignment> {
  const params = new URLSearchParams();
  params.set("assignment[description]", description);

  const res = await canvasFetch(
    config,
    `/courses/${canvasCourseId}/assignments/${canvasAssignmentId}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    },
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new CanvasError(
      `Canvas PUT assignment ${canvasAssignmentId} returned ${res.status}.`,
      res.status,
      body,
    );
  }
  return (await res.json()) as CanvasAssignment;
}
