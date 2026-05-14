// Supabase client for Server Components and Route Handlers.
// Cookie-aware via @supabase/ssr — auth state survives across requests.
//
// Caller passes the cookie store (from `next/headers`'s `cookies()`); we don't
// import that here so this package stays framework-agnostic and unit-testable.

import { createServerClient as createSsrServerClient } from "@supabase/ssr";
import type { Database } from "./database.types";
import { publicSupabaseUrl, publishableKey } from "./env";

export type CookieAdapter = {
  getAll(): { name: string; value: string }[];
  setAll(
    cookies: {
      name: string;
      value: string;
      options?: Record<string, unknown>;
    }[],
  ): void;
};

export function createServerDbClient(cookies: CookieAdapter) {
  return createSsrServerClient<Database>(publicSupabaseUrl(), publishableKey(), {
    cookies: {
      getAll() {
        return cookies.getAll();
      },
      setAll(
        toSet: {
          name: string;
          value: string;
          options?: Record<string, unknown>;
        }[],
      ) {
        cookies.setAll(toSet);
      },
    },
  });
}
