"use client";

import { useState, useTransition } from "react";
import { createSystemPrompt } from "@/lib/actions/system-prompts";

export function NewSystemPromptForm() {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [studentFacingQuestion, setStudentFacingQuestion] = useState("");
  const [body, setBody] = useState("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setLabel("");
    setStudentFacingQuestion("");
    setBody("");
    setError(null);
  }

  function onCreate() {
    setError(null);
    startTransition(async () => {
      const r = await createSystemPrompt({
        label,
        body,
        studentFacingQuestion,
      });
      if (r.ok) {
        setOpen(false);
        reset();
      } else {
        setError(r.message);
      }
    });
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-sm border border-stone-300 bg-white px-3 py-1.5 text-sm font-medium text-stone-700 shadow-sm hover:border-dark-blue/50 hover:text-dark-blue"
      >
        + New system prompt
      </button>
    );
  }

  return (
    <section className="rounded-sm border border-stone-300 bg-white p-4 shadow-sm">
      <h2 className="mb-2 text-sm font-semibold text-stone-900">
        New system prompt
      </h2>
      <p className="mb-3 text-xs text-stone-500">
        Visible to every teacher in their install picker. Use a clear, distinct
        label.
      </p>
      <div className="space-y-3">
        <input
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Label (e.g. Lab work, Essay revision)"
          spellCheck={false}
          className="w-full rounded-sm border border-stone-300 bg-white px-3 py-1.5 text-sm focus:border-dark-blue"
        />

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
            placeholder="e.g. In at least 6 sentences, describe: how did you use AI in your process? How did it affect your product? How did it affect your learning?"
            rows={4}
            className="w-full resize-y rounded-sm border border-stone-300 bg-white px-3 py-2 font-document text-sm leading-relaxed focus:border-dark-blue"
          />
        </div>

        <div>
          <label className="ehs-eyebrow mb-1.5 block text-stone-500">
            Coach instructions (system prompt)
          </label>
          <p className="mb-1.5 text-xs italic text-stone-500">
            Instructions for the AI coach. Not shown to students.
          </p>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Tone, framing, what to probe, what to avoid..."
            rows={12}
            spellCheck={false}
            className="w-full resize-y rounded-sm border border-stone-300 bg-white px-3 py-2 font-mono text-xs leading-relaxed focus:border-dark-blue"
          />
        </div>
      </div>
      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          onClick={onCreate}
          disabled={pending || !label.trim() || !body.trim()}
          className="rounded-sm bg-dark-blue px-3 py-1.5 text-sm font-semibold text-white hover:bg-dark-blue-dark disabled:cursor-not-allowed disabled:bg-stone-300 disabled:text-stone-500"
        >
          {pending ? "Creating…" : "Create"}
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            reset();
          }}
          disabled={pending}
          className="rounded-sm px-2 py-1.5 text-sm text-stone-600 hover:bg-stone-100 disabled:opacity-50"
        >
          Cancel
        </button>
        {error && <span className="text-xs text-red-700">{error}</span>}
      </div>
    </section>
  );
}
