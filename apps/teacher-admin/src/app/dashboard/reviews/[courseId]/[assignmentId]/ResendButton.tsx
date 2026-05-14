"use client";

import { useState, useTransition } from "react";
import { resendToCanvas } from "@/lib/actions/reviews";

export function ResendButton({
  sessionId,
  error,
}: {
  sessionId: string;
  error: string | null;
}) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<
    | { ok: true; submissionId: number }
    | { ok: false; message: string }
    | null
  >(null);

  function run() {
    setResult(null);
    startTransition(async () => {
      const r = await resendToCanvas(sessionId);
      setResult(r);
    });
  }

  return (
    <div className="ml-auto flex flex-wrap items-center gap-2">
      {error && !result && (
        <span
          className="max-w-[24ch] truncate text-[10px] italic text-red-700"
          title={error}
        >
          {error}
        </span>
      )}
      {result?.ok === false && (
        <span
          className="max-w-[24ch] truncate text-[10px] italic text-red-700"
          title={result.message}
        >
          {result.message}
        </span>
      )}
      {result?.ok && (
        <span className="text-[10px] italic text-emerald-700">
          Submitted to Canvas
        </span>
      )}
      <button
        type="button"
        onClick={run}
        disabled={pending}
        className="rounded-md border border-maroon/60 bg-white px-2.5 py-1 text-[11px] font-semibold text-maroon transition-colors hover:bg-maroon hover:text-white disabled:opacity-50"
      >
        {pending ? "Resending…" : "Resend to Canvas"}
      </button>
    </div>
  );
}
