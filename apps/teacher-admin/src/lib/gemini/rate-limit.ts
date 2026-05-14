import "server-only";

import { createAdminDbClient } from "@ai-documenter/db/admin";

export type RateLimitDecision = {
  allowed: boolean;
  callsToday: number;
  denialsToday: number;
  dailyCap: number;
};

/**
 * Per-teacher daily Gemini-call cap. Atomic check + increment via the
 * SECURITY DEFINER `check_and_increment_gemini_call` Postgres function.
 *
 * Defaults: `GEMINI_DEFAULT_DAILY_CAP` env var (typed as an integer) drives
 * the cap when a teacher has no `gemini_daily_cap` override. If neither is
 * set, falls back to 500 — generous for a normal day (each reflection is
 * 3 Gemini calls, so 500 ≈ 166 students per teacher per day).
 *
 * Called from every Gemini boundary in the app. If the function returns
 * `allowed: false`, the caller must NOT make the Gemini call.
 */
export async function checkAndReserveGeminiCall(
  teacherId: string,
): Promise<RateLimitDecision> {
  const admin = createAdminDbClient();
  const defaultCap = parseDefaultCap();

  const { data, error } = await admin
    .rpc("check_and_increment_gemini_call", {
      p_teacher_id: teacherId,
      p_default_cap: defaultCap,
    })
    .single();

  if (error || !data) {
    // The rate limiter should never block a real Gemini call due to a DB
    // hiccup — that would degrade UX for an issue the student can't help
    // with. Fail open and log. Sentry catches it via onRequestError.
    console.error(
      `[rate-limit] check_and_increment_gemini_call failed for teacher ${teacherId}: ${error?.message}`,
    );
    return {
      allowed: true,
      callsToday: 0,
      denialsToday: 0,
      dailyCap: defaultCap,
    };
  }

  return {
    allowed: data.allowed,
    callsToday: data.calls_today,
    denialsToday: data.denials_today,
    dailyCap: data.daily_cap,
  };
}

function parseDefaultCap(): number {
  const raw = process.env.GEMINI_DEFAULT_DAILY_CAP;
  if (!raw) return 500;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 500;
}

/** Shared error message format. Surfaced to the student verbatim. */
export function buildRateLimitMessage(decision: RateLimitDecision): string {
  return `Your teacher's class hit the daily Gemini-call limit (${decision.callsToday} of ${decision.dailyCap}). Try again tomorrow, or ask your teacher to extend the cap.`;
}
