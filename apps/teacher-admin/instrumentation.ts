import * as Sentry from "@sentry/nextjs";
import type { Instrumentation } from "next";
import { initSentry } from "@/lib/telemetry/sentry-init";

// Next 16 calls `register` once per server boot (Node + Edge). Branch on
// runtime so the right Sentry transport is set up.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    initSentry("node");
  } else if (process.env.NEXT_RUNTIME === "edge") {
    initSentry("edge");
  }
}

// Funnels server-action / route-handler errors into Sentry. No-op when DSN
// is unset (initSentry skipped → Sentry.captureRequestError is benign).
export const onRequestError: Instrumentation.onRequestError = (
  err,
  request,
  context,
) => {
  Sentry.captureRequestError(err, request, context);
};
