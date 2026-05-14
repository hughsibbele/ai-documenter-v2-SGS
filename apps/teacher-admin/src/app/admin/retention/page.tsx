import { Suspense } from "react";
import { createAdminDbClient } from "@ai-documenter/db/admin";
import {
  loadReflectionsInScope,
  summarize,
} from "@/lib/retention/load";
import { RetentionPanel, type CourseOption } from "@/app/dashboard/retention/RetentionPanel";

export default async function AdminRetentionPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">
          School-wide retention
        </h1>
        <p className="mt-1 text-sm text-stone-600">
          Export and delete reflection data across the whole school. Use the
          per-course scope for surgical cleanup; use{" "}
          <span className="font-mono">Everyone (admin)</span> for an
          end-of-year sweep.
        </p>
      </div>

      <Suspense fallback={<Loading />}>
        <Body />
      </Suspense>
    </div>
  );
}

async function Body() {
  const admin = createAdminDbClient();

  // Admins need course options from every teacher. Drop dupes by
  // canvas_course_id — same course taught by multiple teachers (rare but
  // possible) collapses to one row in the picker; the action still scopes
  // by (teacher_id, canvas_course_id) on the backend.
  const { data: courses } = await admin
    .from("canvas_course_cache")
    .select("canvas_course_id, name, term_name")
    .order("name");

  const seen = new Set<string>();
  const courseOptions: CourseOption[] = [];
  for (const c of courses ?? []) {
    if (seen.has(c.canvas_course_id)) continue;
    seen.add(c.canvas_course_id);
    courseOptions.push({
      canvasCourseId: c.canvas_course_id,
      name: c.name,
      termName: c.term_name,
    });
  }

  const rows = await loadReflectionsInScope({ kind: "admin_all" });
  const summary = summarize(rows);

  return (
    <RetentionPanel
      allowedTargets={["all", "course"]}
      courses={courseOptions}
      initialSummary={summary}
      initialTarget="all"
    />
  );
}

function Loading() {
  return (
    <div className="space-y-3">
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="h-[120px] animate-pulse rounded-md border border-stone-200 bg-white"
        />
      ))}
    </div>
  );
}
