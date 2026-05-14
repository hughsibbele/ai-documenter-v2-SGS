"use client";

import { useState, useTransition } from "react";
import {
  exportReflectionsCsv,
  hardDeleteReflections,
  type RetentionExportInput,
  type HardDeleteInput,
} from "@/lib/actions/retention";

export type CourseOption = {
  canvasCourseId: string;
  name: string;
  termName: string | null;
};

export type ScopeSummary = {
  totalSessions: number;
  byState: Record<string, number>;
  oldestCreatedAt: string | null;
  newestCreatedAt: string | null;
  courseCount: number;
};

type Target = "course" | "mine" | "all";

export function RetentionPanel({
  /** Which scopes the caller is allowed to target. Teachers get ["course",
   *  "mine"]; admins get ["course", "mine", "all"] (or just "all" on the
   *  admin page). */
  allowedTargets,
  courses,
  /** Pre-rendered summary for the "mine" or "all" default scope so the
   *  initial page render is informative without a client round-trip. */
  initialSummary,
  initialTarget = "mine",
}: {
  allowedTargets: Target[];
  courses: CourseOption[];
  initialSummary: ScopeSummary;
  initialTarget?: Target;
}) {
  const [target, setTarget] = useState<Target>(initialTarget);
  const [courseId, setCourseId] = useState<string>(
    courses[0]?.canvasCourseId ?? "",
  );
  const [beforeDate, setBeforeDate] = useState<string>("");
  const [confirmText, setConfirmText] = useState<string>("");

  const [exportPending, startExportTransition] = useTransition();
  const [deletePending, startDeleteTransition] = useTransition();
  const [feedback, setFeedback] = useState<
    | { kind: "info"; message: string }
    | { kind: "error"; message: string }
    | { kind: "success"; message: string }
    | null
  >(null);

  const requiresCourse = target === "course";
  const courseSelected = !requiresCourse || courseId.length > 0;

  function buildExportInput(): RetentionExportInput {
    return {
      target,
      canvasCourseId: requiresCourse ? courseId : undefined,
    };
  }

  function buildDeleteInput(): HardDeleteInput {
    return {
      target,
      canvasCourseId: requiresCourse ? courseId : undefined,
      beforeDate: beforeDate || undefined,
      confirmText,
    };
  }

  function runExport() {
    setFeedback(null);
    startExportTransition(async () => {
      const r = await exportReflectionsCsv(buildExportInput());
      if (!r.ok) {
        setFeedback({ kind: "error", message: r.message });
        return;
      }
      triggerCsvDownload(r.csv, r.filename);
      setFeedback({
        kind: "success",
        message: `Downloaded ${r.rowCount} reflection${r.rowCount === 1 ? "" : "s"} as ${r.filename}.`,
      });
    });
  }

  function runDelete() {
    setFeedback(null);
    startDeleteTransition(async () => {
      const r = await hardDeleteReflections(buildDeleteInput());
      if (!r.ok) {
        setFeedback({ kind: "error", message: r.message });
        return;
      }
      setFeedback({
        kind: "success",
        message: `Permanently deleted ${r.deletedCount} reflection${r.deletedCount === 1 ? "" : "s"}.`,
      });
      setConfirmText("");
    });
  }

  return (
    <div className="space-y-6">
      <div className="rounded-md border border-stone-200 bg-white p-4">
        <h2 className="text-sm font-semibold text-stone-900">Scope</h2>
        <p className="mt-1 text-xs text-stone-600">
          Pick what to export or delete. Admin scope (
          <span className="font-mono">all</span>) includes every reflection in
          the system.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          {allowedTargets.includes("mine") && (
            <RadioPill
              label="All of my courses"
              checked={target === "mine"}
              onChange={() => setTarget("mine")}
            />
          )}
          {allowedTargets.includes("course") && (
            <RadioPill
              label="Just one course"
              checked={target === "course"}
              onChange={() => setTarget("course")}
            />
          )}
          {allowedTargets.includes("all") && (
            <RadioPill
              label="Everyone (admin)"
              checked={target === "all"}
              onChange={() => setTarget("all")}
              tone="dark-blue"
            />
          )}
        </div>
        {requiresCourse && (
          <div className="mt-3">
            <label className="block text-[11px] font-medium uppercase tracking-wide text-stone-500">
              Course
            </label>
            <select
              value={courseId}
              onChange={(e) => setCourseId(e.target.value)}
              className="mt-1 w-full max-w-md rounded-md border border-stone-300 bg-white px-2 py-1.5 text-sm focus:border-maroon focus:outline-none focus:ring-1 focus:ring-maroon"
            >
              {courses.map((c) => (
                <option key={c.canvasCourseId} value={c.canvasCourseId}>
                  {c.name}
                  {c.termName ? ` — ${c.termName}` : ""}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      <ScopeSummaryCard summary={initialSummary} target={initialTarget} />

      <div className="rounded-md border border-stone-200 bg-white p-4">
        <h2 className="text-sm font-semibold text-stone-900">
          1. Export to CSV
        </h2>
        <p className="mt-1 text-xs text-stone-600">
          Save a copy first. Re-runnable any time; nothing is changed by the
          export.
        </p>
        <div className="mt-3">
          <button
            type="button"
            disabled={exportPending || !courseSelected}
            onClick={runExport}
            className="rounded-md border border-stone-300 bg-white px-3 py-1.5 text-xs font-semibold text-stone-700 hover:bg-stone-50 disabled:opacity-50"
          >
            {exportPending ? "Exporting…" : "Download CSV"}
          </button>
        </div>
      </div>

      <div className="rounded-md border border-red-200 bg-red-50 p-4">
        <h2 className="text-sm font-semibold text-red-900">
          2. Hard delete (irreversible)
        </h2>
        <p className="mt-1 text-xs text-red-900/80">
          Deletes the reflection sessions and their submission attempts from
          our database. Anything already submitted to Canvas stays in Canvas.
        </p>

        <div className="mt-3 space-y-3">
          <div>
            <label className="block text-[11px] font-medium uppercase tracking-wide text-red-900/70">
              Only delete sessions created before (optional)
            </label>
            <input
              type="date"
              value={beforeDate}
              onChange={(e) => setBeforeDate(e.target.value)}
              className="mt-1 rounded-md border border-red-300 bg-white px-2 py-1.5 text-xs focus:border-red-600 focus:outline-none focus:ring-1 focus:ring-red-600"
            />
            <p className="mt-1 text-[10px] text-red-900/70">
              Leave blank to delete every session in scope, regardless of date.
            </p>
          </div>
          <div>
            <label className="block text-[11px] font-medium uppercase tracking-wide text-red-900/70">
              Type <span className="font-mono">DELETE</span> to confirm
            </label>
            <input
              type="text"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder="DELETE"
              className="mt-1 w-40 rounded-md border border-red-300 bg-white px-2 py-1.5 text-xs font-mono focus:border-red-600 focus:outline-none focus:ring-1 focus:ring-red-600"
            />
          </div>
          <button
            type="button"
            disabled={
              deletePending ||
              confirmText !== "DELETE" ||
              !courseSelected
            }
            onClick={runDelete}
            className="rounded-md bg-red-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-800 disabled:opacity-50"
          >
            {deletePending ? "Deleting…" : "Permanently delete"}
          </button>
        </div>
      </div>

      {feedback && (
        <div
          className={`rounded-md border p-3 text-xs ${
            feedback.kind === "error"
              ? "border-red-200 bg-red-50 text-red-900"
              : feedback.kind === "success"
                ? "border-emerald-200 bg-emerald-50 text-emerald-900"
                : "border-stone-200 bg-stone-50 text-stone-800"
          }`}
        >
          {feedback.message}
        </div>
      )}
    </div>
  );
}

function RadioPill({
  label,
  checked,
  onChange,
  tone,
}: {
  label: string;
  checked: boolean;
  onChange: () => void;
  tone?: "dark-blue";
}) {
  const activeClass =
    tone === "dark-blue"
      ? "border-dark-blue bg-dark-blue text-white"
      : "border-maroon bg-maroon text-white";
  return (
    <button
      type="button"
      onClick={onChange}
      className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
        checked
          ? activeClass
          : "border-stone-300 bg-white text-stone-600 hover:bg-stone-50"
      }`}
    >
      {label}
    </button>
  );
}

function ScopeSummaryCard({
  summary,
  target,
}: {
  summary: ScopeSummary;
  target: Target;
}) {
  return (
    <div className="rounded-md border border-stone-200 bg-stone-50 p-4 text-xs">
      <h2 className="text-sm font-semibold text-stone-900">
        Current scope summary
      </h2>
      <p className="mt-1 text-stone-600">
        Re-render the page after changing scope above to refresh these
        numbers. The CSV export and delete actions always reflect the latest
        live state, not this snapshot.
      </p>
      <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat
          label="Sessions"
          value={summary.totalSessions.toLocaleString()}
        />
        <Stat
          label="Courses"
          value={summary.courseCount.toLocaleString()}
        />
        <Stat
          label="Oldest"
          value={formatShortDate(summary.oldestCreatedAt)}
        />
        <Stat
          label="Newest"
          value={formatShortDate(summary.newestCreatedAt)}
        />
      </dl>
      {Object.keys(summary.byState).length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {Object.entries(summary.byState).map(([state, count]) => (
            <span
              key={state}
              className="rounded-full bg-white px-2 py-0.5 text-[10px] text-stone-700 ring-1 ring-stone-200"
            >
              {state} {count}
            </span>
          ))}
        </div>
      )}
      <p className="mt-3 text-[10px] italic text-stone-500">
        Showing snapshot for default scope ({target}). Switching scope above
        doesn&apos;t re-query this card.
      </p>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-wide text-stone-500">
        {label}
      </dt>
      <dd className="mt-0.5 text-sm font-medium text-stone-900">{value}</dd>
    </div>
  );
}

function formatShortDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function triggerCsvDownload(csv: string, filename: string) {
  // Prepend UTF-8 BOM so Excel-on-Windows picks up the encoding without the
  // user having to fiddle with import dialogs.
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
