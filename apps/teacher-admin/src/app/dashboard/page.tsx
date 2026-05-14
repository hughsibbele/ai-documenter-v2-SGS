import { Suspense } from "react";
import Link from "next/link";
import { getCurrentTeacher } from "@/lib/auth/teacher";
import { getServerDbClient } from "@/lib/supabase/server";
import { syncTeacherCanvasData } from "@/lib/sync/canvas-sync";
import { isActiveTerm } from "@/lib/sync/active-term";
import { loadReflectionCountsByAssignment } from "@/lib/reviews/load";
import { refreshCanvas } from "@/lib/actions/canvas-sync";
import { CourseAccordion } from "./CourseAccordion";
import { RefreshButton, SyncIndicator } from "./RefreshButton";
import type {
  AssignmentWithInstall,
  CourseGroup,
  PromptOption,
} from "./dashboard.types";

export default async function DashboardHome() {
  const teacher = await getCurrentTeacher();

  if (!teacher.canvas_token_encrypted) {
    return <ConnectCanvasPrompt />;
  }

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight">Your courses</h1>
        <RefreshWidget
          lastSyncedAt={teacher.last_canvas_sync_at}
        />
      </div>

      <Suspense fallback={<CoursesLoading firstLoad={!teacher.last_canvas_sync_at} />}>
        <CourseList teacherId={teacher.id} hasSyncedBefore={Boolean(teacher.last_canvas_sync_at)} />
      </Suspense>
    </div>
  );
}

// Pulled out of the dashboard layout's nav into the page body since it's
// contextual to /dashboard, not the other pages that share the layout. The
// button + sync indicator are client components that read useFormStatus()
// so they reflect pending state immediately on click — without waiting for
// the server action's revalidate.
function RefreshWidget({ lastSyncedAt }: { lastSyncedAt: string | null }) {
  return (
    <form action={refreshCanvas} className="flex items-center gap-2">
      <SyncIndicator lastSyncedAt={lastSyncedAt} />
      <RefreshButton />
    </form>
  );
}

