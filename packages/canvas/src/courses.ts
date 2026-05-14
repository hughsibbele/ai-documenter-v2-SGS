import { CanvasError } from "./error";
import { canvasFetch, paginate } from "./fetch";
import type { CanvasConfig, CanvasCourse, CanvasUser } from "./types";

/**
 * Verify the supplied token by fetching the authenticated user.
 * Throws CanvasError(401) on bad/expired token.
 */
export async function getSelf(config: CanvasConfig): Promise<CanvasUser> {
  const res = await canvasFetch(config, "/users/self");
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if (res.status === 401) {
      throw new CanvasError(
        "Canvas rejected the token (401). Check that you copied the full token.",
        401,
        body,
      );
    }
    throw new CanvasError(
      `Canvas /users/self returned ${res.status}.`,
      res.status,
      body,
    );
  }
  return (await res.json()) as CanvasUser;
}

/**
 * Fetch all courses where the authenticated user is a teacher (any state).
 * Includes term + sections so the picker UI can show context.
 */
export async function listTeachingCourses(
  config: CanvasConfig,
): Promise<CanvasCourse[]> {
  const path =
    "/courses?enrollment_type=teacher&per_page=100" +
    "&include[]=term&include[]=sections" +
    "&state[]=available&state[]=completed&state[]=unpublished";
  return paginate<CanvasCourse>(config, path);
}
