"use client";

import { useRef, useState, useTransition } from "react";
import type { ReflectionCardText } from "@ai-documenter/canvas";
import { CardPreview } from "@/components/card-text/CardPreview";
import { updateCardTextDefaults } from "@/lib/actions/card-text";
import {
  AutoSaveStatusPill,
  type AutoSaveStatus,
} from "@/components/auto-save/AutoSaveStatusPill";
import { useAutoSaveForm } from "@/components/auto-save/useAutoSaveForm";

type Initial = {
  kicker: string;
  title: string;
  body: string;
  cta_label: string;
  footnote: string;
  updated_at: string;
};

type PreviewValues = {
  kicker: string;
  title: string;
  body: string;
  cta_label: string;
  footnote: string;
};

/**
 * Admin-only editor for the five system-default card-text strings.
 * Always open, side-by-side preview, mirrors HAH / OE shape. Every
 * field is required + non-empty — the singleton row's columns are
 * NOT NULL.
 *
 * The inputs are uncontrolled (defaultValue) so the auto-save hook
 * can use `isFormDirty(form)` to drive the debounce; live state is
 * mirrored into `preview` on every keystroke purely to feed the
 * side-by-side <CardPreview>. On save success we re-baseline the
 * DOM defaultValues so the hook stops reporting as dirty.
 */
export function CardTextDefaultsEditor({
  initial,
  appBaseUrl,
}: {
  initial: Initial;
  appBaseUrl: string;
}) {
  const [savedAt, setSavedAt] = useState(initial.updated_at);
  const [preview, setPreview] = useState<PreviewValues>({
    kicker: initial.kicker,
    title: initial.title,
    body: initial.body,
    cta_label: initial.cta_label,
    footnote: initial.footnote,
  });
  const [status, setStatus] = useState<AutoSaveStatus>({ kind: "idle" });
  const [, startTransition] = useTransition();
  const formRef = useRef<HTMLFormElement>(null);

  const effective: ReflectionCardText = {
    kicker: preview.kicker.trim() || initial.kicker,
    title: preview.title.trim() || initial.title,
    body: preview.body.trim() || initial.body,
    ctaLabel: preview.cta_label.trim() || initial.cta_label,
    footnote: preview.footnote.trim() || initial.footnote,
  };

  function save() {
    const form = formRef.current;
    if (!form) return;
    const fd = new FormData(form);
    setStatus({ kind: "saving" });
    startTransition(async () => {
      const result = await updateCardTextDefaults(fd);
      if (result.ok) {
        // Re-baseline DOM defaultValues so isFormDirty stops reporting
        // as dirty after a clean save.
        for (const el of Array.from(form.elements)) {
          if (
            el instanceof HTMLInputElement &&
            el.type !== "hidden" &&
            el.type !== "submit" &&
            el.type !== "button"
          ) {
            el.defaultValue = el.value;
          } else if (el instanceof HTMLTextAreaElement) {
            el.defaultValue = el.value;
          }
        }
        setSavedAt(new Date().toISOString());
        setStatus({ kind: "saved", at: Date.now() });
      } else {
        setStatus({ kind: "error", msg: result.error });
      }
    });
  }

  useAutoSaveForm({ formRef, save, freshnessKey: savedAt });

  return (
    <section className="rounded-md border border-stone-200 bg-white p-5">
      <div className="mb-4 text-xs text-cool-gray">
        Updated {new Date(savedAt).toLocaleDateString()}.
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <form
          ref={formRef}
          onSubmit={(e) => e.preventDefault()}
          className="space-y-4"
        >
          <Row
            label="Kicker (ALL CAPS line at top)"
            name="kicker"
            defaultValue={initial.kicker}
            onInput={(v) => setPreview((p) => ({ ...p, kicker: v }))}
          />
          <Row
            label="Title"
            name="title"
            defaultValue={initial.title}
            onInput={(v) => setPreview((p) => ({ ...p, title: v }))}
          />
          <Row
            label="Body paragraph"
            name="body"
            defaultValue={initial.body}
            onInput={(v) => setPreview((p) => ({ ...p, body: v }))}
            multiline
          />
          <Row
            label="Button label"
            name="cta_label"
            defaultValue={initial.cta_label}
            onInput={(v) => setPreview((p) => ({ ...p, cta_label: v }))}
          />
          <Row
            label="Footnote (italic line under the button)"
            name="footnote"
            defaultValue={initial.footnote}
            onInput={(v) => setPreview((p) => ({ ...p, footnote: v }))}
          />
        </form>

        <div className="lg:sticky lg:top-4 self-start">
          <CardPreview appBaseUrl={appBaseUrl} text={effective} />
          <p className="mt-2 text-xs text-cool-gray">
            Live preview reflects your draft. The button doesn&apos;t go
            anywhere in this preview.
          </p>
        </div>
      </div>
      <AutoSaveStatusPill status={status} />
    </section>
  );
}

function Row({
  label,
  name,
  defaultValue,
  onInput,
  multiline,
}: {
  label: string;
  name: string;
  defaultValue: string;
  onInput: (v: string) => void;
  multiline?: boolean;
}) {
  return (
    <div>
      <label
        htmlFor={`admin-${name}`}
        className="mb-1 block text-sm font-medium text-ink"
      >
        {label}
      </label>
      {multiline ? (
        <textarea
          id={`admin-${name}`}
          name={name}
          defaultValue={defaultValue}
          onInput={(e) => onInput((e.target as HTMLTextAreaElement).value)}
          required
          rows={4}
          className="w-full rounded border border-stone-300 px-3 py-2 text-sm leading-snug"
        />
      ) : (
        <input
          id={`admin-${name}`}
          type="text"
          name={name}
          defaultValue={defaultValue}
          onInput={(e) => onInput((e.target as HTMLInputElement).value)}
          required
          className="w-full rounded border border-stone-300 px-3 py-2 text-sm"
        />
      )}
    </div>
  );
}