async function CourseList({
  teacherId,
  hasSyncedBefore,
}: {
  teacherId: string;
  hasSyncedBefore: boolean;
}) {
  // First-load auto-sync: only on the very first dashboard visit.
  if (!hasSyncedBefore) {
    await syncTeacherCanvasData(teacherId);
  }

  const supabase = await getServerDbClient();
  const [
    coursesRes,
    assignmentsRes,
    installRes,
    policiesRes,
    teacherAssignmentsRes,
    promptsRes,
    reflectionCounts,
  ] = await Promise.all([
    supabase
      .from("canvas_course_cache")
      .select("*")
      .eq("teacher_id", teacherId),
    supabase
      .from("canvas_assignment_cache")
      .select("*")
      .eq("teacher_id", teacherId),
    supabase
      .from("assignment_install_state")
      .select("*")
      .eq("teacher_id", teacherId),
    supabase
      .from("course_install_policies")
      .select("*")
      .eq("teacher_id", teacherId),
    supabase
      .from("teacher_assignments")
      .select("canvas_assignment_id, prompt_id")
      .eq("teacher_id", teacherId),
    // RLS returns system prompts + this teacher's personal prompts.
    // Filter to reflection prompts — the objective-summary prompt is admin
    // infrastructure, not a teacher-pickable option.
    supabase
      .from("prompts")
      .select("id, label, is_default")
      .eq("purpose", "reflection")
      .order("is_default", { ascending: false })
      .order("label"),
    loadReflectionCountsByAssignment(teacherId),
  ]);

  const courses = coursesRes.data ?? [];
  const assignments = assignmentsRes.data ?? [];
  const installs = installRes.data ?? [];
  const policies = policiesRes.data ?? [];
  const teacherAssignments = teacherAssignmentsRes.data ?? [];
  const promptOptions: PromptOption[] = promptsRes.data ?? [];

  const installByAssignmentId = new Map(
    installs.map((i) => [i.canvas_assignment_id, i]),
  );
  const policyByCourseId = new Map(
    policies.map((p) => [p.canvas_course_id, p]),
  );
  const promptIdByCanvasAssignmentId = new Map(
    teacherAssignments.map((ta) => [ta.canvas_assignment_id, ta.prompt_id]),
  );
  const promptLabelById = new Map(
    promptOptions.map((p) => [p.id, p.label]),
  );

  const allGroups: CourseGroup[] = courses
    .map((course) => {
      const courseAssignments: AssignmentWithInstall[] = assignments
        .filter((a) => a.canvas_course_id === course.canvas_course_id)
        .map((a) => {
          const promptId = promptIdByCanvasAssignmentId.get(
            a.canvas_assignment_id,
          );
          return {
            ...a,
            install: installByAssignmentId.get(a.canvas_assignment_id) ?? null,
            promptLabel: promptId ? promptLabelById.get(promptId) ?? null : null,
            reflectionCount:
              reflectionCounts.get(a.canvas_assignment_id) ?? 0,
          };
        })
        .sort(byDueDateThenName);

      const installedCount = courseAssignments.filter(
        (a) => a.install?.status === "installed",
      ).length;

      return {
        course,
        assignments: courseAssignments,
        autoInstall:
          policyByCourseId.get(course.canvas_course_id)
            ?.auto_install_new_assignments ?? false,
        installedCount,
      };
    })
    .sort(byCourseStateThenName);

  const activeGroups = allGroups.filter((g) => isActiveTerm(g.course.term_name));
  const otherTerm = allGroups.filter((g) => !isActiveTerm(g.course.term_name));

  // Hide active-term courses with zero assignments — usually empty shells.
  // Surfaced in the Other section under their own sub-heading so they're
  // findable (e.g. brand-new course you just created in Canvas).
  const visibleActive = activeGroups.filter((g) => g.assignments.length > 0);
  const emptyActive = activeGroups.filter((g) => g.assignments.length === 0);

  if (allGroups.length === 0) {
    return <EmptyCoursesPrompt />;
  }

  return (
    <>
      {visibleActive.length > 0 ? (
        <div className="space-y-2">
          {visibleActive.map((g) => (
            <CourseAccordion
              key={g.course.canvas_course_id}
              group={g}
              promptOptions={promptOptions}
            />
          ))}
        </div>
      ) : (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          No active-term courses with assignments. If you teach a course this
          term, click <strong>Refresh</strong> in the header.
        </div>
      )}

      {(emptyActive.length > 0 || otherTerm.length > 0) && (
        <OtherCoursesSection
          emptyActive={emptyActive}
          otherTerm={otherTerm}
        />
      )}
    </>
  );
}

