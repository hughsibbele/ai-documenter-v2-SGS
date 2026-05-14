"use client";

import { useState, useTransition } from "react";
import type { Tables } from "@ai-documenter/db";
import {
  saveSystemPrompt,
  deleteSystemPrompt,
} from "@/lib/actions/system-prompts";

type Prompt = Tables<"prompts">;

export function SystemPromptCard({
  prompt,
  assignmentsUsing,
  policiesUsing,
}: {
  prompt: Prompt;
  assignmentsUsing: number;
  policiesUsing: number;
}) {
  const [label, setLabel] = useState(prompt.label);
  const [studentFacingQuestion, setStudentFacingQuestion] = useState(
    prompt.student_facing_question ?? "",
  );
  const [body, setBody] = useState(prompt.body);
  const [pending, startTransition] = useTransition();
  const [feedback, setFeedback] = useState<
    | null
    | { kind: "ok"; message: string }
    | { kind: "error"; message: string }
  >(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const dirty =
    label !== prompt.label ||
    body !== prompt.body ||
    studentFacingQuestion !== (prompt.student_facing_question ?? "");

  // Objective-summary prompts have no student-facing question (they're admin
  // infrastructure, never shown to students).
  const isSummary = prompt.purpose === "objective_summary";

  function onSave() {
    setFeedback(null);
    startTransition(async () => {
      const r = await saveSystemPrompt(prompt.id, {
        label: label !== prompt.label ? label : undefined,
        body: body !== prompt.body ? body : undefined,
        studentFacingQuestion:
          studentFacingQuestion !== (prompt.student_facing_question ?? "")
            ? studentFacingQuestion
            : undefined,
      });
      if (r.ok) {
        setFeedback({ kind: "ok", message: "Saved." });
        setExpanded(false);
      } else {
        setFeedback({ kind: "error", message: r.message });
      }
    });
  }

  function onDelete() {
    setFeedback(null);
    startTransition(async () => {
      const r = await deleteSystemPrompt(prompt.id);
      if (!r.ok) {
        setFeedback({ kind: "error", message: r.message });
        setConfirmDelete(false);
      }
    });
  }

  return (
    <section
      className={`rounded-sm border bg-white shadow-sm ${
        prompt.is_default ? "border-dark-blue/30" : "border-stone-200"
      }`}
    >
      <header className="flex flex-wrap items-center gap-3 px-4 py-3">
        {expanded ? (
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            spellCheck={false}
            className="min-w-0 flex-1 rounded-sm border border-transparent bg-transparent px-2 py-1 text-base font-semibold text-stone-900 hover:border-stone-200 focus:border-dark-blue focus:bg-white"
          />
        ) : (
          <h3 className="min-w-0 flex-1 truncate px-2 py-1 text-base font-semibold text-stone-900">
            {prompt.label}
          </h3>
        )}
        {prompt.is_default && (
          <span className="rounded-full bg-dark-blue/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-dark-blue">
            Default
          </span>
        )}
        <span className="rounded-full border border-stone-300 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-stone-500">
          {isSummary ? "Summary" : "System"}
        </span>
        <div className="text-[11px] text-stone-500">
          {isSummary
            ? "Used after every reflection completes"
            : `Used on ${assignmentsUsing} assignment${
                assignmentsUsing === 1 ? "" : "s"
              } (across all teachers)`}
          {!isSummary && policiesUsing > 0 && (
            <>
              {" "}
              · default for {policiesUsing} course
              {policiesUsing === 1 ? "" : "s"}
            </>
          )}
        </div>
        {!expanded && (
          <button
            type="button"
            onClick={() => {
              setExpanded(true);
              setFeedback(null);
            }}
            className="rounded-sm border border-stone-300 px-2.5 py-1 text-xs font-medium text-stone-700 transition-colors hover:border-dark-blue hover:text-dark-blue"
          >
            Edit
          </button>
        )}
      </header>

      {!expanded ? (
        <SystemPromptPreview
          isSummary={isSummary}
          studentFacingQuestion={prompt.student_facing_question ?? ""}
          body={prompt.body}
          feedback={feedback}
        />
      ) : (
        <div className="space-y-4 border-t border-stone-100 px-4 py-3">
          {!isSummary && (
            <div>
              <label className="ehs-eyebrow mb-1.5 block text-stone-500">
                Student-facing question
              </label>
              <p className="mb-1.5 text-xs italic text-stone-500">
                What students see at the top of their reflection. Keep it short
                &mdash; a sentence or two.
              </p>
              <textarea
                value={studentFacingQuestion}
                onChange={(e) => setStudentFacingQuestion(e.target.value)}
                placeholder="e.g. In at least 6 sentences, describe: how did you use AI in your process?..."
                rows={4}
                className="w-full resize-y rounded-sm border border-stone-300 bg-white px-3 py-2 font-document text-sm leading-relaxed focus:border-dark-blue"
              />
            </div>
          )}

          <div>
            <label className="ehs-eyebrow mb-1.5 block text-stone-500">
              {isSummary
                ? "Summary generation prompt"
                : "Coach instructions (system prompt)"}
            </label>
            {!isSummary && (
              <p className="mb-1.5 text-xs italic text-stone-500">
                Instructions for the AI coach. Not shown to students.
              </p>
            )}
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={18}
              spellCheck={false}
              className="w-full resize-y rounded-sm border border-stone-300 bg-white px-3 py-2 font-mono text-xs leading-relaxed shadow-inner focus:border-dark-blue"
            />
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={onSave}
              disabled={!dirty || pending}
              className="rounded-sm bg-dark-blue px-3 py-1.5 text-sm font-semibold text-white transition-colors hover:bg-dark-blue-dark disabled:cursor-not-allowed disabled:bg-stone-300 disabled:text-stone-500"
            >
              {pending ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              onClick={() => {
                setLabel(prompt.label);
                setBody(prompt.body);
                setStudentFacingQuestion(prompt.student_facing_question ?? "");
                setFeedback(null);
                setExpanded(false);
              }}
              disabled={pending}
              className="rounded-sm px-2 py-1 text-sm text-stone-600 hover:bg-stone-100 disabled:opacity-50"
            >
              {dirty ? "Discard changes" : "Cancel"}
            </button>
            {!prompt.is_default && !isSummary && (
              <div className="ml-auto flex items-center gap-2">
                {confirmDelete ? (
                  <>
                    <span className="text-[11px] text-red-700">
                      Will uninstall {assignmentsUsing} assignment
                      {assignmentsUsing === 1 ? "" : "s"} across all teachers
                      {policiesUsing > 0 &&
                        ` and reset ${policiesUsing} course default${
                          policiesUsing === 1 ? "" : "s"
                        }`}
                      . Are you sure?
                    </span>
                    <button
                      type="button"
                      onClick={onDelete}
                      disabled={pending}
                      className="rounded-sm bg-red-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50"
                    >
                      {pending ? "Deleting…" : "Yes, delete"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmDelete(false)}
                      disabled={pending}
                      className="rounded-sm px-2 py-1 text-sm text-stone-600 hover:bg-stone-100 disabled:opacity-50"
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={() => setConfirmDelete(true)}
                    disabled={pending}
                    className="rounded-sm border border-red-200 px-3 py-1.5 text-sm text-red-700 hover:bg-red-50 disabled:opacity-50"
                  >
                    Delete
                  </button>
                )}
              </div>
            )}
          </div>
          {feedback && (
            <div
              className={`text-xs ${
                feedback.kind === "ok" ? "text-emerald-700" : "text-red-700"
              }`}
            >
              {feedback.message}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

// Collapsed body: shows the student-facing question preview for reflection
// prompts, or a short body snippet for the admin-only summary prompt (since
// it has no student-facing question).
function SystemPromptPreview({
  isSummary,
  studentFacingQuestion,
  body,
  feedback,
}: {
  isSummary: boolean;
  studentFacingQuestion: string;
  body: string;
  feedback:
    | null
    | { kind: "ok"; message: string }
    | { kind: "error"; message: string };
}) {
  const previewText = isSummary
    ? body.trim()
    : studentFacingQuestion.trim();
  const previewLabel = isSummary
    ? "Summary generation prompt"
    : "Student-facing question";
  if (!previewText && !feedback) return null;
  return (
    <div className="border-t border-stone-100 px-4 py-3">
      {previewText && (
        <>
          <div className="ehs-eyebrow mb-1 text-stone-500">{previewLabel}</div>
          <p
            className={`line-clamp-2 text-sm leading-relaxed text-stone-700 ${
              isSummary ? "font-mono text-xs" : "font-document"
            }`}
          >
            {previewText}
          </p>
        </>
      )}
      {feedback && (
        <div
          className={`mt-2 text-xs ${
            feedback.kind === "ok" ? "text-emerald-700" : "text-red-700"
          }`}
        >
          {feedback.message}
        </div>
      )}
    </div>
  );
}
