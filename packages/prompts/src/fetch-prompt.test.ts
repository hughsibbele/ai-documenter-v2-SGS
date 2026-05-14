import { afterEach, describe, expect, it, vi } from "vitest";
import { clearPromptCache, fetchPrompt } from "./fetch-prompt";

const BASE = "https://super-grader.test";
const OWNER = "ai_documenter";
const KEY = "ai_doc_transcript_cleanup_and_summary";
const TOKEN = "test-token";
const FALLBACK = "(default fallback prompt)";

afterEach(() => {
  clearPromptCache();
});

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("fetchPrompt", () => {
  it("returns the network body on 200", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse({ owner: OWNER, key: KEY, body: "hello", version: 7 }),
    );
    const out = await fetchPrompt({
      baseUrl: BASE,
      owner: OWNER,
      key: KEY,
      token: TOKEN,
      fallback: FALLBACK,
      fetch: fetchSpy,
    });
    expect(out.body).toBe("hello");
    expect(out.version).toBe(7);
    expect(out.source).toBe("network");
  });

  it("sends the correct URL with owner+key + Bearer token", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse({ owner: OWNER, key: KEY, body: "x", version: 1 }),
    );
    await fetchPrompt({
      baseUrl: BASE,
      owner: OWNER,
      key: KEY,
      token: TOKEN,
      fallback: FALLBACK,
      fetch: fetchSpy,
    });
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe(
      `${BASE}/api/prompts?owner=${OWNER}&key=${KEY}`,
    );
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: `Bearer ${TOKEN}`,
    });
  });

  it("returns cached body on subsequent calls within TTL (no second network)", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse({ owner: OWNER, key: KEY, body: "first", version: 1 }),
    );
    const a = await fetchPrompt({
      baseUrl: BASE,
      owner: OWNER,
      key: KEY,
      token: TOKEN,
      fallback: FALLBACK,
      fetch: fetchSpy,
      now: () => 1_000,
    });
    const b = await fetchPrompt({
      baseUrl: BASE,
      owner: OWNER,
      key: KEY,
      token: TOKEN,
      fallback: FALLBACK,
      fetch: fetchSpy,
      now: () => 1_500,
    });
    expect(a.source).toBe("network");
    expect(b.source).toBe("cache");
    expect(b.body).toBe("first");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("re-fetches after TTL expires", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ owner: OWNER, key: KEY, body: "old", version: 1 }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ owner: OWNER, key: KEY, body: "new", version: 2 }),
      );
    const a = await fetchPrompt({
      baseUrl: BASE,
      owner: OWNER,
      key: KEY,
      token: TOKEN,
      fallback: FALLBACK,
      ttlMs: 1000,
      fetch: fetchSpy,
      now: () => 0,
    });
    const b = await fetchPrompt({
      baseUrl: BASE,
      owner: OWNER,
      key: KEY,
      token: TOKEN,
      fallback: FALLBACK,
      ttlMs: 1000,
      fetch: fetchSpy,
      now: () => 1_500,
    });
    expect(a.body).toBe("old");
    expect(b.body).toBe("new");
    expect(b.source).toBe("network");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("on 404 returns fallback and does NOT cache", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(new Response("nope", { status: 404 }))
      .mockResolvedValueOnce(
        jsonResponse({ owner: OWNER, key: KEY, body: "real", version: 1 }),
      );
    const a = await fetchPrompt({
      baseUrl: BASE,
      owner: OWNER,
      key: KEY,
      token: TOKEN,
      fallback: FALLBACK,
      fetch: fetchSpy,
    });
    expect(a.body).toBe(FALLBACK);
    expect(a.version).toBeNull();
    expect(a.source).toBe("fallback");

    const b = await fetchPrompt({
      baseUrl: BASE,
      owner: OWNER,
      key: KEY,
      token: TOKEN,
      fallback: FALLBACK,
      fetch: fetchSpy,
    });
    // Second call must re-hit network (not cached miss).
    expect(b.body).toBe("real");
    expect(b.source).toBe("network");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("throws on 401 (config error)", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(new Response("nope", { status: 401 }));
    await expect(
      fetchPrompt({
        baseUrl: BASE,
        owner: OWNER,
        key: KEY,
        token: "wrong",
        fallback: FALLBACK,
        fetch: fetchSpy,
      }),
    ).rejects.toThrow(/401/);
  });

  it("on 5xx returns fallback (transient, don't cache)", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(new Response("oops", { status: 503 }));
    const out = await fetchPrompt({
      baseUrl: BASE,
      owner: OWNER,
      key: KEY,
      token: TOKEN,
      fallback: FALLBACK,
      fetch: fetchSpy,
    });
    expect(out.source).toBe("fallback");
    expect(out.body).toBe(FALLBACK);
  });

  it("on network failure returns fallback", async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const out = await fetchPrompt({
      baseUrl: BASE,
      owner: OWNER,
      key: KEY,
      token: TOKEN,
      fallback: FALLBACK,
      fetch: fetchSpy,
    });
    expect(out.source).toBe("fallback");
    expect(out.body).toBe(FALLBACK);
  });

  it("on malformed JSON body returns fallback", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response("<html>not json</html>", { status: 200 }),
    );
    const out = await fetchPrompt({
      baseUrl: BASE,
      owner: OWNER,
      key: KEY,
      token: TOKEN,
      fallback: FALLBACK,
      fetch: fetchSpy,
    });
    expect(out.source).toBe("fallback");
  });

  it("on schema-mismatch JSON returns fallback", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse({ owner: OWNER, key: KEY /* missing body, version */ }),
    );
    const out = await fetchPrompt({
      baseUrl: BASE,
      owner: OWNER,
      key: KEY,
      token: TOKEN,
      fallback: FALLBACK,
      fetch: fetchSpy,
    });
    expect(out.source).toBe("fallback");
  });

  it("does not cross-contaminate cache across (owner, key) pairs", async () => {
    const fetchSpy = vi.fn().mockImplementation((url: string) => {
      if (url.includes("key=a"))
        return Promise.resolve(
          jsonResponse({ owner: OWNER, key: "a", body: "A", version: 1 }),
        );
      if (url.includes("key=b"))
        return Promise.resolve(
          jsonResponse({ owner: OWNER, key: "b", body: "B", version: 1 }),
        );
      return Promise.resolve(new Response("nope", { status: 500 }));
    });
    const a = await fetchPrompt({
      baseUrl: BASE,
      owner: OWNER,
      key: "a",
      token: TOKEN,
      fallback: FALLBACK,
      fetch: fetchSpy,
    });
    const b = await fetchPrompt({
      baseUrl: BASE,
      owner: OWNER,
      key: "b",
      token: TOKEN,
      fallback: FALLBACK,
      fetch: fetchSpy,
    });
    expect(a.body).toBe("A");
    expect(b.body).toBe("B");
  });
});
