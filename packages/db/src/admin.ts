// Service-role Supabase client. Bypasses RLS — server-only, never expose to
// the client. Use sparingly: only for the few code paths that must operate
// outside the calling user's row scope (Gemini-bound writes, scheduled jobs,
// the install-it-for-you flow that writes on behalf of the teacher).

import { createClient } from "@supabase/supabase-js";
import type { Database } from "./database.types";
import { publicSupabaseUrl, serviceRoleKey } from "./env";

export function createAdminDbClient() {
  return createClient<Database>(publicSupabaseUrl(), serviceRoleKey(), {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}
