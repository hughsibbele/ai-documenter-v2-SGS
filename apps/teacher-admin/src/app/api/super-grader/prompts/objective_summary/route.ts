import { createAdminDbClient } from "@ai-documenter/db/admin";
import { authorizeSuperGraderRequest } from "@/lib/super-grader/auth";

/**
 * `GET /api/super-grader/prompts/objective_summary`
 *
 * Returns the canonical objective-summary system prompt. AI Documenter is the
 * source of truth for this prompt; super-grader mirrors it read-only via
 * pull-on-view so admins only edit in one place.
 *
 * Auth: bearer `AI_DOCUMENTER_API_TOKEN`.
 *
 * **Response shape:** flat `{ owner, key, body, version, updated_at }` — this
 * is what super-grader's `fetchLivePrompt` parser expects (see
 * `super-grader/apps/teacher/lib/peers/prompt-pull.ts`). Our `prompts` table
 * doesn't carry a numeric `version` column; we project the `updated_at`
 * timestamp into an integer (milliseconds since epoch) so super-grader's
 * "did the prompt change since I last cached?" check works without a schema
 * migration. Strictly monotonic per save, which is all super-grader needs.
 *
 * 404 when the seeded row is missing (shouldn't happen in production — the
 * seed migration installs it).
 */
export async function GET(request: Request): Promise<Response> {
  const denied = authorizeSuperGraderRequest(request);
  if (denied) return denied;

  const admin = createAdminDbClient();
  const { data, error } = await admin
    .from("prompts")
    .select("body, updated_at")
    .eq("scope", "system")
    .eq("purpose", "objective_summary")
    .eq("is_default", true)
    .maybeSingle();

  if (error) {
    return Response.json(
      { error: error.message },
      { status: 500 },
    );
  }
  if (!data) {
    return Response.json(
      {
        error:
          "Objective-summary prompt not configured (no row with scope=system, purpose=objective_summary, is_default=true).",
      },
      { status: 404 },
    );
  }

  return Response.json(
    {
      owner: "ai_documenter",
      key: "objective_summary",
      body: data.body,
      version: Date.parse(data.updated_at),
      updated_at: data.updated_at,
    },
    {
      headers: {
        // Super-grader's pull-on-view pattern means each teacher load hits
        // this endpoint once per assignment. The contract suggests ~10min
        // cache lifetime; matches super-grader's prompt-pull TTL.
        "Cache-Control": "public, max-age=600",
      },
    },
  );
}
