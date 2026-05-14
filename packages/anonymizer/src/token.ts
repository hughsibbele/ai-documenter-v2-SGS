import { createHmac } from "node:crypto";

/**
 * Produce a stable `Student_xxxxxx` token for a (canvas_user_id, email) pair.
 *
 * Spec defined in `planning/integration-contract.md` §2. The same token is
 * produced by every tool in the super-grader ecosystem given the same salt.
 *
 * The salt MUST be the same across all ecosystem tools and distinct from
 * Canvas-Agent's salt.
 */
export function anonToken(
  canvasUserId: string | number,
  email: string,
  salt: string,
): string {
  if (!salt) {
    throw new Error(
      "anonymizer: SUPER_GRADER_SALT is empty. Refusing to produce a token with no salt.",
    );
  }

  const saltBytes = Buffer.from(salt, "base64");
  if (saltBytes.length < 16) {
    throw new Error(
      `anonymizer: salt is suspiciously short (${saltBytes.length} bytes after base64 decode). ` +
        `Generate at least 32 bytes.`,
    );
  }

  const input = Buffer.concat([
    Buffer.from("ehs\0"),
    Buffer.from(String(canvasUserId)),
    Buffer.from("\0"),
    Buffer.from(email.trim().toLowerCase()),
  ]);

  const mac = createHmac("sha256", saltBytes).update(input).digest("hex");
  return `Student_${mac.slice(0, 6)}`;
}

/**
 * Read the salt from process.env, throwing a clear error if missing.
 * Server-side only — never call this in browser code.
 */
export function readSaltFromEnv(): string {
  const salt = process.env.SUPER_GRADER_SALT;
  if (!salt) {
    throw new Error(
      "anonymizer: SUPER_GRADER_SALT env var is not set. " +
        "Refusing to silently generate insecure tokens.",
    );
  }
  return salt;
}
