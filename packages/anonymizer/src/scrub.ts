import type { Roster, RosterEntry } from "./types";

/**
 * Compiled name-redaction pattern for a roster. Cache per roster snapshot;
 * invalidate when the roster changes.
 *
 * Patterns ordered longest-first so that "Mary Jane Smith" wins over "Mary"
 * when both would otherwise match.
 */
export type CompiledRoster = {
  variants: ReadonlyArray<{ pattern: RegExp; token: string }>;
};

const NAME_BOUNDARY = "(?<![\\p{L}\\p{N}_])";
const NAME_BOUNDARY_END = "(?![\\p{L}\\p{N}_])";

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function nameVariants(displayName: string): string[] {
  const cleaned = displayName.trim();
  if (!cleaned) return [];

  const parts = cleaned.split(/\s+/).filter(Boolean);
  const variants = new Set<string>();

  // Full name
  variants.add(cleaned);

  // First name only
  if (parts[0]) variants.add(parts[0]);

  // Last name only (last token, even if it's hyphenated like "Smith-Jones")
  if (parts.length > 1) {
    const last = parts[parts.length - 1];
    if (last) variants.add(last);
  }

  // Each hyphen-component of the last name as a fallback
  // ("Smith" and "Jones" from "Smith-Jones")
  if (parts.length > 1) {
    const last = parts[parts.length - 1];
    if (last && last.includes("-")) {
      for (const piece of last.split("-").filter(Boolean)) {
        variants.add(piece);
      }
    }
  }

  return [...variants].filter((v) => v.length >= 2);
}

/**
 * Compile a single regex per roster entry covering all of its name variants
 * (full, first-only, last-only, hyphen-pieces). Each variant matches with or
 * without a trailing possessive `'s` / `'s` and is bounded by non-letter chars.
 */
export function compileRoster(roster: Roster): CompiledRoster {
  const items: Array<{ pattern: RegExp; token: string; len: number }> = [];

  for (const entry of roster) {
    const variants = nameVariants(entry.display_name);
    for (const variant of variants) {
      const escaped = escapeRegex(variant).replace(/\s+/g, "\\s+");
      // Match name + optional possessive (straight or curly apostrophe)
      const body = `${escaped}(?:['\\u2019]s)?`;
      const pattern = new RegExp(
        `${NAME_BOUNDARY}${body}${NAME_BOUNDARY_END}`,
        "giu",
      );
      items.push({ pattern, token: entry.anon_token, len: variant.length });
    }
  }

  // Sort longest variant first so "Mary Jane Smith" beats "Mary".
  items.sort((a, b) => b.len - a.len);

  return {
    variants: items.map(({ pattern, token }) => ({ pattern, token })),
  };
}

/**
 * Apply the compiled roster to free text. Each replacement preserves a
 * trailing possessive intent (the token replaces the whole "Hugh's" run).
 */
export function scrubFreeText(text: string, compiled: CompiledRoster): string {
  let out = text;
  for (const { pattern, token } of compiled.variants) {
    // Reset lastIndex on each pass since we use the global flag.
    out = out.replace(pattern, token);
  }
  return out;
}

/**
 * Recursively scrub any nested structure, replacing strings with their
 * scrubbed form. Numbers, booleans, null, and Date pass through.
 */
export function scrubPayload<T>(value: T, compiled: CompiledRoster): T {
  return scrubValue(value, compiled) as T;
}

function scrubValue(value: unknown, compiled: CompiledRoster): unknown {
  if (typeof value === "string") {
    return scrubFreeText(value, compiled);
  }
  if (Array.isArray(value)) {
    return value.map((v) => scrubValue(v, compiled));
  }
  if (value && typeof value === "object" && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = scrubValue(v, compiled);
    }
    return out;
  }
  return value;
}

/**
 * Build a structured-fields scrubber: replace any object key matching
 * `name | display_name | full_name | email | canvas_user_id | student_id`
 * with the corresponding student's anon_token, looked up by another
 * identifier in the same object.
 *
 * Use this BEFORE `scrubFreeText` for cleaner output on structured Gemini
 * payloads (e.g., a Canvas submission JSON dump).
 */
export function scrubStructured<T>(
  value: T,
  byEmail: Map<string, RosterEntry>,
  byCanvasId: Map<string, RosterEntry>,
): T {
  return scrubStructuredValue(value, byEmail, byCanvasId) as T;
}

function scrubStructuredValue(
  value: unknown,
  byEmail: Map<string, RosterEntry>,
  byCanvasId: Map<string, RosterEntry>,
): unknown {
  if (Array.isArray(value)) {
    return value.map((v) => scrubStructuredValue(v, byEmail, byCanvasId));
  }
  if (value && typeof value === "object" && !(value instanceof Date)) {
    const obj = value as Record<string, unknown>;

    // Try to identify the student this object describes.
    const id =
      typeof obj.canvas_user_id === "string" || typeof obj.canvas_user_id === "number"
        ? String(obj.canvas_user_id)
        : typeof obj.user_id === "string" || typeof obj.user_id === "number"
          ? String(obj.user_id)
          : undefined;
    const email =
      typeof obj.email === "string" ? obj.email.trim().toLowerCase() : undefined;

    const entry =
      (id && byCanvasId.get(id)) || (email && byEmail.get(email)) || undefined;

    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (entry && PII_KEYS.has(k)) {
        out[k] = entry.anon_token;
      } else {
        out[k] = scrubStructuredValue(v, byEmail, byCanvasId);
      }
    }
    return out;
  }
  return value;
}

const PII_KEYS = new Set([
  "name",
  "display_name",
  "full_name",
  "first_name",
  "last_name",
  "sortable_name",
  "short_name",
  "email",
  "login_id",
  "sis_user_id",
  "canvas_user_id",
  "user_id",
  "student_id",
]);
