import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { anonToken } from "./token";

const SALT = randomBytes(32).toString("base64");

describe("anonToken", () => {
  it("produces a Student_xxxxxx token", () => {
    const t = anonToken("12345", "j.smith@episcopalhighschool.org", SALT);
    expect(t).toMatch(/^Student_[0-9a-f]{6}$/);
  });

  it("is deterministic for the same input", () => {
    const a = anonToken("12345", "j.smith@episcopalhighschool.org", SALT);
    const b = anonToken("12345", "j.smith@episcopalhighschool.org", SALT);
    expect(a).toBe(b);
  });

  it("normalizes email case and whitespace", () => {
    const a = anonToken("12345", "  J.Smith@EpiscopalHighSchool.org  ", SALT);
    const b = anonToken("12345", "j.smith@episcopalhighschool.org", SALT);
    expect(a).toBe(b);
  });

  it("differs when canvas_user_id changes", () => {
    const a = anonToken("12345", "j.smith@episcopalhighschool.org", SALT);
    const b = anonToken("12346", "j.smith@episcopalhighschool.org", SALT);
    expect(a).not.toBe(b);
  });

  it("differs when email changes", () => {
    const a = anonToken("12345", "j.smith@episcopalhighschool.org", SALT);
    const b = anonToken("12345", "k.smith@episcopalhighschool.org", SALT);
    expect(a).not.toBe(b);
  });

  it("accepts numeric canvas_user_id", () => {
    const a = anonToken(12345, "j.smith@episcopalhighschool.org", SALT);
    const b = anonToken("12345", "j.smith@episcopalhighschool.org", SALT);
    expect(a).toBe(b);
  });

  it("differs across salts", () => {
    const otherSalt = randomBytes(32).toString("base64");
    const a = anonToken("12345", "j.smith@episcopalhighschool.org", SALT);
    const b = anonToken("12345", "j.smith@episcopalhighschool.org", otherSalt);
    expect(a).not.toBe(b);
  });

  it("refuses to run with an empty salt", () => {
    expect(() => anonToken("12345", "x@y.org", "")).toThrow(/empty/i);
  });

  it("refuses to run with a too-short salt", () => {
    const shortSalt = Buffer.from("short").toString("base64");
    expect(() => anonToken("12345", "x@y.org", shortSalt)).toThrow(/short/i);
  });

  it("has no collisions across a 500-student synthetic roster", () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 500; i++) {
      tokens.add(anonToken(`user_${i}`, `student${i}@episcopalhighschool.org`, SALT));
    }
    expect(tokens.size).toBe(500);
  });
});
