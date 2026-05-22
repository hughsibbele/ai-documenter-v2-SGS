import "server-only";

import type { Json } from "@ai-documenter/db";
import { scrubFreeText } from "@ai-documenter/anonymizer";
import { compiledRosterForCourse, RosterMissingError } from "./roster-scrub";

export { RosterMissingError };

type AiChat = { tool: string; url: string; transcript_text: string | null };

/** Subset of reflection_sessions that the scrub touches. Loosely typed via
 *  intersection so callers can pass a `select(...)`-narrowed row without
 *  reshaping it. */
type Scrubable<T> = T & {
  first_draft: string | null;
  paste_fallback_text: string | null;
  ai_chats: Json;
};

/**
 * Return a copy of the session with free-text fields scrubbed against the
 * course's roster — pasted AI transcripts and the first-draft paragraph are
 * the two paths where real student names can leak in.
 *
 * Fail-closed (Phase 0): throws `RosterMissingError` if the roster isn't
 * available (no `course_rosters` row, empty roster, missing salt env, empty
 * canvasCourseId). Callers must catch and refuse to call Gemini. Previously
 * this function silently returned the session unchanged in those cases,
 * letting verbatim PII reach Gemini — the audit's headline finding.
 */
export async function scrubSessionForGemini<T>(
  session: Scrubable<T>,
  canvasCourseId: string,
): Promise<Scrubable<T>> {
  const compiled = await compiledRosterForCourse(canvasCourseId);

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
