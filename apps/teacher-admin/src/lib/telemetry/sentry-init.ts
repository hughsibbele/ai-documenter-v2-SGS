import * as Sentry from "@sentry/nextjs";

/**
 * Initialize Sentry once per process (or browser session). The DSN env var
 * gates activation: when `SENTRY_DSN` (server) or `NEXT_PUBLIC_SENTRY_DSN`
 * (client) is empty/unset, this is a no-op — no init, no events, no perf
 * overhead. That's the local-dev / preview-without-Sentry shape.
 *
 * Called from `instrumentation.ts` (server + edge) and
 * `instrumentation-client.ts` (browser).
 *
 * Tracing is deliberately off in production until we have a baseline cost
 * shape for performance events — `tracesSampleRate: 0`. Error events are
 * what we actually need.
 */
export function initSentry(runtime: "node" | "edge" | "browser") {
  const dsn =
    runtime === "browser"
      ? process.env.NEXT_PUBLIC_SENTRY_DSN
      : process.env.SENTRY_DSN ?? process.env.NEXT_PUBLIC_SENTRY_DSN;

  if (!dsn) return;

  Sentry.init({
    dsn,
    environment:
      process.env.VERCEL_ENV ??
      process.env.NODE_ENV ??
      "development",
    release: process.env.VERCEL_GIT_COMMIT_SHA,
    tracesSampleRate: 0,
    // The teacher's Canvas token is in @scope state during install — never
    // attach request bodies until we have a redaction story for that.
    sendDefaultPii: false,
    // Surface our own runtime tag so server vs edge vs client filtering is
    // trivial in the Sentry UI.
    initialScope: { tags: { runtime } },
  });
}
