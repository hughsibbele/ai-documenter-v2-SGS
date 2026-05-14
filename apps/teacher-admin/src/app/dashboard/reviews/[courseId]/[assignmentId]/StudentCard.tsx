"use client";

import type { SerializedReflection } from "./page";
import { ResendButton } from "./ResendButton";

const TIME_SPENT_LABELS: Record<string, string> = {
  lt15: "< 15 min",
  "15_30": "15–30 min",
  "30_45": "30–45 min",
  "45_60": "45–60 min",
  "1_2h": "1–2 hours",
  gt2h: "> 2 hours",
};

export function StudentCard({
  reflection: r,
  index,
  total,
  canvasHost,
  canvasCourseId,
  canvasAssignmentId,
}: {
  reflection: SerializedReflection;
  index: number;
  total: number;
  canvasHost: string | null;
  canvasCourseId: string;
  canvasAssignmentId: string;
}) {
  const canvasSubmissionUrl =
    canvasHost && r.canvasSubmissionId && r.student.canvasUserId
      ? `https://${canvasHost}/courses/${canvasCourseId}/assignments/${canvasAssignmentId}/submissions/${r.student.canvasUserId}`
      : null;

  const submittedTime = r.submittedAt
    ? new Date(r.submittedAt).toLocaleString()
    : r.completedAt
      ? new Date(r.completedAt).toLocaleString()
      : null;

  const tools = uniqueTools(r);
  const lastFailed =
    r.latestAttempt && r.latestAttempt.success === false ? true : false;

  return (
    <article className="rounded-md border border-stone-200 bg-white shadow-sm">
      <header className="flex flex-wrap items-baseline justify-between gap-3 border-b border-stone-100 px-5 py-3">
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-wide text-cool-gray">
            {index + 1} of {total}
          </div>
          <h2 className="mt-0.5 truncate text-base font-semibold text-stone-900">
            {r.student.displayName}
          </h2>
          <div className="mt-0.5 truncate text-[11px] italic text-cool-gray">
            {r.student.email}
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-1.5 text-[11px]">
          <StateBadge state={r.state} />
          {r.timeSpent && (
            <span className="rounded-full bg-stone-100 px-2 py-0.5 text-stone-700">
              {TIME_SPENT_LABELS[r.timeSpent] ?? r.timeSpent}
            </span>
          )}
          {tools.length > 0 && (
            <span className="rounded-full bg-light-blue/40 px-2 py-0.5 text-dark-blue">
              {tools.join(", ")}
            </span>
          )}
        </div>
      </header>

      <div className="space-y-5 px-5 py-4">
        {submittedTime && (
          <div className="text-[11px] italic text-cool-gray">
            {r.state === "submitted"
              ? `Submitted ${submittedTime}`
              : `Completed ${submittedTime}`}
          </div>
        )}

        {(r.aiChats.length > 0 || (r.pasteFallback?.trim().length ?? 0) > 0) && (
          <AiTranscriptDetails
            aiChats={r.aiChats}
            pasteFallback={r.pasteFallback}
          />
        )}

        {r.firstDraft && (
          <Section title="First-draft reflection">
            <Paragraphs text={r.firstDraft} />
          </Section>
        )}

        {r.objectiveSummary && (
          <Section title="Objective summary">
            <Paragraphs text={r.objectiveSummary} />
          </Section>
        )}

        {r.reflectionMessages.length > 0 && (
          <Section title="Reflection conversation">
            <ConversationTurns messages={r.reflectionMessages} />
          </Section>
        )}

        <footer className="flex flex-wrap items-center gap-3 border-t border-stone-100 pt-3 text-[11px]">
          {canvasSubmissionUrl ? (
            <a
              href={canvasSubmissionUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-cool-gray underline-offset-2 hover:text-maroon hover:underline"
            >
              Open in Canvas ↗
            </a>
          ) : (
            <span className="text-cool-gray">No Canvas submission yet</span>
          )}
          {r.state !== "submitted" && r.completionCode && (
            <span
              className="font-mono text-[10px] text-cool-gray"
              title="6-char completion code (fallback when auto-submit failed)"
            >
              code · {r.completionCode}
            </span>
          )}
          {lastFailed && (
            <ResendButton
              sessionId={r.sessionId}
              error={r.latestAttempt?.error ?? null}
            />
          )}
        </footer>
      </div>
    </article>
  );
}

function StateBadge({ state }: { state: SerializedReflection["state"] }) {
  const tone =
    state === "submitted"
      ? "bg-emerald-100 text-emerald-800"
      : state === "failed"
        ? "bg-red-100 text-red-800"
        : state === "completed"
          ? "bg-amber-100 text-amber-800"
          : "bg-stone-100 text-stone-700";
  const label =
    state === "in_progress" ? "In progress" : capitalize(state.replace("_", " "));
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${tone}`}
    >
      {label}
    </span>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h3 className="ehs-eyebrow mb-1.5">{title}</h3>
      <div className="text-sm leading-relaxed text-ink">{children}</div>
    </section>
  );
}

function Paragraphs({ text }: { text: string }) {
  const blocks = text
    .trim()
    .split(/\n\s*\n/)
    .filter((b) => b.length > 0);
  return (
    <>
      {blocks.map((block, i) => (
        <p key={i} className="mb-2 last:mb-0">
          {block.split(/\n/).map((line, j, arr) => (
            <span key={j}>
              {line}
              {j < arr.length - 1 && <br />}
            </span>
          ))}
        </p>
      ))}
    </>
  );
}

function ConversationTurns({
  messages,
}: {
  messages: { role: "ai" | "student"; text: string; ts: string }[];
}) {
  return (
    <div className="space-y-3">
      {messages.map((m, i) => (
        <div
          key={i}
          className={
            m.role === "ai"
              ? "rounded-md border-l-2 border-maroon/40 bg-stone-50 px-3 py-2"
              : "rounded-md border-l-2 border-dark-blue/40 bg-light-blue/15 px-3 py-2"
          }
        >
          <div className="mb-1 text-[10px] uppercase tracking-wide text-cool-gray">
            {m.role === "ai" ? "Reflection Partner" : "Student"}
          </div>
          <Paragraphs text={m.text} />
        </div>
      ))}
    </div>
  );
}

function AiTranscriptDetails({
  aiChats,
  pasteFallback,
}: {
  aiChats: { tool: string; url: string; transcript_text: string | null }[];
  pasteFallback: string | null;
}) {
  const rows = aiChats.filter((c) => c.url || c.transcript_text);
  const pasted = (pasteFallback ?? "").trim();
  return (
    <details className="group rounded-md border border-stone-200 bg-stone-50">
      <summary className="cursor-pointer list-none px-3 py-2 text-xs text-stone-600 hover:bg-stone-100">
        <span className="inline-flex items-center gap-2">
          <span className="text-stone-400 transition-transform group-open:rotate-90">
            ▸
          </span>
          AI transcript
          {rows.length > 0 && (
            <span className="text-[10px] italic text-cool-gray">
              {rows.length} link{rows.length === 1 ? "" : "s"}
            </span>
          )}
        </span>
      </summary>
      <div className="space-y-3 border-t border-stone-200 px-3 py-3 text-xs">
        {rows.length > 0 && (
          <ul className="space-y-1">
            {rows.map((c, i) => (
              <li key={i}>
                <strong className="text-stone-700">
                  {capitalize(c.tool)}:
                </strong>{" "}
                <a
                  href={c.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="break-all text-dark-blue underline-offset-2 hover:underline"
                >
                  {c.url}
                </a>
              </li>
            ))}
          </ul>
        )}
        {pasted.length > 0 && (
          <div>
            <div className="ehs-eyebrow mb-1">Pasted transcript</div>
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-md border border-stone-200 bg-white p-2 font-serif text-[12px] leading-relaxed text-ink">
              {pasted}
            </pre>
          </div>
        )}
      </div>
    </details>
  );
}

function uniqueTools(r: SerializedReflection): string[] {
  const seen = new Set<string>();
  for (const c of r.aiChats) if (c.tool) seen.add(capitalize(c.tool));
  return Array.from(seen);
}

function capitalize(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}
