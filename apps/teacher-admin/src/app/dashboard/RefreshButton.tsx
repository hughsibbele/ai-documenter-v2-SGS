"use client";

import { useFormStatus } from "react-dom";

// Read the parent form's submission state and immediately reflect it in the
// button's label + a spinning ring so the teacher gets feedback the second
// they click — without waiting for the server action's revalidate to land.
//
// Sibling SyncIndicator below mirrors the same pending state so the "Synced
// X ago" text doesn't sit there looking stale during the refresh.
export function RefreshButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      aria-busy={pending}
      className="inline-flex items-center gap-1.5 rounded-sm border border-light-blue/80 bg-white px-2 py-0.5 text-xs text-cool-gray transition-colors hover:border-maroon hover:text-maroon disabled:cursor-not-allowed disabled:opacity-60"
      title="Pull the latest courses + assignments from Canvas"
    >
      {pending && <Spinner />}
      {pending ? "Refreshing…" : "Refresh"}
    </button>
  );
}

export function SyncIndicator({ lastSyncedAt }: { lastSyncedAt: string | null }) {
  const { pending } = useFormStatus();
  return (
    <span
      className="text-[11px] italic text-cool-gray"
      title={
        lastSyncedAt
          ? new Date(lastSyncedAt).toLocaleString()
          : undefined
      }
    >
      {pending
        ? "Pulling from Canvas…"
        : lastSyncedAt
          ? `Synced ${formatRelativeTime(lastSyncedAt)}`
          : "Not synced yet"}
    </span>
  );
}

function Spinner() {
  return (
    <svg
      aria-hidden
      width="12"
      height="12"
      viewBox="0 0 24 24"
      className="animate-spin"
    >
      <circle
        cx="12"
        cy="12"
        r="9"
        stroke="currentColor"
        strokeWidth="3"
        fill="none"
        strokeDasharray="42 18"
        strokeLinecap="round"
      />
    </svg>
  );
}

// Tiny duplicate of @/lib/format/time. Keeps this client component
// self-contained so we don't pull a server module into the bundle.
function formatRelativeTime(iso: string): string {
  const then = new Date(iso);
  const diffMs = Date.now() - then.getTime();
  const sec = Math.round(diffMs / 1000);
  const min = Math.round(sec / 60);
  const hr = Math.round(min / 60);
  const day = Math.round(hr / 24);
  if (sec < 5) return "just now";
  if (sec < 60) return `${sec}s ago`;
  if (min < 60) return `${min} minute${min === 1 ? "" : "s"} ago`;
  if (hr < 24) return `${hr} hour${hr === 1 ? "" : "s"} ago`;
  if (day === 1) return "yesterday";
  if (day < 7) return `${day} days ago`;
  return then.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
