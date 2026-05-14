import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Authenticated encryption for at-rest secrets (Canvas API token).
 *
 * Construction: AES-256-GCM with a random 12-byte IV per call.
 * Blob format: base64(iv ‖ authTag ‖ ciphertext).
 *
 * `key` is base64-encoded 32 random bytes (e.g., generated via
 * `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`).
 *
 * Same key encrypts/decrypts every row; rotation requires re-encrypting all rows.
 */

const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;

function decodeKey(key: string): Buffer {
  const buf = Buffer.from(key, "base64");
  if (buf.length !== KEY_LEN) {
    throw new Error(
      `crypto: key must be exactly ${KEY_LEN} bytes (got ${buf.length}).`,
    );
  }
  return buf;
}

export function encryptSecret(plaintext: string, key: string): string {
  const keyBytes = decodeKey(key);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, keyBytes, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString("base64");
}

export function decryptSecret(blob: string, key: string): string {
  const keyBytes = decodeKey(key);
  const combined = Buffer.from(blob, "base64");
  if (combined.length < IV_LEN + TAG_LEN) {
    throw new Error("crypto: ciphertext too short to contain IV and auth tag.");
  }
  const iv = combined.subarray(0, IV_LEN);
  const tag = combined.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct = combined.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv(ALGO, keyBytes, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString("utf8");
}

/** Generate a 32-byte AES key, base64-encoded. One-time setup. */
export function generateKey(): string {
  return randomBytes(KEY_LEN).toString("base64");
}

export function readKeyFromEnv(): string {
  const key = process.env.CANVAS_TOKEN_ENC_KEY;
  if (!key) {
    throw new Error(
      "crypto: CANVAS_TOKEN_ENC_KEY env var is not set. " +
        "Generate one with `node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"`.",
    );
  }
  return key;
}
