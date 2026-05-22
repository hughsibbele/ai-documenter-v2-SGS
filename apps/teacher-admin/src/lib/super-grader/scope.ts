import "server-only";

/**
 * Ask super-grader whether it is tracking this Canvas assignment. When
 * `in_scope: true`, this app should skip its own Canvas-write path
 * (comment / submission body) — super-grader owns the final post.
 *
 * Fail-open contract: any error (timeout, 5xx, env unset, JSON parse
 * failure) returns `{ in_scope: false }` so a transient SG outage doesn't
 * silently suppress student submissions. We log so operators can spot
 * persistent breakage.
 *
 * Cached in-process for 5 minutes per assignment so repeated calls during
 * a single page load are free. Cache lives for the lifetime of the
 * serverless function instance; no inter-instance coordination.
 */
export type SuperGraderScope = {
  in_scope: boolean;
  role: string | null;
};

type CacheEntry = { value: SuperGraderScope; expires: number };
const CACHE = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 2500;

export function __resetSuperGraderScopeCache(): void {
  CACHE.clear();
}

export async function isAssignmentInSuperGraderScope(
  canvasAssignmentId: string,
): Promise<SuperGraderScope> {
  if (!canvasAssignmentId) return { in_scope: false, role: null };

  const cached = CACHE.get(canvasAssignmentId);
  if (cached && cached.expires > Date.now()) return cached.value;

  const baseUrl = process.env.SUPER_GRADER_API_URL?.replace(/\/$/, "");
  const token = process.env.SUPER_GRADER_INGEST_TOKEN;
  if (!baseUrl || !token) {
    // Treat unconfigured as "not in scope" — same fail-open posture as the
    // notify path. The notify path already warns loudly when SG env is unset;
    // no need to double-warn here on every page load.
    return { in_scope: false, role: null };
  }

  const url = new URL(
    "/api/peers/ai_documenter/assignment-status",
    baseUrl,
  );
  url.searchParams.set("canvas_assignment_id", canvasAssignmentId);

  try {
    const res = await fetch(url.toString(), {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(
        `[sg-scope] non-2xx from super-grader for assignment ${canvasAssignmentId}: ${res.status}`,
      );
      return { in_scope: false, role: null };
    }
    const body = (await res.json()) as unknown;
    if (!body || typeof body !== "object") {
      return { in_scope: false, role: null };
    }
    const parsed: SuperGraderScope = {
      in_scope: Boolean((body as { in_scope?: unknown }).in_scope),
      role:
        typeof (body as { role?: unknown }).role === "string"
          ? ((body as { role: string }).role)
          : null,
    };
    CACHE.set(canvasAssignmentId, {
      value: parsed,
      expires: Date.now() + CACHE_TTL_MS,
    });
    return parsed;
  } catch (err) {
    console.warn(
      `[sg-scope] super-grader lookup failed for assignment ${canvasAssignmentId}: ${(err as Error).message}`,
    );
    return { in_scope: false, role: null };
  }
}

/**
 * Bulk variant for the teacher dashboard's assignment list. Runs the per-
 * assignment lookups in parallel; each one fail-opens independently so a
 * single timeout doesn't poison the whole list.
 */
export async function bulkSuperGraderScope(
  canvasAssignmentIds: string[],
): Promise<Map<string, SuperGraderScope>> {
  const unique = Array.from(new Set(canvasAssignmentIds.filter(Boolean)));
  const results = await Promise.all(
    unique.map(async (id) => [id, await isAssignmentInSuperGraderScope(id)] as const),
  );
  return new Map(results);
}
