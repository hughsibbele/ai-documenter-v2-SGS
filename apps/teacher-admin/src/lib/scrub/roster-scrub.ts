import "server-only";

import {
  anonToken,
  compileRoster,
  readSaltFromEnv,
  scrubFreeText,
  type CompiledRoster,
  type RosterEntry,
} from "@ai-documenter/anonymizer";
import { createAdminDbClient } from "@ai-documenter/db/admin";
import type { Json } from "@ai-documenter/db";

// Fail-closed policy (Phase 0 of REMEDIATION_PLAN.md): compiledRosterForCourse
// THROWS RosterMissingError when any link in the (courseId → course_rosters →
// roster entries → salt) chain is missing or empty. Callers
// (scrubSessionForGemini, eventually any future scrub helper) must catch and
// refuse to call Gemini. The prior "return empty roster, scrub becomes a
// no-op" behavior let verbatim student names + classmates' names from pasted
// AI transcripts reach Gemini — explicit FERPA violation whenever it fired.
//
// Phase 1: prefer reading from reflection_sessions.roster_snapshot
// (`compiledRosterFromSnapshot`) so the scrub pattern is frozen at session
// start and roster sync mid-reflection cannot widen the gap. The per-course
// lookup remains as the fallback for legacy (pre-Phase-1) sessions.

export type RawRosterStudent = {
  canvas_user_id: string;
  name: string;
  email: string | null;
};

/**
 * Thrown by `compiledRosterForCourse` / `compiledRosterFromSnapshot` when the
 * roster used for scrubbing is missing, empty, or unusable (no salt
 * configured). Callers must catch and refuse to call Gemini — emitting
 * unscrubbed text is the FERPA violation Phase 0 closes.
 */
export class RosterMissingError extends Error {
  constructor(public readonly reason: string) {
    super(`roster_missing: ${reason}`);
    this.name = "RosterMissingError";
  }
}

type CacheEntry = {
  compiled: CompiledRoster;
  loadedAt: number;
};

const TTL_MS = 5 * 60 * 1000; // 5 min — cheap re-pull beats a stale roster.
const cache = new Map<string, CacheEntry>();

/**
 * Resolve the compiled scrub roster for a Canvas course. Throws
 * `RosterMissingError` if any of: the canvasCourseId is empty, no
 * `course_rosters` row exists, the roster row exists but is empty / malformed,
 * the salt env is unset, or the post-filter roster is empty.
 *
 * Cache: only successful results are cached (5 min TTL). Failures are not
 * negative-cached so the next call retries — fixes the post-sync recovery
 * path where the first reflection on a freshly synced course shouldn't have
 * to wait 5 minutes for cache eviction.
 *
 * Phase 1: this is the fallback path. New sessions (created after
 * 20260521130000) carry a `roster_snapshot` and use `compiledRosterFromSnapshot`
 * instead. Legacy sessions fall through to here.
 */
export async function compiledRosterForCourse(
  canvasCourseId: string,
): Promise<CompiledRoster> {
  if (!canvasCourseId) {
    throw new RosterMissingError("empty canvasCourseId");
  }

  const cached = cache.get(canvasCourseId);
  if (cached && Date.now() - cached.loadedAt < TTL_MS) {
    return cached.compiled;
  }

  const admin = createAdminDbClient();
  const { data, error } = await admin
    .from("course_rosters")
    .select("students")
    .eq("canvas_course_id", canvasCourseId)
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new RosterMissingError(
      `roster lookup failed for canvas_course_id=${canvasCourseId}: ${error.message}`,
    );
  }
  if (!data) {
    throw new RosterMissingError(
      `no course_rosters row for canvas_course_id=${canvasCourseId} — teacher needs to sync roster`,
    );
  }
  const rawStudents = (data.students as RawRosterStudent[] | null) ?? [];
  const compiled = compileFromRawStudents(rawStudents, canvasCourseId);
  cache.set(canvasCourseId, { compiled, loadedAt: Date.now() });
  return compiled;
}

