"use client";

import Link from "next/link";

export function PreviewBanner({ teacherName }: { teacherName: string }) {
  return (
    <div className="fixed top-0 inset-x-0 z-50 bg-amber-100 border-b border-amber-300 px-4 py-2 text-sm text-amber-900 flex items-center justify-between gap-4">
      <span>
        <strong>Preview mode</strong> — {teacherName} (teacher). No data will
        be saved to the gradebook or pushed to Canvas.
      </span>
      <Link
        href="/dashboard"
        className="rounded border border-amber-500 px-2 py-0.5 text-xs font-medium hover:bg-amber-200"
      >
        Exit preview
      </Link>
    </div>
  );
}

export function PreviewCompletionLabel() {
  return (
    <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
      <p className="font-medium">Preview output</p>
      <p className="mt-1 text-xs">
        This is what the student sees, and what you&apos;d see when grading. No
        data was sent to Canvas, Drive, or super-grader.
      </p>
    </div>
  );
}
