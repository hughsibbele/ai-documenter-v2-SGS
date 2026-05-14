import "server-only";

/**
 * Bearer-auth guard for super-grader-facing GET endpoints
 * (`/api/super-grader/*`). The shared secret lives in `AI_DOCUMENTER_API_TOKEN`
 * and is set identically on the super-grader side (where it's the value the
 * other peer presents). Distinct from `SUPER_GRADER_INGEST_TOKEN` — that's
 * the token AI Documenter presents on its outbound webhook to super-grader.
 *
 * Returns `null` on success, or a `Response` to return immediately on failure.
 */
export function authorizeSuperGraderRequest(request: Request): Response | null {
  const expected = process.env.AI_DOCUMENTER_API_TOKEN;
  if (!expected) {
    return Response.json(
      {
        ok: false,
        error: "AI_DOCUMENTER_API_TOKEN is not configured on this deploy.",
      },
      { status: 500 },
    );
  }

  const header = request.headers.get("authorization") ?? "";
  // Accept "Bearer <token>" exactly. Trim accidental whitespace.
  const match = header.match(/^Bearer\s+(.+)$/i);
  const presented = match?.[1]?.trim();
  if (!presented || presented !== expected) {
    return Response.json(
      { ok: false, error: "unauthorized" },
      { status: 401 },
    );
  }
  return null;
}
