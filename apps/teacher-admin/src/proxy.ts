import { NextResponse, type NextRequest } from "next/server";
import { createProxyDbClient } from "@/lib/supabase/proxy";

// Auth proxy: refreshes the Supabase session on every request and gates
// /dashboard/* and /api/* on a logged-in user. Public routes (`/`, `/auth/*`)
// pass through.
//
// Per Next 16 docs, this is an OPTIMISTIC check — it only reads the session
// cookie. Real authorization still happens close to the data via getCurrentTeacher().
export async function proxy(request: NextRequest) {
  const { supabase, getResponse } = createProxyDbClient(request);

  // Touching getUser() refreshes the session cookie if the access token is
  // close to expiring. Don't put any code between createProxyDbClient and this
  // call — Supabase docs warn that doing so can desync the response.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const path = request.nextUrl.pathname;
  // Only the dashboard + admin pages are user-gated. /auth/* runs the OAuth
  // dance, /api/cron/* uses bearer-token auth — both must be reachable
  // without a session cookie. Admin status itself is checked in the /admin
  // layout (here we only check that the user is signed in at all).
  const isProtected =
    path.startsWith("/dashboard") || path.startsWith("/admin");

  if (isProtected && !user) {
    const url = request.nextUrl.clone();
    url.pathname = "/";
    url.searchParams.set("next", path);
    return NextResponse.redirect(url);
  }

  return getResponse();
}

export const config = {
  // Run on everything except static assets and the Next runtime endpoints.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|svg|jpg|jpeg|gif|webp)).*)"],
};
