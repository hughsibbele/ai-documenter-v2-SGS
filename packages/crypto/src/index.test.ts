import { describe, it, expect } from "vitest";
import { encryptSecret, decryptSecret, generateKey } from "./index.js";

const KEY = generateKey();

describe("encryptSecret + decryptSecret", () => {
  it("round-trips a Canvas-token-like string", () => {
    const token = "12345~abcdef0123456789ABCDEF0123456789ABCDEF0123";
    const blob = encryptSecret(token, KEY);
    expect(blob).not.toContain(token);
    expect(decryptSecret(blob, KEY)).toBe(token);
  });

  it("produces different ciphertext on each call (IV randomized)", () => {
    const a = encryptSecret("same plaintext", KEY);
    const b = encryptSecret("same plaintext", KEY);
    expect(a).not.toBe(b);
  });

  it("fails to decrypt with the wrong key", () => {
    const blob = encryptSecret("secret", KEY);
    const otherKey = generateKey();
    expect(() => decryptSecret(blob, otherKey)).toThrow();
  });

  it("fails to decrypt if the ciphertext is tampered with", () => {
    const blob = encryptSecret("secret", KEY);
    // Flip a bit in the ciphertext portion (after IV+tag).
    const buf = Buffer.from(blob, "base64");
    buf[buf.length - 1]! ^= 1;
    const tampered = buf.toString("base64");
    expect(() => decryptSecret(tampered, KEY)).toThrow();
  });

  it("rejects keys of the wrong length", () => {
    const shortKey = Buffer.from("short").toString("base64");
    expect(() => encryptSecret("x", shortKey)).toThrow(/32 bytes/i);
  });

  it("rejects ciphertext shorter than IV + tag", () => {
    expect(() => decryptSecret("abc", KEY)).toThrow();
  });

  it("handles unicode plaintext", () => {
    const token = "héllo 你好 🔐 Tomás O'Brien";
    const blob = encryptSecret(token, KEY);
    expect(decryptSecret(blob, KEY)).toBe(token);
  });

  it("handles empty plaintext", () => {
    const blob = encryptSecret("", KEY);
    expect(decryptSecret(blob, KEY)).toBe("");
  });
});

describe("generateKey", () => {
  it("produces a base64 string of 32 raw bytes", () => {
    const key = generateKey();
    expect(Buffer.from(key, "base64")).toHaveLength(32);
  });

  it("produces unique keys", () => {
    expect(generateKey()).not.toBe(generateKey());
  });
});
