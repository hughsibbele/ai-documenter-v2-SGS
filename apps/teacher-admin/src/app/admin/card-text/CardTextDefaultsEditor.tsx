"use client";

import { useState, useTransition } from "react";
import type { ReflectionCardText } from "@ai-documenter/canvas";
import { CardPreview } from "@/components/card-text/CardPreview";
import { updateCardTextDefaults } from "@/lib/actions/card-text";

type Initial = {
  kicker: string;
  title: string;
  body: string;
  cta_label: string;
  footnote: string;
  updated_at: string;
};

/**
 * Admin-only editor for the five system-default card-text strings. Always
 * open, side-by-side preview, mirrors HAH / OE shape. Every field is
 * required + non-empty — the singleton row's columns are NOT NULL.
 */
export function CardTextDefaultsEditor({
  initial,
  appBaseUrl,
}: {
  initial: Initial;
  appBaseUrl: string;
}) {
  const [kicker, setKicker] = useState(initial.kicker);
  const [title, setTitle] = useState(initial.title);
  const [body, setBody] = useState(initial.body);
  const [ctaLabel, setCtaLabel] = useState(initial.cta_label);
  const [footnote, setFootnote] = useState(initial.footnote);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | string>(
    "idle",
  );
  const [, startTransition] = useTransition();

  const effective: ReflectionCardText = {
    kicker: kicker.trim() || initial.kicker,
    title: title.trim() || initial.title,
    body: body.trim() || initial.body,
    ctaLabel: ctaLabel.trim() || initial.cta_label,
    footnote: footnote.trim() || initial.footnote,
  };

  function handleSubmit(fd: FormData) {
    setStatus("saving");
    startTransition(async () => {
      const result = await updateCardTextDefaults(fd);
      if (result.ok) {
        setStatus("saved");
        setTimeout(() => setStatus((s) => (s === "saved" ? "idle" : s)), 2000);
      } else {
        setStatus(result.error);
      }
    });
  }

  return (
    <section className="rounded-md border border-stone-200 bg-white p-5">
      <div className="mb-4 text-xs text-cool-gray">
        Updated {new Date(initial.updated_at).toLocaleDateString()}.
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <form action={handleSubmit} className="space-y-4">
          <Row
            label="Kicker (ALL CAPS line at top)"
            name="kicker"
            value={kicker}
            setValue={setKicker}
          />
          <Row label="Title" name="title" value={title} setValue={setTitle} />
          <Row
            label="Body paragraph"
            name="body"
            value={body}
            setValue={setBody}
            multiline
          />
          <Row
            label="Button label"
            name="cta_label"
            value={ctaLabel}
            setValue={setCtaLabel}
          />
          <Row
            label="Footnote (italic line under the button)"
            name="footnote"
            value={footnote}
            setValue={setFootnote}
          />
          <div className="flex items-center gap-3">
            <button
              type="submit"
              disabled={status === "saving"}
              className="rounded bg-maroon px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
            >
              {status === "saving" ? "Saving…" : "Save defaults"}
            </button>
            {status === "saved" && (
              <span className="text-xs text-green-700">Saved.</span>
            )}
            {status !== "idle" &&
              status !== "saving" &&
              status !== "saved" && (
                <span className="text-xs text-red-700">Error: {status}</span>
              )}
          </div>
        </form>

        <div className="lg:sticky lg:top-4 self-start">
          <CardPreview appBaseUrl={appBaseUrl} text={effective} />
          <p className="mt-2 text-xs text-cool-gray">
            Live preview reflects your draft. The button doesn&apos;t go
            anywhere in this preview.
          </p>
        </div>
      </div>
    </section>
  );
}

function Row({
  label,
  name,
  value,
  setValue,
  multiline,
}: {
  label: string;
  name: string;
  value: string;
  setValue: (s: string) => void;
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
          value={value}
          onChange={(e) => setValue(e.target.value)}
          required
          rows={4}
          className="w-full rounded border border-stone-300 px-3 py-2 text-sm leading-snug"
        />
      ) : (
        <input
          id={`admin-${name}`}
          type="text"
          name={name}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          required
          className="w-full rounded border border-stone-300 px-3 py-2 text-sm"
        />
      )}
    </div>
  );
}
