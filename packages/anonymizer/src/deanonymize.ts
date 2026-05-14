import type { Roster } from "./types";

/**
 * Replace `Student_xxxxxx` tokens with the corresponding display_name.
 * Use ONLY at render time, server-side, on the way to the teacher's browser.
 */
export function deAnonymize(text: string, roster: Roster): string {
  if (!text) return text;
  const lookup = new Map<string, string>();
  for (const entry of roster) {
    lookup.set(entry.anon_token, entry.display_name);
  }
  return text.replace(/Student_[0-9a-fA-F]{6}/g, (m) => lookup.get(m) ?? m);
}
