// "5 minutes ago" / "2 hours ago" / "yesterday" / "May 3" — for surfacing
// last-synced-at in compact UI text. Server-renderable; deterministic given
// the input + a clock.

export function formatRelativeTime(
  iso: string,
  now: Date = new Date(),
): string {
  const then = new Date(iso);
  const diffMs = now.getTime() - then.getTime();
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
