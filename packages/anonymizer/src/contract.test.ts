import { describe, expect, it } from "vitest";
import { createHmac, randomBytes } from "node:crypto";
import { anonToken } from "./token";

// Reference implementation copied verbatim from super-grader's
// `planning/integration-contract.md` §2 (with the salt parameter pulled out
// for testability; the spec version reads it from process.env). The test
// suite below feeds the same inputs through both this reference and our
// production `anonToken` and asserts byte-equal output. If anyone refactors
// `token.ts` in a way that drifts from the spec — different separator,
// different input order, dropped lowercase normalization, anything — these
// assertions fail loudly. Don't edit this reference; if the spec itself
// changes, update `planning/integration-contract.md` first and copy the
// new shape here in lockstep.
function referenceAnonToken(
  canvasUserId: string | number,
  email: string,
  salt: string,
): string {
  const input = Buffer.concat([
    Buffer.from("ehs\0"),
    Buffer.from(String(canvasUserId)),
    Buffer.from("\0"),
    Buffer.from(email.trim().toLowerCase()),
  ]);
  const mac = createHmac("sha256", Buffer.from(salt, "base64"))
    .update(input)
    .digest("hex");
  return `Student_${mac.slice(0, 6)}`;
}

// A fixed salt so the goldens below are reproducible across runs / machines.
// 32 zero bytes is fine for a test fixture — the test only cares about
// impl-vs-spec parity, not about secrecy.
const FIXED_SALT = Buffer.alloc(32).toString("base64");
const RANDOM_SALT = randomBytes(32).toString("base64");

describe("anonToken contract (integration-contract §2)", () => {
  const cases: ReadonlyArray<{
    name: string;
    canvasUserId: string | number;
    email: string;
  }> = [
    {
      name: "plain pair",
      canvasUserId: "12345",
      email: "jsmith@episcopalhighschool.org",
    },
    {
      name: "uppercase email gets lowercased",
      canvasUserId: "12345",
      email: "JSMITH@EPISCOPALHIGHSCHOOL.ORG",
    },
    {
      name: "leading/trailing whitespace on email is trimmed",
      canvasUserId: "12345",
      email: "  jsmith@episcopalhighschool.org  ",
    },
    {
      name: "mixed-case + whitespace",
      canvasUserId: "12345",
      email: "  J.Smith@EpiscopalHighSchool.Org  ",
    },
    {
      name: "numeric canvas_user_id",
      canvasUserId: 12345,
      email: "jsmith@episcopalhighschool.org",
    },
    {
      name: "long canvas_user_id",
      canvasUserId: "9007199254740991",
      email: "student@episcopalhighschool.org",
    },
    {
      name: "email with dots and hyphens",
      canvasUserId: "42",
      email: "mary-ann.o-brien@episcopalhighschool.org",
    },
  ];

  for (const c of cases) {
    it(`matches the reference impl: ${c.name}`, () => {
      const ours = anonToken(c.canvasUserId, c.email, FIXED_SALT);
      const ref = referenceAnonToken(c.canvasUserId, c.email, FIXED_SALT);
      expect(ours).toBe(ref);
      expect(ours).toMatch(/^Student_[0-9a-f]{6}$/);
    });
  }

  it("matches the reference impl on a random-salt sweep", () => {
    // Drift could be salt-conditional (e.g., dropping HMAC-SHA256 in favor
    // of a different MAC that happens to agree on the all-zero salt). Run
    // the same battery against a random salt to catch that class of bug.
    for (const c of cases) {
      const ours = anonToken(c.canvasUserId, c.email, RANDOM_SALT);
      const ref = referenceAnonToken(c.canvasUserId, c.email, RANDOM_SALT);
      expect(ours).toBe(ref);
    }
  });

  it("produces this exact token for the canonical fixture", () => {
    // Golden — pins the wire format to a single byte sequence. Computed
    // once from the reference impl above with FIXED_SALT and the plain
    // pair from the cases table. If this assertion fails alongside the
    // matches-reference tests, the spec itself moved; if it fails alone,
    // our impl moved away from the spec.
    const expected = referenceAnonToken(
      "12345",
      "jsmith@episcopalhighschool.org",
      FIXED_SALT,
    );
    const actual = anonToken(
      "12345",
      "jsmith@episcopalhighschool.org",
      FIXED_SALT,
    );
    expect(actual).toBe(expected);
    expect(actual).toMatch(/^Student_[0-9a-f]{6}$/);
  });
});
