import { NextResponse, type NextRequest } from "next/server";
import { createAdminDbClient } from "@ai-documenter/db/admin";
import { syncTeacherCanvasData } from "@/lib/sync/canvas-sync";
import { autoInstallNewAssignmentsForTeacher } from "@/lib/sync/auto-install";
import { syncTeacherRosters } from "@/lib/sync/roster-sync";

// Nightly Canvas sync. Configured in vercel.json under `crons`. Vercel
// automatically attaches `Authorization: Bearer ${CRON_SECRET}` to scheduled
// invocations — we validate that header before doing any work so a leaked
// URL alone can't trigger the loop.
//
// Per teacher, in order:
//   1. Refresh `canvas_course_cache` + `canvas_assignment_cache` from Canvas.
//   2. For courses with `auto_install_new_assignments=true`, install the
//      reflection card on any newly-encountered published assignment.
//
// Local-dev: hit this with `Authorization: Bearer $CRON_SECRET` to test.
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
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const appBaseUrl = process.env.NEXT_PUBLIC_APP_URL;

  const admin = createAdminDbClient();
  const { data: teachers, error } = await admin
    .from("teachers")
    .select("id")
    .not("canvas_token_encrypted", "is", null);

  if (error) {
    return NextResponse.json(
      { ok: false, error: error.message },
      { status: 500 },
    );
  }

  const syncResults = [];
  const autoInstallResults = [];
  const rosterResults = [];
  for (const t of teachers ?? []) {
    const sync = await syncTeacherCanvasData(t.id);
    syncResults.push(sync);

    // Roster sync + auto-install only run when the cache refresh succeeded.
    // Otherwise we'd be operating on stale data.
    if (sync.ok) {
      rosterResults.push(await syncTeacherRosters(t.id));
      if (appBaseUrl) {
        autoInstallResults.push(
          await autoInstallNewAssignmentsForTeacher(t.id, appBaseUrl),
        );
      }
    }
  }

  const autoInstalledCount = autoInstallResults
    .filter((r): r is Extract<typeof r, { ok: true }> => r.ok)
    .reduce((sum, r) => sum + r.installed.length, 0);
  const autoFailedCount = autoInstallResults
    .filter((r): r is Extract<typeof r, { ok: true }> => r.ok)
    .reduce((sum, r) => sum + r.failures.length, 0);

  const rosterStudentCount = rosterResults
    .filter((r): r is Extract<typeof r, { ok: true }> => r.ok)
    .reduce((sum, r) => sum + r.totalStudents, 0);
  const rosterCourseCount = rosterResults
    .filter((r): r is Extract<typeof r, { ok: true }> => r.ok)
    .reduce((sum, r) => sum + r.coursesSynced, 0);

  return NextResponse.json({
    ok: true,
    syncedAt: new Date().toISOString(),
    teachersAttempted: syncResults.length,
    successes: syncResults.filter((r) => r.ok).length,
    failures: syncResults.filter((r) => !r.ok),
    autoInstall: {
      teachersSwept: autoInstallResults.length,
      assignmentsInstalled: autoInstalledCount,
      installFailures: autoFailedCount,
      details: autoInstallResults,
    },
    rosters: {
      teachersSwept: rosterResults.length,
      coursesSynced: rosterCourseCount,
      studentsCached: rosterStudentCount,
      details: rosterResults,
    },
  });
}
