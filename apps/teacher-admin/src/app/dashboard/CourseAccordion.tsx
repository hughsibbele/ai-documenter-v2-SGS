"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import {
  installOnAssignments,
  uninstallFromAssignments,
} from "@/lib/actions/canvas-install";
import { setCourseAutoInstall } from "@/lib/actions/course-policy";
import type { InstallActionResult } from "@/lib/actions/canvas-install.types";
import type {
  AssignmentWithInstall,
  CourseGroup,
  PromptOption,
} from "./dashboard.types";

// Persists the accordion's open state in sessionStorage so it survives the
// remount that revalidatePath triggers on the surrounding <Suspense>. Without
// this, every Install/Reinstall collapses the accordion the user was working
// in.
function useSessionFlag(key: string, initial: boolean) {
  const [value, setValue] = useState(initial);
  useEffect(() => {
    const raw = sessionStorage.getItem(key);
    if (raw === "1") setValue(true);
    else if (raw === "0") setValue(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- key is stable per accordion instance
  }, []);
  const setPersistent = (v: boolean) => {
    setValue(v);
    sessionStorage.setItem(key, v ? "1" : "0");
  };
  return [value, setPersistent] as const;
}

export function CourseAccordion({
  group,
  promptOptions,
}: {
  group: CourseGroup;
  promptOptions: PromptOption[];
}) {
  const { course, assignments, autoInstall, installedCount } = group;

  const [open, setOpen] = useSessionFlag(
    `dashboard:course-${course.canvas_course_id}:open`,
    false,
  );
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return assignments;
    return assignments.filter((a) => a.name.toLowerCase().includes(q));
  }, [assignments, search]);

  const allFilteredSelected =
    filtered.length > 0 && filtered.every((a) => selected.has(a.canvas_assignment_id));

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAllFiltered() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allFilteredSelected) {
        for (const a of filtered) next.delete(a.canvas_assignment_id);
      } else {
        for (const a of filtered) next.add(a.canvas_assignment_id);
      }
      return next;
    });
  }

  function clearSelection() {
    setSelected(new Set());
  }

  const isInactive = course.workflow_state !== "available";

  return (
    <section
      className={`rounded-md border bg-white transition-colors ${
        open
          ? "border-maroon/30 shadow-sm"
          : "border-stone-200 hover:border-stone-300"
      }`}
    >
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
        aria-expanded={open}
      >
        <div className="flex min-w-0 items-center gap-2">
          <Chevron open={open} />
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-stone-900">
              {course.name}
              {isInactive && (
                <span className="ml-2 text-[10px] font-normal uppercase tracking-wide text-stone-400">
                  {course.workflow_state}
                </span>
              )}
            </div>
            <div className="mt-0.5 truncate text-[11px] text-stone-500">
              {course.term_name ?? "No term"}
              {course.course_code && (
                <>
                  {" · "}
                  <span className="font-mono">{course.course_code}</span>
                </>
              )}
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2 text-[11px]">
          <span className="text-stone-600">
            {assignments.length}{" "}
            assignment{assignments.length === 1 ? "" : "s"}
          </span>
          {installedCount > 0 ? (
            <span className="rounded-full bg-emerald-100 px-2 py-0.5 font-medium text-emerald-800">
              {installedCount} installed
            </span>
          ) : (
            <span className="text-stone-400">none installed</span>
          )}
          {autoInstall && (
            <span className="rounded-full bg-maroon/10 px-2 py-0.5 font-medium text-maroon">
              auto-install
            </span>
          )}
        </div>
      </button>

      {open && (
        <div className="border-t border-stone-200">
          {assignments.length === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-stone-500">
              No assignments in this course yet.
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-3 border-b border-stone-100 px-4 py-2">
                <input
                  type="search"
                  placeholder="Search assignments…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="min-w-[200px] flex-1 rounded-md border border-stone-300 bg-white px-3 py-1.5 text-sm focus:border-maroon focus:outline-none focus:ring-1 focus:ring-maroon"
                />
                <span className="text-[11px] text-stone-500">
                  {filtered.length === assignments.length
                    ? `${assignments.length} total`
                    : `${filtered.length} of ${assignments.length}`}
                </span>
                <label className="ml-auto inline-flex cursor-pointer items-center gap-2 text-[11px] text-stone-600">
                  <input
                    type="checkbox"
                    checked={allFilteredSelected}
                    onChange={toggleAllFiltered}
                    disabled={filtered.length === 0}
                    className="h-3.5 w-3.5"
                  />
                  Select all visible
                </label>
              </div>

              {filtered.length === 0 ? (
                <div className="px-4 py-6 text-center text-sm text-stone-500">
                  No assignments match &ldquo;{search}&rdquo;.
                </div>
              ) : (
                <ul className="divide-y divide-stone-100">
                  {filtered.map((a) => (
                    <AssignmentRow
                      key={a.canvas_assignment_id}
                      assignment={a}
                      checked={selected.has(a.canvas_assignment_id)}
                      onToggle={() => toggle(a.canvas_assignment_id)}
                    />
                  ))}
                </ul>
              )}

              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-stone-100 bg-stone-50 px-4 py-2.5 text-xs">
                <AutoInstallToggle
                  courseId={course.canvas_course_id}
                  initial={autoInstall}
                />
                {selected.size > 0 ? (
                  <BulkActions
                    canvasCourseId={course.canvas_course_id}
                    selectedIds={Array.from(selected)}
                    selectedAssignments={filtered.filter((a) =>
                      selected.has(a.canvas_assignment_id),
                    )}
                    promptOptions={promptOptions}
                    onClearSelection={clearSelection}
                  />
                ) : (
                  <span className="text-stone-400">
                    Select assignments to install AI reflection.
                  </span>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}

function AssignmentRow({
  assignment,
  checked,
  onToggle,
}: {
  assignment: AssignmentWithInstall;
  checked: boolean;
  onToggle: () => void;
}) {
  const isInstalled = assignment.install?.status === "installed";
  const hasReflections = assignment.reflectionCount > 0;
  return (
    <li className="flex items-center gap-3 px-4 py-2 hover:bg-stone-50">
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        className="h-4 w-4 shrink-0"
      />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-stone-900">
          {assignment.name}
          {assignment.workflow_state !== "published" && (
            <span className="ml-2 text-[10px] font-normal uppercase tracking-wide text-stone-400">
              {assignment.workflow_state}
            </span>
          )}
        </div>
        <div className="text-[11px] text-stone-500">
          {formatDue(assignment.due_at)}
          {assignment.points_possible != null && (
            <> · {assignment.points_possible} pts</>
          )}
          {isInstalled && hasReflections && (
            <>
              {" · "}
              <Link
                href={`/dashboard/reviews/${assignment.canvas_course_id}/${assignment.canvas_assignment_id}`}
                className="text-dark-blue underline-offset-2 hover:underline"
              >
                View {assignment.reflectionCount} reflection
                {assignment.reflectionCount === 1 ? "" : "s"} →
              </Link>
            </>
          )}
        </div>
      </div>
      <InstallStatusBadge assignment={assignment} />
    </li>
  );
}

function InstallStatusBadge({
  assignment,
}: {
  assignment: AssignmentWithInstall;
}) {
  const { install, promptLabel } = assignment;
  if (!install || install.status === "uninstalled") {
    return (
      <span className="shrink-0 rounded-full border border-stone-300 px-2 py-0.5 text-[11px] text-stone-500">
        Not installed
      </span>
    );
  }
  if (install.status === "installed") {
    return (
      <span className="shrink-0 rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-800">
        Installed{promptLabel ? ` · ${promptLabel}` : ""}
      </span>
    );
  }
  return (
    <span
      className="shrink-0 rounded-full bg-red-100 px-2 py-0.5 text-[11px] font-medium text-red-800"
      title={install.last_error ?? undefined}
    >
      Failed
    </span>
  );
}

function AutoInstallToggle({
  courseId,
  initial,
}: {
  courseId: string;
  initial: boolean;
}) {
  const [on, setOn] = useState(initial);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <label className="inline-flex cursor-pointer items-center gap-2 text-stone-700">
      <input
        type="checkbox"
        checked={on}
        disabled={pending}
        onChange={(e) => {
          const next = e.target.checked;
          // Optimistic flip; revert on server error.
          setOn(next);
          setError(null);
          startTransition(async () => {
            const r = await setCourseAutoInstall(courseId, next);
            if (!r.ok) {
              setOn(!next);
              setError(r.message);
            }
          });
        }}
        className="h-3.5 w-3.5"
      />
      Auto-install on new assignments in this course
      {pending && <span className="text-[10px] italic text-stone-500">saving…</span>}
      {error && (
        <span className="text-[10px] italic text-red-700" title={error}>
          save failed
        </span>
      )}
    </label>
  );
}

function BulkActions({
  canvasCourseId,
  selectedIds,
  selectedAssignments,
  promptOptions,
  onClearSelection,
}: {
  canvasCourseId: string;
  selectedIds: string[];
  selectedAssignments: AssignmentWithInstall[];
  promptOptions: PromptOption[];
  onClearSelection: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<InstallActionResult | null>(null);
  const defaultId =
    promptOptions.find((p) => p.is_default)?.id ?? promptOptions[0]?.id ?? "";
  const [selectedPromptId, setSelectedPromptId] = useState<string>(defaultId);
  // M6.18a: 3-checkbox destination picker. Honor the first selected row's
  // saved destination ONLY when that row has actually been installed before
  // — otherwise the bar shows the per-app defaults. AID defaults: Drive ✓ +
  // Draft comment ✓ + Submission ✗. A teacher_assignments row may exist
  // (and carry a destination) even for never-installed assignments if
  // auto-install previously ran without the destination ever being chosen
  // explicitly; falling through to defaults gives the right initial state.
  const firstSelected = selectedAssignments[0];
  const useSaved = firstSelected?.install?.status === "installed";
  const firstSaved = useSaved ? firstSelected?.destination ?? null : null;
  const [postToDrive, setPostToDrive] = useState(firstSaved?.drive ?? true);
  const [postToComment, setPostToComment] = useState(firstSaved?.comment ?? true);
  const [postToSubmission, setPostToSubmission] = useState(
    firstSaved?.submission ?? false,
  );

  const someInstalled = selectedAssignments.some(
    (a) => a.install?.status === "installed",
  );

  function run(op: "install" | "uninstall") {
    setResult(null);
    startTransition(async () => {
      const r =
        op === "install"
          ? await installOnAssignments(
              canvasCourseId,
              selectedIds,
              selectedPromptId,
              {
                drive: postToDrive,
                comment: postToComment,
                submission: postToSubmission,
              },
            )
          : await uninstallFromAssignments(canvasCourseId, selectedIds);
      setResult(r);
      if (r.failureCount === 0) onClearSelection();
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="font-semibold text-stone-700">
        {selectedIds.length} selected
      </span>
      <label className="inline-flex items-center gap-1.5 text-stone-600">
        <span className="text-[11px] uppercase tracking-wide text-stone-500">
          Prompt
        </span>
        <select
          value={selectedPromptId}
          onChange={(e) => setSelectedPromptId(e.target.value)}
          disabled={pending || promptOptions.length === 0}
          className="rounded-md border border-stone-300 bg-white px-2 py-1 text-xs focus:border-maroon focus:outline-none focus:ring-1 focus:ring-maroon disabled:opacity-50"
        >
          {promptOptions.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
              {p.is_default ? " (Default)" : ""}
            </option>
          ))}
        </select>
      </label>
      <fieldset className="inline-flex items-center gap-3 text-stone-600">
        <legend className="text-[11px] uppercase tracking-wide text-stone-500">
          Reflection submitted to:
        </legend>
        <DestinationCheckbox
          label="Drive"
          checked={postToDrive}
          onChange={setPostToDrive}
          disabled={pending}
          title="Save the reflection to a Google Doc in your Drive folder. Writer ships with M7.3 — for now, this checkbox stores your preference and lights up when the writer goes live."
        />
        <DestinationCheckbox
          label="Canvas as draft comment"
          checked={postToComment}
          onChange={setPostToComment}
          disabled={pending}
          title="Post the reflection as a draft submission comment, visible to you in SpeedGrader. Lowest risk — never overwrites the student's actual submission."
        />
        <DestinationCheckbox
          label="Canvas as submission"
          checked={postToSubmission}
          onChange={setPostToSubmission}
          disabled={pending}
          title="Post the reflection as the student's submission body. Use only for assignments where the reflection IS the deliverable."
        />
      </fieldset>
      <button
        type="button"
        onClick={onClearSelection}
        disabled={pending}
        className="rounded-md px-2 py-1 text-stone-600 hover:bg-stone-100 disabled:opacity-50"
      >
        Cancel
      </button>
      {someInstalled && (
        <button
          type="button"
          onClick={() => run("uninstall")}
          disabled={pending}
          className="rounded-md border border-stone-300 px-3 py-1 font-semibold text-stone-700 hover:bg-stone-100 disabled:opacity-50"
        >
          {pending ? "Uninstalling…" : "Uninstall"}
        </button>
      )}
      <button
        type="button"
        onClick={() => run("install")}
        disabled={
          pending ||
          !selectedPromptId ||
          (!postToDrive && !postToComment && !postToSubmission)
        }
        className="rounded-md bg-maroon px-3 py-1 font-semibold text-white hover:bg-maroon-dark disabled:opacity-50"
        title={
          !postToDrive && !postToComment && !postToSubmission
            ? "Pick at least one destination."
            : undefined
        }
      >
        {pending
          ? "Installing…"
          : someInstalled
            ? "Reinstall"
            : "Install AI reflection"}
      </button>

      <p className="basis-full text-[11px] italic text-stone-500">
        {describeDestination({
          drive: postToDrive,
          comment: postToComment,
          submission: postToSubmission,
        })}
      </p>

      {result && result.failureCount > 0 && (
        <div className="basis-full text-[11px] text-red-700">
          {result.successCount > 0 &&
            `${result.successCount} succeeded · `}
          {result.failureCount} failed
          {result.results
            .filter((r) => !r.ok)
            .slice(0, 3)
            .map((r) => (
              <div key={r.canvasAssignmentId} className="ml-2">
                · {r.message}
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

function DestinationCheckbox({
  label,
  checked,
  onChange,
  disabled,
  title,
}: {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled: boolean;
  title: string;
}) {
  return (
    <label
      className="inline-flex items-center gap-1.5"
      title={title}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        disabled={disabled}
        className="h-3.5 w-3.5 rounded border-stone-300 accent-maroon disabled:opacity-50"
      />
      <span className="text-xs">{label}</span>
    </label>
  );
}

/** Plain-English summary of the chosen destination set. Drives the
 *  live hint line below the bulk-actions bar so the teacher sees what
 *  install will actually do before they click. */
function describeDestination(d: {
  drive: boolean;
  comment: boolean;
  submission: boolean;
}): string {
  const targets: string[] = [];
  if (d.drive) targets.push("a Google Doc in your Drive folder");
  if (d.comment) targets.push("a Canvas draft comment");
  if (d.submission) targets.push("the student's Canvas submission body");
  if (targets.length === 0) {
    return "Nothing checked — reflection won't be saved anywhere. Pick at least one destination.";
  }
  if (targets.length === 1) {
    return `Reflection will be saved to ${targets[0]}.`;
  }
  if (targets.length === 2) {
    return `Reflection will be saved to ${targets[0]} and ${targets[1]}.`;
  }
  return `Reflection will be saved to ${targets[0]}, ${targets[1]}, and ${targets[2]}.`;
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      aria-hidden
      width="14"
      height="14"
      viewBox="0 0 20 20"
      className={`shrink-0 text-stone-400 transition-transform ${
        open ? "rotate-90" : ""
      }`}
    >
      <path
        d="M7 5l6 5-6 5"
        stroke="currentColor"
        strokeWidth="1.5"
        fill="none"
        strokeLinecap="round"
      />
    </svg>
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
