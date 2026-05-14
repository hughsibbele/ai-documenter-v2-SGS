import Link from "next/link";
import { Suspense } from "react";
import { getCurrentTeacher } from "@/lib/auth/teacher";
import { loadReviewsIndex } from "@/lib/reviews/load";

export default async function ReviewsIndexPage() {
  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <div className="flex items-baseline justify-between">
        <h1 className="text-xl font-semibold tracking-tight">Reviews</h1>
        <p className="text-xs text-stone-500">
          Read reflections by assignment. Newest activity first.
        </p>
      </div>

      <Suspense fallback={<ReviewsLoading />}>
        <ReviewsList />
      </Suspense>
    </div>
  );
}

async function ReviewsList() {
  const teacher = await getCurrentTeacher();
  const entries = await loadReviewsIndex(teacher.id);

  if (entries.length === 0) {
    return (
      <div className="rounded-md border border-stone-200 bg-white p-6 text-sm text-stone-600">
        <h2 className="text-base font-semibold text-stone-900">
          No reflections yet
        </h2>
        <p className="mt-2">
          Once students complete reflections on your installed assignments,
          they&apos;ll show up here.
        </p>
      </div>
    );
  }

  const byCourse = new Map<
    string,
    {
      courseName: string | null;
      courseCode: string | null;
      termName: string | null;
      entries: typeof entries;
    }
  >();
  for (const e of entries) {
    const bucket = byCourse.get(e.canvasCourseId);
    if (bucket) {
      bucket.entries.push(e);
    } else {
      byCourse.set(e.canvasCourseId, {
        courseName: e.courseName,
        courseCode: e.courseCode,
        termName: e.termName,
        entries: [e],
      });
    }
  }

  return (
    <div className="space-y-4">
      {Array.from(byCourse.entries()).map(([courseId, group]) => (
        <section
          key={courseId}
          className="rounded-md border border-stone-200 bg-white"
        >
          <header className="border-b border-stone-100 px-4 py-2.5">
            <div className="truncate text-sm font-semibold text-stone-900">
              {group.courseName ?? "(unnamed course)"}
            </div>
            <div className="mt-0.5 truncate text-[11px] text-stone-500">
              {group.termName ?? "No term"}
              {group.courseCode && (
                <>
                  {" · "}
                  <span className="font-mono">{group.courseCode}</span>
                </>
              )}
            </div>
          </header>
          <ul className="divide-y divide-stone-100">
            {group.entries.map((e) => (
              <li key={e.canvasAssignmentId}>
                <Link
                  href={`/dashboard/reviews/${e.canvasCourseId}/${e.canvasAssignmentId}`}
                  className="flex items-center gap-3 px-4 py-2.5 hover:bg-stone-50"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-stone-900">
                      {e.assignmentName ?? "(unnamed assignment)"}
                    </div>
                    <div className="text-[11px] text-stone-500">
                      {formatDue(e.dueAt)}
                    </div>
                  </div>
                  <CountBadges
                    total={e.totalReflections}
                    submitted={e.submittedCount}
                    failed={e.failedCount}
                    inProgress={e.inProgressCount}
                  />
                  <span className="text-stone-400" aria-hidden>
                    ›
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function CountBadges({
  total,
  submitted,
  failed,
  inProgress,
}: {
  total: number;
  submitted: number;
  failed: number;
  inProgress: number;
}) {
  return (
    <div className="flex shrink-0 items-center gap-1.5 text-[11px]">
      <span className="rounded-full bg-stone-100 px-2 py-0.5 font-medium text-stone-700">
        {total} total
      </span>
      {submitted > 0 && (
        <span className="rounded-full bg-emerald-100 px-2 py-0.5 font-medium text-emerald-800">
          {submitted} submitted
        </span>
      )}
      {failed > 0 && (
        <span className="rounded-full bg-red-100 px-2 py-0.5 font-medium text-red-800">
          {failed} failed
        </span>
      )}
      {inProgress > 0 && (
        <span className="rounded-full bg-amber-100 px-2 py-0.5 font-medium text-amber-800">
          {inProgress} in progress
        </span>
      )}
    </div>
  );
}

function ReviewsLoading() {
  return (
    <div className="space-y-2">
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="h-[80px] animate-pulse rounded-md border border-stone-200 bg-white"
        />
      ))}
    </div>
  );
}

function formatDue(due: string | null): string {
  if (!due) return "No due date";
  const d = new Date(due);
  return `Due ${d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  })}`;
}
