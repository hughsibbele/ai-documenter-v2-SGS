// Fetch prompts from super-grader's registry per integration-contract §11.
//
//   GET <baseUrl>/api/prompts?owner=<owner>&key=<key>
//   Authorization: Bearer <AI_DOCUMENTER_API_TOKEN>
//
//   200 → { owner, key, body, version }
//   404 → fall back to hardcoded default; do NOT cache the miss (so a freshly
//         seeded prompt is picked up on the next call).
//   401 → throw (config error; surfaces in /admin).
//   5xx / network → fall back, don't cache (transient).
//
// In-memory cache keyed on (baseUrl, owner, key) with default 10-minute TTL.
// Process-local; warms naturally as the app handles requests. No invalidation
// API beyond `clearPromptCache()` for tests.

const DEFAULT_TTL_MS = 10 * 60 * 1000;

export type PromptSource = "cache" | "network" | "fallback";

export type FetchPromptArgs = {
  baseUrl: string;
  owner: string;
  key: string;
  token: string;
  fallback: string;
  ttlMs?: number;
  /** Override fetch for tests. Falls back to globalThis.fetch. */
  fetch?: typeof fetch;
  /** Override Date.now for tests. */
  now?: () => number;
};

export type FetchPromptResult = {
  body: string;
  /** Null when the result came from `fallback`. */
  version: number | null;
  source: PromptSource;
};

type CacheEntry = {
  body: string;
  version: number | null;
  fetchedAt: number;
  ttlMs: number;
};

const cache = new Map<string, CacheEntry>();

function cacheKey(baseUrl: string, owner: string, key: string): string {
  return `${baseUrl}\0${owner}\0${key}`;
}

export function clearPromptCache(): void {
  cache.clear();
}

export async function fetchPrompt(
  args: FetchPromptArgs,
): Promise<FetchPromptResult> {
  const ttlMs = args.ttlMs ?? DEFAULT_TTL_MS;
  const now = (args.now ?? Date.now)();
  const k = cacheKey(args.baseUrl, args.owner, args.key);

  const hit = cache.get(k);
  if (hit && now - hit.fetchedAt < hit.ttlMs) {
    return { body: hit.body, version: hit.version, source: "cache" };
  }

  const url = new URL("/api/prompts", args.baseUrl);
  url.searchParams.set("owner", args.owner);
  url.searchParams.set("key", args.key);

  const fetchImpl = args.fetch ?? globalThis.fetch;
  let res: Response;
  try {
    res = await fetchImpl(url.toString(), {
      headers: { Authorization: `Bearer ${args.token}` },
    });
  } catch {
    // Network failure (DNS, timeout, etc.) — degrade gracefully.
    return { body: args.fallback, version: null, source: "fallback" };
  }

  if (res.status === 401) {
    throw new Error(
      `prompts: 401 Unauthorized fetching ${args.owner}/${args.key} ` +
        `from ${args.baseUrl}. Check the token configured for this peer.`,
    );
  }

  if (res.status === 404) {
    // Per contract: missing prompt → fallback, don't cache (so a newly
    // created prompt shows up within the next request, not after TTL).
    return { body: args.fallback, version: null, source: "fallback" };
  }

  if (!res.ok) {
    // 5xx or other — degrade gracefully, don't cache.
    return { body: args.fallback, version: null, source: "fallback" };
  }

  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    return { body: args.fallback, version: null, source: "fallback" };
  }

  if (!isPromptResponse(payload)) {
    return { body: args.fallback, version: null, source: "fallback" };
  }

  cache.set(k, {
    body: payload.body,
    version: payload.version,
    fetchedAt: now,
    ttlMs,
  });
  return { body: payload.body, version: payload.version, source: "network" };
}

type PromptResponse = {
  owner: string;
  key: string;
  body: string;
  version: number;
};

function isPromptResponse(value: unknown): value is PromptResponse {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.owner === "string" &&
    typeof v.key === "string" &&
    typeof v.body === "string" &&
    typeof v.version === "number"
  );
}
