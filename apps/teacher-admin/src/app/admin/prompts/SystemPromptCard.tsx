"use client";

import { useRef, useState, useTransition } from "react";
import type { Tables } from "@ai-documenter/db";
import {
  saveSystemPrompt,
  deleteSystemPrompt,
} from "@/lib/actions/system-prompts";
import { useAutoSaveDispatch } from "@/components/auto-save/context";
import { useAutoSaveForm } from "@/components/auto-save/useAutoSaveForm";

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
  // Local mirror of the most-recently-saved values, used by the
  // collapsed preview. Uncontrolled inputs hold the live editing
  // state; on save success we sync these so the preview reflects
  // the latest body even before the next router refresh.
  const [savedLabel, setSavedLabel] = useState(prompt.label);
  const [savedSFQ, setSavedSFQ] = useState(
    prompt.student_facing_question ?? "",
  );
  const [savedBody, setSavedBody] = useState(prompt.body);
  const [pending, startTransition] = useTransition();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const dispatch = useAutoSaveDispatch();
  const formRef = useRef<HTMLFormElement>(null);
  const labelRef = useRef<HTMLInputElement>(null);
  const sfqRef = useRef<HTMLTextAreaElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  const isSummary = prompt.purpose === "objective_summary";

  function save() {
    const label = labelRef.current?.value ?? savedLabel;
    const body = bodyRef.current?.value ?? savedBody;
    const sfq = sfqRef.current?.value ?? savedSFQ;
    const labelChanged = label !== labelRef.current?.defaultValue;
    const bodyChanged = body !== bodyRef.current?.defaultValue;
    const sfqChanged = sfqRef.current
      ? sfq !== sfqRef.current.defaultValue
      : false;
    if (!labelChanged && !bodyChanged && !sfqChanged) return;

    dispatch({ kind: "saving" });
    startTransition(async () => {
      const r = await saveSystemPrompt(prompt.id, {
        label: labelChanged ? label : undefined,
        body: bodyChanged ? body : undefined,
        studentFacingQuestion: sfqChanged ? sfq : undefined,
      });
      if (r.ok) {
        if (labelChanged) {
          setSavedLabel(label);
          if (labelRef.current) labelRef.current.defaultValue = label;
        }
        if (bodyChanged) {
          setSavedBody(body);
          if (bodyRef.current) bodyRef.current.defaultValue = body;
        }
        if (sfqChanged) {
          setSavedSFQ(sfq);
          if (sfqRef.current) sfqRef.current.defaultValue = sfq;
        }
        dispatch({ kind: "saved", at: Date.now() });
      } else {
        dispatch({ kind: "error", msg: r.message });
      }
    });
  }

  useAutoSaveForm({
    formRef,
    save,
    // expand-state is part of the freshness key so a collapse→expand
    // round-trip resets pending debounce timers.
    freshnessKey: `${prompt.updated_at}:${expanded ? "open" : "closed"}`,
  });

  function onDelete() {
    dispatch({ kind: "saving" });
    startTransition(async () => {
      const r = await deleteSystemPrompt(prompt.id);
      if (r.ok) {
        dispatch({ kind: "saved", at: Date.now() });
      } else {
        dispatch({ kind: "error", msg: r.message });
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
      <form
        ref={formRef}
        onSubmit={(e) => e.preventDefault()}
      >
        <header className="flex flex-wrap items-center gap-3 px-4 py-3">
          {expanded ? (
            <input
              ref={labelRef}
              type="text"
              name="label"
              defaultValue={savedLabel}
              spellCheck={false}
              className="min-w-0 flex-1 rounded-sm border border-transparent bg-transparent px-2 py-1 text-base font-semibold text-stone-900 hover:border-stone-200 focus:border-dark-blue focus:bg-white"
            />
          ) : (
            <h3 className="min-w-0 flex-1 truncate px-2 py-1 text-base font-semibold text-stone-900">
              {savedLabel}
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
          {!expanded ? (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="rounded-sm border border-stone-300 px-2.5 py-1 text-xs font-medium text-stone-700 transition-colors hover:border-dark-blue hover:text-dark-blue"
            >
              Edit
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setExpanded(false)}
              disabled={pending}
              className="rounded-sm border border-stone-300 px-2.5 py-1 text-xs font-medium text-stone-700 transition-colors hover:border-stone-400 disabled:opacity-50"
            >
              Done
            </button>
          )}
        </header>

        {!expanded ? (
          <SystemPromptPreview
            isSummary={isSummary}
            studentFacingQuestion={savedSFQ}
            body={savedBody}
          />
        ) : (
          <div className="space-y-4 border-t border-stone-100 px-4 py-3">
            {!isSummary && (
              <div>
                <label className="ehs-eyebrow mb-1.5 block text-stone-500">
                  Student-facing question
                </label>
                <p className="mb-1.5 text-xs italic text-stone-500">
                  What students see at the top of their reflection. Keep it
                  short &mdash; a sentence or two.
                </p>
                <textarea
                  ref={sfqRef}
                  name="studentFacingQuestion"
                  defaultValue={savedSFQ}
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
                ref={bodyRef}
                name="body"
                defaultValue={savedBody}
                rows={18}
                spellCheck={false}
                className="w-full resize-y rounded-sm border border-stone-300 bg-white px-3 py-2 font-mono text-xs leading-relaxed shadow-inner focus:border-dark-blue"
              />
            </div>

            {!prompt.is_default && !isSummary && (
              <div className="flex flex-wrap items-center justify-end gap-2 pt-2">
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
        )}
      </form>
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
}: {
  isSummary: boolean;
  studentFacingQuestion: string;
  body: string;
}) {
  const previewText = isSummary ? body.trim() : studentFacingQuestion.trim();
  const previewLabel = isSummary
    ? "Summary generation prompt"
    : "Student-facing question";
  if (!previewText) return null;
  return (
    <div className="border-t border-stone-100 px-4 py-3">
      <div className="ehs-eyebrow mb-1 text-stone-500">{previewLabel}</div>
      <p
        className={`line-clamp-2 text-sm leading-relaxed text-stone-700 ${
          isSummary ? "font-mono text-xs" : "font-document"
        }`}
      >
        {previewText}
      </p>
    </div>
  );
}
