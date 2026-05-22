import { NextResponse, type NextRequest } from "next/server";
import { createAdminDbClient } from "@ai-documenter/db/admin";

// Phase 3 of REMEDIATION_PLAN.md — stale-session sweep.
//
// Two passes, both idempotent + state-fenced:
//
//   1. Auto-archive stuck sessions: state IN ('in_progress','completed')
//      AND created_at < now() - 14 days  →  state='archived'. A student
//      who abandoned a tab mid-conversation 3 weeks ago doesn't block
//      a fresh intake (Phase 2's partial unique index excludes 'archived'
//      so the student's next visit creates a new session). Also clears
//      the /api/super-grader/result endpoint's "is_finalized=false but
//      has created_at" half-empty-envelope problem (Phase 7 will tighten
//      that endpoint with .in("state", ["submitted"])).
//
//   2. Hard-delete expired finalized sessions: state IN ('submitted',
//      'failed','archived') AND expires_at < now(). The `expires_at`
//      column was set at session creation (default now() + 1 year) and
//      until Phase 3 had no consumer — CLAUDE.md committed to
//      "Retention: one academic year. End-of-year sweep clears reflection
//      data." but no cron ever ran the sweep. This is the consumer.
//      State fence prevents nuking a still-active session whose
//      expires_at boundary crosses while it's mid-conversation (extremely
//      unlikely with the 1-year default, but the fence is cheap).
//
// Registered in vercel.json under `crons`. Vercel automatically attaches
// `Authorization: Bearer ${CRON_SECRET}` to scheduled invocations.

const STALE_GRACE_DAYS = 14;

export async function GET(request: NextRequest) {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    return NextResponse.json(
      { ok: false, error: "CRON_SECRET not configured" },
      { status: 500 },
    );
  }

  const auth = request.headers.get("authorization");
  if (auth !== `Bearer ${expected}`) {
    return NextResponse.json(
      { ok: false, error: "unauthorized" },
      { status: 401 },
    );
  }

  const admin = createAdminDbClient();
  const now = new Date();
  const staleCutoff = new Date(
    now.getTime() - STALE_GRACE_DAYS * 86_400_000,
  ).toISOString();
  const nowIso = now.toISOString();

  // Pass 1: archive stuck sessions.
  const { data: archived, error: archErr } = await admin
    .from("reflection_sessions")
    .update({ state: "archived" })
    .in("state", ["in_progress", "completed"])
    .lt("created_at", staleCutoff)
    .select("id");
  if (archErr) {
    console.error("[sweep-sessions] archive failed:", archErr.message);
    return NextResponse.json(
      { ok: false, step: "archive", error: archErr.message },
      { status: 500 },
    );
  }

  // Pass 2: hard-delete expired terminal sessions.
  const { data: deleted, error: delErr } = await admin
    .from("reflection_sessions")
    .delete()
    .in("state", ["submitted", "failed", "archived"])
    .lt("expires_at", nowIso)
    .select("id");
  if (delErr) {
    console.error("[sweep-sessions] delete failed:", delErr.message);
    return NextResponse.json(
      {
        ok: false,
        step: "delete",
        archived: archived?.length ?? 0,
        error: delErr.message,
      },
      { status: 500 },
    );
  }

  const archivedCount = archived?.length ?? 0;
  const deletedCount = deleted?.length ?? 0;
  if (archivedCount > 0 || deletedCount > 0) {
    console.log(
      `[sweep-sessions] archived=${archivedCount} deleted=${deletedCount} staleCutoff=${staleCutoff}`,
    );
  }

  return NextResponse.json({
    ok: true,
    archived: archivedCount,
    deleted: deletedCount,
    staleCutoff,
    expiredBefore: nowIso,
  });
}
