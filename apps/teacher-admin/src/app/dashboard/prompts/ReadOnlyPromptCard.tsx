import Link from "next/link";
import type { Tables } from "@ai-documenter/db";

type Prompt = Tables<"prompts">;

// Read-only view used to surface system prompts to non-admin teachers.
// Shows the student-facing question prominently (that's what their students
// actually see), then the coach instructions as a non-editable block.

export function ReadOnlyPromptCard({
  prompt,
  assignmentsUsing,
  policiesUsing,
}: {
  prompt: Prompt;
  assignmentsUsing: number;
  policiesUsing: number;
}) {
  return (
    <section className="rounded-sm border border-stone-200 bg-stone-50 shadow-sm">
      <header className="flex flex-wrap items-center gap-3 border-b border-stone-200 px-4 py-3">
        <div className="text-base font-semibold text-stone-900">
          {prompt.label}
        </div>
        {prompt.is_default && (
          <span className="rounded-full bg-dark-blue/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-dark-blue">
            Default
          </span>
        )}
        <span className="rounded-full border border-stone-300 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-stone-500">
          School-wide
        </span>
        <div className="text-[11px] text-stone-500">
          You use this on {assignmentsUsing} assignment
          {assignmentsUsing === 1 ? "" : "s"}
          {policiesUsing > 0 && (
            <> · default for {policiesUsing} of your courses</>
          )}
        </div>
        <Link
          href={`/dashboard/prompts/${prompt.id}/preview`}
          className="rounded-sm border border-stone-300 bg-white px-2.5 py-1 text-xs font-medium text-stone-700 transition-colors hover:border-maroon hover:text-maroon"
        >
          Preview
        </Link>
      </header>

      <div className="space-y-4 px-4 py-3">
        {prompt.student_facing_question && (
          <div>
            <div className="ehs-eyebrow mb-1.5 text-stone-500">
              Student-facing question
            </div>
            <blockquote className="border-l-2 border-maroon/60 py-1 pl-3 font-document text-sm italic leading-relaxed text-ink">
              {prompt.student_facing_question}
            </blockquote>
          </div>
        )}

        <div>
          <div className="ehs-eyebrow mb-1.5 text-stone-500">
            Coach instructions
          </div>
          <pre className="max-h-[240px] overflow-auto whitespace-pre-wrap break-words rounded-sm border border-stone-200 bg-white px-3 py-2 font-mono text-xs leading-relaxed text-stone-700">
            {prompt.body}
          </pre>
        </div>
      </div>
    </section>
  );
}
