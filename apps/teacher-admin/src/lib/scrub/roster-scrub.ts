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

type RawRosterStudent = {
  canvas_user_id: string;
  name: string;
  email: string | null;
};

/**
 * Load + compile the roster for a Canvas course (any teacher who's synced
 * it). Falls back to an empty compiled pattern if no roster row exists yet
 * — scrubbing is a defense-in-depth layer, not a hard gate.
 *
 * Anon tokens are derived from `(canvas_user_id, email)` with the shared
 * `SUPER_GRADER_SALT`, matching the canonical form used elsewhere in the
 * EHS AI ecosystem. Students without an email fall back to `""` for the
 * email half; same shape as the early-bootstrap path in students-table
 * writes.
 *
 * Process-level cache: same shape as a roster sweep, keyed by
 * canvas_course_id. Cleared on each cold start (Lambda recycle), which is
 * fine — Roster freshness is nightly, not real-time.
 */

type CacheEntry = {
  compiled: CompiledRoster;
  loadedAt: number;
};

const TTL_MS = 5 * 60 * 1000; // 5 min — cheap re-pull beats a stale roster.
const cache = new Map<string, CacheEntry>();

export async function compiledRosterForCourse(
  canvasCourseId: string,
): Promise<CompiledRoster> {
  const cached = cache.get(canvasCourseId);
  if (cached && Date.now() - cached.loadedAt < TTL_MS) {
    return cached.compiled;
  }

  const admin = createAdminDbClient();
  const { data } = await admin
    .from("course_rosters")
    .select("students")
    .eq("canvas_course_id", canvasCourseId)
    .limit(1)
    .maybeSingle();

  const rawStudents = (data?.students as RawRosterStudent[] | null) ?? [];
  if (rawStudents.length === 0) {
    const empty = compileRoster([]);
    cache.set(canvasCourseId, { compiled: empty, loadedAt: Date.now() });
    return empty;
  }

  const salt = (() => {
    try {
      return readSaltFromEnv();
    } catch {
      // No salt configured — return empty roster so we don't accidentally
      // emit incorrect tokens. The free-text scrub becomes a no-op; the
      // structured anonymizer at the boundary still runs.
      return null;
    }
  })();
  if (!salt) {
    const empty = compileRoster([]);
    cache.set(canvasCourseId, { compiled: empty, loadedAt: Date.now() });
    return empty;
  }

  const entries: RosterEntry[] = rawStudents
    .filter((s) => s.canvas_user_id && s.name)
    .map((s) => ({
      canvas_user_id: s.canvas_user_id,
      email: s.email ?? "",
      display_name: s.name,
      anon_token: anonToken(s.canvas_user_id, s.email ?? "", salt),
    }));

  const compiled = compileRoster(entries);
  cache.set(canvasCourseId, { compiled, loadedAt: Date.now() });
  return compiled;
}

/** Convenience: run the scrub if there's anything to scrub. */
export async function scrubFreeTextForCourse(
  canvasCourseId: string,
  text: string,
): Promise<string> {
  if (!text) return text;
  const compiled = await compiledRosterForCourse(canvasCourseId);
  if (compiled.variants.length === 0) return text;
  return scrubFreeText(text, compiled);
}