/**
 * Phase 1: compile the scrub roster directly from a session's frozen
 * `roster_snapshot` jsonb. No DB roundtrip; throws `RosterMissingError` if
 * the snapshot is empty / malformed / salt is unset (same fail-closed
 * contract as `compiledRosterForCourse`).
 *
 * Called by `scrubSessionForGemini` when the session row has a populated
 * `roster_snapshot`. The snapshot was written at intake time and is
 * immutable for the lifetime of the reflection — a roster sync mid-session
 * cannot reach back and change the scrub pattern.
 */
export function compiledRosterFromSnapshot(
  rosterSnapshot: Json | null | undefined,
  sessionLabel: string,
): CompiledRoster {
  if (!rosterSnapshot || !Array.isArray(rosterSnapshot)) {
    throw new RosterMissingError(
      `roster_snapshot missing or malformed for session=${sessionLabel}`,
    );
  }
  const rawStudents = rosterSnapshot as unknown as RawRosterStudent[];
  return compileFromRawStudents(rawStudents, `snapshot:${sessionLabel}`);
}

/**
 * Convenience: scrub a single string against the course roster. Throws
 * `RosterMissingError` (via `compiledRosterForCourse`) if the roster isn't
 * usable — callers must catch and refuse to ship the text to Gemini.
 */
export async function scrubFreeTextForCourse(
  canvasCourseId: string,
  text: string,
): Promise<string> {
  if (!text) return text;
  const compiled = await compiledRosterForCourse(canvasCourseId);
  return scrubFreeText(text, compiled);
}

/**
 * Load the raw roster (pre-compile) for a course, suitable for embedding
 * into `reflection_sessions.roster_snapshot` at intake time. Throws
 * `RosterMissingError` on the same conditions as `compiledRosterForCourse`
 * so intake can fail-closed before the session row is even created.
 */
export async function loadRawRosterForCourse(
  canvasCourseId: string,
): Promise<RawRosterStudent[]> {
  if (!canvasCourseId) {
    throw new RosterMissingError("empty canvasCourseId");
  }
  const admin = createAdminDbClient();
  const { data, error } = await admin
    .from("course_rosters")
    .select("students")
    .eq("canvas_course_id", canvasCourseId)
    .limit(1)
    .maybeSingle();
  if (error) {
    throw new RosterMissingError(
      `roster lookup failed for canvas_course_id=${canvasCourseId}: ${error.message}`,
    );
  }
  if (!data) {
    throw new RosterMissingError(
      `no course_rosters row for canvas_course_id=${canvasCourseId} — teacher needs to sync roster`,
    );
  }
  const rawStudents = (data.students as RawRosterStudent[] | null) ?? [];
  if (rawStudents.length === 0) {
    throw new RosterMissingError(
      `course_rosters row exists but students array is empty for canvas_course_id=${canvasCourseId}`,
    );
  }
  return rawStudents;
}

// ---------------------------------------------------------------------------

function compileFromRawStudents(
  rawStudents: RawRosterStudent[],
  contextLabel: string,
): CompiledRoster {
  if (rawStudents.length === 0) {
    throw new RosterMissingError(
      `roster row exists but students array is empty for ${contextLabel}`,
    );
  }

  // Hard-fail if salt is unset. Symmetric with the short-salt path in
  // anonToken, which already throws. Previously the missing-salt path was
  // silently swallowed in roster-scrub — the asymmetric fail-OPEN case the
  // audit flagged.
  const salt = readSaltFromEnv();

  const entries: RosterEntry[] = rawStudents
    .filter((s) => s.canvas_user_id && s.name)
    .map((s) => ({
      canvas_user_id: s.canvas_user_id,
      email: s.email ?? "",
      display_name: s.name,
      anon_token: anonToken(s.canvas_user_id, s.email ?? "", salt),
    }));

  if (entries.length === 0) {
    throw new RosterMissingError(
      `roster row exists but every entry was filtered out for ${contextLabel}`,
    );
  }

  return compileRoster(entries);
}
