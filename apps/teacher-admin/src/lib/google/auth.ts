// OAuth2 client per teacher, with automatic token refresh.
//
// Tokens are stored encrypted on teachers.google_*_encrypted (M7.3 — no
// legacy plaintext columns since AID never stored Google OAuth tokens
// before this). Key: TEACHER_GTOKEN_ENC_KEY env var.
//
// 1. Loads the row.
// 2. Decrypts the access + refresh tokens.
// 3. If the access token is within 5 min of expiry (or already past),
//    refreshes via the googleapis SDK using the stored refresh_token.
// 4. Writes the new (encrypted) access_token + expires_at back to the DB.
// 5. Returns an OAuth2 client configured with the current credentials.
//
// Port of HH's `apps/web/src/lib/google/auth.ts` shape with AID's
// per-arg crypto API. M5 consolidation will harmonize the crypto helper
// signature across the suite (HH inlined, OE+AID in a package).

import { google, type Auth } from "googleapis";
import { decryptSecret, encryptSecret } from "@ai-documenter/crypto";
import { createAdminDbClient } from "@ai-documenter/db/admin";

const REFRESH_BUFFER_MS = 5 * 60 * 1000;

export class GoogleAuthError extends Error {
  constructor(message: string, public code?: string) {
    super(message);
    this.name = "GoogleAuthError";
  }
}

function readGoogleTokenKeyFromEnv(): string {
  const key = process.env.TEACHER_GTOKEN_ENC_KEY;
  if (!key) {
    throw new GoogleAuthError(
      "TEACHER_GTOKEN_ENC_KEY env var is not set. Generate with " +
        '`node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"`.',
      "missing_token_key",
    );
  }
  return key;
}

export async function getTeacherGoogleClient(
  teacherId: string,
): Promise<Auth.OAuth2Client> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new GoogleAuthError(
      "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set.",
      "missing_oauth_config",
    );
  }

  const admin = createAdminDbClient();
  const { data: teacher, error } = await admin
    .from("teachers")
    .select(
      "google_access_token_encrypted, google_refresh_token_encrypted, google_token_expires_at",
    )
    .eq("id", teacherId)
    .maybeSingle();
  if (error) throw new GoogleAuthError(`teacher lookup: ${error.message}`);
  if (!teacher) throw new GoogleAuthError("Teacher not found.", "not_found");

  const key = readGoogleTokenKeyFromEnv();
  const accessToken = teacher.google_access_token_encrypted
    ? decryptSecret(teacher.google_access_token_encrypted, key)
    : null;
  const refreshToken = teacher.google_refresh_token_encrypted
    ? decryptSecret(teacher.google_refresh_token_encrypted, key)
    : null;

  const expiry = teacher.google_token_expires_at
    ? new Date(teacher.google_token_expires_at).getTime()
    : 0;
  const accessValid = !!accessToken && Date.now() + REFRESH_BUFFER_MS < expiry;

  // We can proceed if we have either a usable access_token OR a refresh_token.
  // Without either, the teacher must sign in again — Google won't issue a
  // fresh refresh_token without going through consent.
  if (!accessValid && !refreshToken) {
    throw new GoogleAuthError(
      "Google authorization expired. Sign out and sign in again to re-grant Drive access.",
      "missing_refresh_token",
    );
  }

  const client = new google.auth.OAuth2(clientId, clientSecret);
  client.setCredentials({
    access_token: accessToken ?? undefined,
    refresh_token: refreshToken ?? undefined,
    expiry_date: teacher.google_token_expires_at
      ? new Date(teacher.google_token_expires_at).getTime()
      : undefined,
  });

  if (!accessValid && refreshToken) {
    const { credentials } = await client.refreshAccessToken();
    if (!credentials.access_token) {
      throw new GoogleAuthError("Token refresh returned no access_token.");
    }
    const newExpiresAt = credentials.expiry_date
      ? new Date(credentials.expiry_date).toISOString()
      : new Date(Date.now() + 55 * 60 * 1000).toISOString();
    await admin
      .from("teachers")
      .update({
        google_access_token_encrypted: encryptSecret(
          credentials.access_token,
          key,
        ),
        google_token_expires_at: newExpiresAt,
        // refresh_token rarely rotates; persist if it did
        ...(credentials.refresh_token
          ? {
              google_refresh_token_encrypted: encryptSecret(
                credentials.refresh_token,
                key,
              ),
            }
          : {}),
      })
      .eq("id", teacherId);
    client.setCredentials(credentials);
  }

  return client;
}
