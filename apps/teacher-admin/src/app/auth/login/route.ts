import { NextResponse, type NextRequest } from "next/server";
import { getServerDbClient } from "@/lib/supabase/server";

// Starts the Google OAuth flow. Redirects to Google's consent screen via
// Supabase. The `hd` query param hints at the EHS Workspace domain — actual
// enforcement happens in /auth/callback (a hint isn't enough on its own).
export async function GET(request: NextRequest) {
  const supabase = await getServerDbClient();

  const next = request.nextUrl.searchParams.get("next") ?? "/dashboard";
  const callbackUrl = new URL("/auth/callback", request.nextUrl.origin);
  callbackUrl.searchParams.set("next", next);

  // M7.3 — request Drive + Docs scopes so the post-reflection Drive
  // save can write per-teacher docs without a second consent prompt.
  // `prompt=consent + access_type=offline` is REQUIRED here (not just
  // select_account): refresh tokens are only returned on first
  // consent. The shared OAuth client across the suite means a teacher
  // who granted these scopes in HH/OE will see Google auto-consent
  // here — that's intentional. M5 consolidation will harmonize the
  // scope list across all four satellites.
  const SCOPES = [
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
    "openid",
    "https://www.googleapis.com/auth/drive.file",
    "https://www.googleapis.com/auth/documents",
  ].join(" ");

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: callbackUrl.toString(),
      scopes: SCOPES,
      queryParams: {
        hd: "episcopalhighschool.org",
        prompt: "consent",
        access_type: "offline",
      },
    },
  });

  if (error || !data.url) {
    const url = request.nextUrl.clone();
    url.pathname = "/";
    url.searchParams.set("auth_error", error?.message ?? "oauth_init_failed");
    return NextResponse.redirect(url);
  }

  return NextResponse.redirect(data.url);
}
