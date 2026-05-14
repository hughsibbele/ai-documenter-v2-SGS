import "server-only";
import { cache } from "react";
import { createAdminDbClient } from "@ai-documenter/db/admin";
import { anonToken, readSaltFromEnv } from "@ai-documenter/anonymizer";
import type { Tables } from "@ai-documenter/db";
import { getServerDbClient } from "@/lib/supabase/server";

export type Student = Tables<"students">;

// Returns the current authed student, or null. Memoized per render. The
// students row is created server-side at /auth/callback, so by the time any
// page calls this the row should exist for any user with a valid session.
export const getCurrentStudent = cache(async (): Promise<Student | null> => {
  const supabase = await getServerDbClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const admin = createAdminDbClient();
  const { data } = await admin
    .from("students")
    .select("*")
    .eq("auth_user_id", user.id)
    .maybeSingle();
  return data ?? null;
});

// Upsert the students row for a freshly-authenticated auth.users user. Called
// from /auth/callback. Uses the email-only anon_token variant in slice 1 —
// canvas_user_id is backfilled when the Canvas auto-submit slice lands. Since
// no production data exists yet, re-keying is acceptable.
export async function upsertStudentFromAuth(authUser: {
  id: string;
  email: string;
  display_name: string;
  google_sub: string | null;
}): Promise<Student> {
  const admin = createAdminDbClient();

  const { data: existing } = await admin
    .from("students")
    .select("*")
    .eq("auth_user_id", authUser.id)
    .maybeSingle();
  if (existing) return existing;

  const token = anonToken("", authUser.email, readSaltFromEnv());

  const { data: created, error } = await admin
    .from("students")
    .upsert(
      {
        auth_user_id: authUser.id,
        email: authUser.email.toLowerCase(),
        display_name: authUser.display_name,
        google_sub: authUser.google_sub,
        anon_token: token,
      },
      { onConflict: "auth_user_id" },
    )
    .select("*")
    .single();

  if (error || !created) {
    throw new Error(
      `Couldn't create student row: ${error?.message ?? "unknown"}`,
    );
  }
  return created;
}
