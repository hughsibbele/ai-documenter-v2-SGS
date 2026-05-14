"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { SerializedReflection } from "./page";
import { StudentCard } from "./StudentCard";

type Filter = "all" | "submitted" | "failed" | "in_progress";

export function ReviewClient({
  reflections,
  canvasHost,
  canvasCourseId,
  canvasAssignmentId,
}: {
  reflections: SerializedReflection[];
  canvasHost: string | null;
  canvasCourseId: string;
  canvasAssignmentId: string;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const cardRefs = useRef<Array<HTMLDivElement | null>>([]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return reflections.filter((r) => {
      if (filter === "submitted" && r.state !== "submitted") return false;
      if (filter === "failed" && r.state !== "failed") return false;
      if (
        filter === "in_progress" &&
        r.state !== "started" &&
        r.state !== "in_progress" &&
        r.state !== "completed"
      ) {
        return false;
      }
      if (!q) return true;
      return (
        r.student.displayName.toLowerCase().includes(q) ||
        r.student.email.toLowerCase().includes(q)
      );
    });
  }, [reflections, filter, search]);

  // Clamp the active index at read-time so a shrinking filtered set never
  // points off the end. We don't write back to state for the clamp — fewer
  // renders, no setState-in-effect.
  const effectiveIndex =
    filtered.length === 0 ? 0 : Math.min(activeIndex, filtered.length - 1);

  // j / k step through visible cards. Skip when the user is typing in an
  // input/textarea so search doesn't get hijacked.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }
      if (e.key !== "j" && e.key !== "k") return;
      if (filtered.length === 0) return;
      e.preventDefault();
      const next =
        e.key === "j"
          ? Math.min(effectiveIndex + 1, filtered.length - 1)
          : Math.max(effectiveIndex - 1, 0);
      setActiveIndex(next);
      cardRefs.current[next]?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [filtered.length, effectiveIndex]);

  function jumpTo(i: number) {
    setActiveIndex(i);
    cardRefs.current[i]?.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
  }

  const counts = useMemo(() => {
    let submitted = 0;
    let failed = 0;
    let inProgress = 0;
    for (const r of reflections) {
      if (r.state === "submitted") submitted += 1;
      else if (r.state === "failed") failed += 1;
      else inProgress += 1;
    }
    return { submitted, failed, inProgress, total: reflections.length };
  }, [reflections]);

  return (
    <div className="space-y-3">
      <div className="sticky top-0 z-10 -mx-1 flex flex-wrap items-center gap-2 border-b border-light-blue/40 bg-paper/95 px-1 py-2 backdrop-blur">
        <div className="flex items-center gap-1 text-xs">
          <FilterPill
            label={`All ${counts.total}`}
            active={filter === "all"}
            onClick={() => setFilter("all")}
          />
          <FilterPill
            label={`Submitted ${counts.submitted}`}
            active={filter === "submitted"}
            onClick={() => setFilter("submitted")}
            tone="emerald"
          />
          {counts.failed > 0 && (
            <FilterPill
              label={`Failed ${counts.failed}`}
              active={filter === "failed"}
              onClick={() => setFilter("failed")}
              tone="red"
            />
          )}
          {counts.inProgress > 0 && (
            <FilterPill
              label={`In progress ${counts.inProgress}`}
              active={filter === "in_progress"}
              onClick={() => setFilter("in_progress")}
              tone="amber"
            />
          )}
        </div>
        <input
          type="search"
          placeholder="Search by name…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="min-w-[180px] flex-1 rounded-md border border-stone-300 bg-white px-3 py-1.5 text-xs focus:border-maroon focus:outline-none focus:ring-1 focus:ring-maroon"
        />
        {filtered.length > 0 && (
          <StudentPicker
            current={effectiveIndex}
            entries={filtered}
            onSelect={jumpTo}
          />
        )}
        <span
          className="text-[10px] italic text-cool-gray"
          title="j to advance · k to go back"
        >
          j / k
        </span>
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-md border border-stone-200 bg-white p-6 text-center text-sm text-stone-600">
          No reflections match this filter.
        </div>
      ) : (
        <div className="space-y-4">
          {filtered.map((r, i) => (
            <div
              key={r.sessionId}
              id={`session-${r.sessionId}`}
              ref={(el) => {
                cardRefs.current[i] = el;
              }}
              data-active={i === effectiveIndex}
              className="scroll-mt-20"
            >
              <StudentCard
                reflection={r}
                index={i}
                total={filtered.length}
                canvasHost={canvasHost}
                canvasCourseId={canvasCourseId}
                canvasAssignmentId={canvasAssignmentId}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function FilterPill({
  label,
  active,
  onClick,
  tone,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  tone?: "emerald" | "red" | "amber";
}) {
  const toneClass = (() => {
    if (!active) return "border-stone-300 bg-white text-stone-600 hover:bg-stone-50";
    if (tone === "emerald") return "border-emerald-700 bg-emerald-700 text-white";
    if (tone === "red") return "border-red-700 bg-red-700 text-white";
    if (tone === "amber") return "border-amber-700 bg-amber-700 text-white";
    return "border-maroon bg-maroon text-white";
  })();
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors ${toneClass}`}
    >
      {label}
    </button>
  );
}

function StudentPicker({
  current,
  entries,
  onSelect,
}: {
  current: number;
  entries: SerializedReflection[];
  onSelect: (i: number) => void;
}) {
  return (
    <label className="inline-flex items-center gap-1.5 text-[11px] text-cool-gray">
      <span>
        {Math.min(current + 1, entries.length)} of {entries.length} · jump to
      </span>
      <select
        value={current}
        onChange={(e) => onSelect(Number(e.target.value))}
        className="max-w-[180px] truncate rounded-md border border-stone-300 bg-white px-2 py-1 text-xs focus:border-maroon focus:outline-none focus:ring-1 focus:ring-maroon"
      >
        {entries.map((r, i) => (
          <option key={r.sessionId} value={i}>
            {r.student.displayName}
          </option>
        ))}
      </select>
    </label>
  );
}
