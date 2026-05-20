import { CanvasError } from "./error";
import { canvasFetch, paginate } from "./fetch";
import type { CanvasConfig, CanvasUser } from "./types";

/**
 * List every student enrolled in a Canvas course. Returns id, name, email
 * (when Canvas exposes it via `include[]=email`).
 *
 * Used by the nightly roster sync: the compiled name list scrubs free-text
 * AI transcripts before they reach Gemini. Per-page caps at 100 (Canvas's
 * `per_page` ceiling); `paginate` follows Link headers across pages.
 */
export async function listCourseStudents(
  config: CanvasConfig,
  canvasCourseId: string | number,
): Promise<CanvasUser[]> {
  const path =
    `/courses/${canvasCourseId}/users?` +
    `enrollment_type[]=student&` +
    `include[]=email&per_page=100`;
  return paginate<CanvasUser>(config, path);
}

/**
 * Find a student in a Canvas course by email. Used during the first
 * auto-submit pass when we haven't yet recorded the student's canvas_user_id
 * (intake created the students row from SSO without it).
 *
 * **Why we don't use `search_term=`:** Canvas's `search_term` matches against
 * `name`, `sis_user_id`, and `login_id` — NOT against `primary_email`. So
 * passing the full SSO email returns zero hits at EHS because Canvas's
 * `login_id` for our students is the email LOCAL PART only (e.g. `jsmith42`
 * for `jsmith42@episcopalhighschool.org`), not the full address.
 *
 * Fix: list the whole student roster (paginated, `per_page=100`) and filter
 * client-side, accepting a match against any of these:
 *   1. `primary_email`   exact-equals the full email (when Canvas populates it)
 *   2. `email`            same (some accounts expose a third `email` field)
 *   3. `login_id`         exact-equals the full email (some setups)
 *   4. `login_id`         exact-equals the email's LOCAL PART (EHS's case)
 *
 * First match wins. Returns null if nothing matches.
 *
 * Performance: ≤30-student EHS class = one Canvas call; 300-student lecture
 * = three calls. Runs once per student per assignment — the resolved
 * canvas_user_id is then cached on `students.canvas_user_id` forever.
 */
export async function lookupCourseStudentByEmail(
  config: CanvasConfig,
  canvasCourseId: string | number,
  email: string,
): Promise<CanvasUser | null> {
  const lower = email.trim().toLowerCase();
  if (!lower) return null;
  const localPart = lower.split("@")[0] ?? "";

  const users = await listCourseStudents(config, canvasCourseId);
  const match = users.find((u) => {
    const loginId = (u.login_id ?? "").trim().toLowerCase();
    const fullEmailCandidates = [
      u.primary_email,
      (u as CanvasUser & { email?: string }).email,
      u.login_id,
    ];
    if (
      fullEmailCandidates.some(
        (c) => (c ?? "").trim().toLowerCase() === lower,
      )
    ) {
      return true;
    }
    // EHS-style: login_id is the local part only.
    return localPart.length > 0 && loginId === localPart;
  });
  return match ?? null;
}

/**
 * Post an `online_text_entry` submission on behalf of a student via Canvas's
 * `as_user_id` masquerade. Requires the teacher's API token to have
 * masquerade permission on the target student — standard for the Teacher
 * role within their own course.
 *
 * The body is HTML; Canvas's RCE sanitizer runs server-side on save, so keep
 * to elements + inline styles Canvas allows. Returns the new submission's ID
 * so the caller can store it on reflection_sessions.canvas_submission_id.
 *
 * Caller should fall back to `postSubmissionCommentAsStudent` on a 400 — that
 * usually means the assignment's submission_types[] doesn't include
 * online_text_entry, and Canvas will reject any submission until the teacher
 * enables it. Comments don't have that restriction.
 */
export async function submitTextEntryAsStudent(
  config: CanvasConfig,
  canvasCourseId: string | number,
  canvasAssignmentId: string | number,
  canvasUserId: string | number,
  htmlBody: string,
): Promise<{ submissionId: number }> {
  const params = new URLSearchParams();
  params.set("submission[submission_type]", "online_text_entry");
  params.set("submission[body]", htmlBody);

  const path =
    `/courses/${canvasCourseId}/assignments/${canvasAssignmentId}/submissions?` +
    `as_user_id=${encodeURIComponent(String(canvasUserId))}`;

  const res = await canvasFetch(config, path, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new CanvasError(
      `Canvas POST submission for assignment ${canvasAssignmentId} (as_user_id=${canvasUserId}) returned ${res.status}.`,
      res.status,
      body,
    );
  }

  const data = (await res.json()) as { id: number };
  return { submissionId: data.id };
}

/**
 * Fallback path: attach the reflection as a **submission comment** rather
 * than as the submission body. Used when the assignment's submission_types
 * doesn't include `online_text_entry` (Canvas 400s the regular POST in that
 * case).
 *
 * Why this works regardless of submission type: per Canvas's source
 * (`submissions_api_controller.rb#update`), the `comment[text_comment]`
 * parameter is processed independently of `submission[]` params, and the
 * controller calls `@assignment.find_or_create_submission(@user)` so the
 * student doesn't even need a prior submission record. Comments aren't
 * gated on submission_types.
 *
 * Posted via `as_user_id` masquerade so the comment shows up as authored
 * by the student in the gradebook, matching the regular-submission UX.
 *
 * Canvas returns the (shell) submission with its comments embedded. We
 * return the submission's numeric id so the caller can still populate
 * reflection_sessions.canvas_submission_id and the "Open in Canvas" link
 * works the same way.
 *
 * Note: `text_comment` is plain text. Caller must pre-flatten any HTML.
 */
export async function postSubmissionCommentAsStudent(
  config: CanvasConfig,
  canvasCourseId: string | number,
  canvasAssignmentId: string | number,
  canvasUserId: string | number,
  textComment: string,
): Promise<{ submissionId: number }> {
  const params = new URLSearchParams();
  params.set("comment[text_comment]", textComment);

  const path =
    `/courses/${canvasCourseId}/assignments/${canvasAssignmentId}/submissions/${encodeURIComponent(
      String(canvasUserId),
    )}?as_user_id=${encodeURIComponent(String(canvasUserId))}`;

  const res = await canvasFetch(config, path, {
    method: "PUT",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new CanvasError(
      `Canvas PUT comment for assignment ${canvasAssignmentId} (as_user_id=${canvasUserId}) returned ${res.status}.`,
      res.status,
      body,
    );
  }

  const data = (await res.json()) as { id: number };
  return { submissionId: data.id };
}