function OtherCoursesSection({
  emptyActive,
  otherTerm,
}: {
  emptyActive: CourseGroup[];
  otherTerm: CourseGroup[];
}) {
  const total = emptyActive.length + otherTerm.length;

  const byTerm = new Map<string, CourseGroup[]>();
  for (const g of otherTerm) {
    const k = g.course.term_name ?? "No term";
    if (!byTerm.has(k)) byTerm.set(k, []);
    byTerm.get(k)!.push(g);
  }
  const terms = Array.from(byTerm.entries()).sort(([a], [b]) =>
    b.localeCompare(a),
  );

  return (
    <details className="mt-8 rounded-md border border-stone-200 bg-stone-50 text-sm">
      <summary className="cursor-pointer list-none px-4 py-2.5 text-stone-600 hover:bg-stone-100">
        <span className="inline-flex items-center gap-2">
          <span className="text-stone-400">▸</span>
          Other courses ({total} course{total === 1 ? "" : "s"})
        </span>
      </summary>
      <div className="space-y-4 border-t border-stone-200 px-4 py-3">
        {emptyActive.length > 0 && (
          <div>
            <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-stone-500">
              Active term · no assignments yet
            </div>
            <p className="mb-1.5 text-[11px] text-stone-500">
              Hidden by default since there&apos;s nothing to install on. Add
              an assignment in Canvas, then click Refresh.
            </p>
            <ul className="space-y-0.5">
              {emptyActive.map((g) => (
                <li
                  key={g.course.canvas_course_id}
                  className="truncate text-xs text-stone-600"
                >
                  {g.course.name}
                  {g.course.course_code && (
                    <span className="ml-1.5 font-mono text-stone-400">
                      ({g.course.course_code})
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        {terms.length > 0 && (
          <div>
            <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-stone-500">
              Previous terms
            </div>
            <p className="mb-2 text-[11px] text-stone-500">
              Assignments aren&apos;t synced for these — install actions are
              unavailable. Listed in case you need to reference an older
              course.
            </p>
            <div className="space-y-3">
              {terms.map(([termName, list]) => (
                <div key={termName}>
                  <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-stone-400">
                    {termName}
                  </div>
                  <ul className="space-y-0.5">
                    {list.map((g) => (
                      <li
                        key={g.course.canvas_course_id}
                        className="truncate text-xs text-stone-600"
                      >
                        {g.course.name}
                        {g.course.course_code && (
                          <span className="ml-1.5 font-mono text-stone-400">
                            ({g.course.course_code})
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </details>
  );
}

function CoursesLoading({ firstLoad }: { firstLoad: boolean }) {
  return (
    <div className="space-y-2">
      {firstLoad && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <div className="font-medium">Pulling your Canvas data…</div>
          <p className="mt-1 text-xs text-amber-800">
            First-time setup — listing your courses and assignments. This may
            take 5–30 seconds depending on how many courses you teach. Future
            visits will be instant.
          </p>
        </div>
      )}
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="h-[68px] animate-pulse rounded-md border border-stone-200 bg-white"
        />
      ))}
    </div>
  );
}

function ConnectCanvasPrompt() {
  return (
    <div className="mx-auto max-w-xl py-12">
      <div className="rounded-md border border-amber-200 bg-amber-50 p-6 text-center">
        <h1 className="text-lg font-semibold text-amber-900">
          Connect Canvas first
        </h1>
        <p className="mt-2 text-sm text-amber-800">
          Paste a Canvas API token so we can pull your courses and install AI
          reflection on assignments you choose.
        </p>
        <Link
          href="/dashboard/setup"
          className="mt-4 inline-flex items-center justify-center rounded-md bg-maroon px-4 py-2 text-sm font-semibold text-white hover:bg-maroon-dark"
        >
          Open Canvas setup →
        </Link>
      </div>
    </div>
  );
}

function EmptyCoursesPrompt() {
  return (
    <div className="rounded-md border border-stone-200 bg-white p-6 text-center text-sm text-stone-600">
      <h2 className="text-base font-semibold text-stone-900">
        No courses found
      </h2>
      <p className="mt-2">
        Canvas didn&apos;t return any courses where you&apos;re a teacher. If
        you&apos;ve recently been added to a course, click <strong>Refresh</strong>{" "}
        in the header.
      </p>
    </div>
  );
}

function byCourseStateThenName(a: CourseGroup, b: CourseGroup): number {
  // Active courses first, then everything else; within group, alphabetical.
  const aActive = a.course.workflow_state === "available" ? 0 : 1;
  const bActive = b.course.workflow_state === "available" ? 0 : 1;
  if (aActive !== bActive) return aActive - bActive;
  return a.course.name.localeCompare(b.course.name);
}

function byDueDateThenName(
  a: AssignmentWithInstall,
  b: AssignmentWithInstall,
): number {
  // Installed assignments float to the top — those are the ones the teacher
  // is actively managing. Within each group: soonest due first; no due date
  // sorts to the bottom of its group.
  const aInstalled = a.install?.status === "installed" ? 0 : 1;
  const bInstalled = b.install?.status === "installed" ? 0 : 1;
  if (aInstalled !== bInstalled) return aInstalled - bInstalled;
  const aDue = a.due_at ? Date.parse(a.due_at) : Number.POSITIVE_INFINITY;
  const bDue = b.due_at ? Date.parse(b.due_at) : Number.POSITIVE_INFINITY;
  if (aDue !== bDue) return aDue - bDue;
  return a.name.localeCompare(b.name);
}
