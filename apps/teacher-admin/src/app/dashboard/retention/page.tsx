import { Suspense } from "react";
import { getCurrentTeacher } from "@/lib/auth/teacher";
import { createAdminDbClient } from "@ai-documenter/db/admin";
import {
  loadReflectionsInScope,
  summarize,
} from "@/lib/retention/load";
import { RetentionPanel, type CourseOption } from "./RetentionPanel";

export default async function TeacherRetentionPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">
          Export & delete reflection data
        </h1>
        <p className="mt-1 text-sm text-stone-600">
          Download a copy first; then delete from the database if you want.
          Anything already submitted to Canvas remains in Canvas.
        </p>
      </div>

      <Suspense fallback={<Loading />}>
        <Body />
      </Suspense>
    </div>
  );
}

async function Body() {
  const teacher = await getCurrentTeacher();
  const admin = createAdminDbClient();

  const { data: courses } = await admin
    .from("canvas_course_cache")
    .select("canvas_course_id, name, term_name")
    .eq("teacher_id", teacher.id)
    .order("name");

  const courseOptions: CourseOption[] = (courses ?? []).map((c) => ({
    canvasCourseId: c.canvas_course_id,
    name: c.name,
    termName: c.term_name,
  }));

  const rows = await loadReflectionsInScope({
    kind: "teacher_all",
    teacherId: teacher.id,
  });
  const summary = summarize(rows);

  return (
    <RetentionPanel
      allowedTargets={["mine", "course"]}
      courses={courseOptions}
      initialSummary={summary}
      initialTarget="mine"
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
