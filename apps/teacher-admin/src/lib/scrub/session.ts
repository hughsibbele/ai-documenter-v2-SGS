import "server-only";

import type { Json } from "@ai-documenter/db";
import { scrubFreeText } from "@ai-documenter/anonymizer";
import {
  compiledRosterForCourse,
  compiledRosterFromSnapshot,
  RosterMissingError,
} from "./roster-scrub";

export { RosterMissingError };

type AiChat = { tool: string; url: string; transcript_text: string | null };

/** Subset of reflection_sessions that the scrub touches. Loosely typed via
 *  intersection so callers can pass a `select(...)`-narrowed row without
 *  reshaping it. */
type Scrubable<T> = T & {
  id?: string;
  first_draft: string | null;
  paste_fallback_text: string | null;
  ai_chats: Json;
  /** Phase 1: optional frozen roster captured at intake time. When present
   *  the scrub compiles regexes from this rather than re-reading
   *  `course_rosters` live, so a roster sync mid-reflection cannot widen the
   *  scrub gap. Legacy (pre-Phase-1) sessions don't have it and fall back to
   *  the per-course lookup. */
  roster_snapshot?: Json | null;
};

/**
 * Return a copy of the session with free-text fields scrubbed against the
 * course's roster — pasted AI transcripts and the first-draft paragraph are
 * the two paths where real student names can leak in.
 *
 * Fail-closed (Phase 0): throws `RosterMissingError` if the roster isn't
 * available. Callers must catch and refuse to call Gemini.
 *
 * Roster resolution order (Phase 1):
 *   1. `session.roster_snapshot` — frozen at intake time, immutable for the
 *      lifetime of the reflection.
 *   2. Live `course_rosters` lookup by `canvasCourseId` — fallback for
 *      legacy sessions created before the snapshot column landed.
 */
export async function scrubSessionForGemini<T>(
  session: Scrubable<T>,
  canvasCourseId: string,
): Promise<Scrubable<T>> {
  const compiled =
    session.roster_snapshot != null
      ? compiledRosterFromSnapshot(
          session.roster_snapshot,
          session.id ?? "(unknown)",
        )
      : await compiledRosterForCourse(canvasCourseId);

  const aiChats = ((session.ai_chats as AiChat[] | null) ?? []).map((c) => ({
    ...c,
    transcript_text: c.transcript_text
      ? scrubFreeText(c.transcript_text, compiled)
      : null,
  }));

  return {
    ...session,
    first_draft: session.first_draft
      ? scrubFreeText(session.first_draft, compiled)
      : session.first_draft,
    paste_fallback_text: session.paste_fallback_text
      ? scrubFreeText(session.paste_fallback_text, compiled)
      : session.paste_fallback_text,
    ai_chats: aiChats as unknown as Json,
  };
}
