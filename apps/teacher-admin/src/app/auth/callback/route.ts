import { NextResponse, type NextRequest } from "next/server";
import { encryptSecret } from "@ai-documenter/crypto";
import { createAdminDbClient } from "@ai-documenter/db/admin";
import { getServerDbClient } from "@/lib/supabase/server";
import { upsertStudentFromAuth } from "@/lib/auth/student";

const ALLOWED_DOMAIN = "episcopalhighschool.org";

// Unified OAuth callback for teachers AND students. The flow we're in is
// detected from the `next` query param — entries that start with `/r/` are
// student reflections, everything else is teacher-admin. Single Supabase
// redirect URL, single code path, same domain enforcement either way.
export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const next = request.nextUrl.searchParams.get("next") ?? "/dashboard";

  if (!code) return redirectWithError(request, "missing_code", next);

  const supabase = await getServerDbClient();
  const { data: exchanged, error: exchangeError } =
    await supabase.auth.exchangeCodeForSession(code);

  if (exchangeError) {
    return redirectWithError(request, exchangeError.message, next);
  }

  const session = exchanged.session;
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user || !user.email) {
    return redirectWithError(request, "no_user", next);
  }

  const email = user.email.toLowerCase();
  if (!email.endsWith(`@${ALLOWED_DOMAIN}`)) {
    await supabase.auth.signOut();
    return redirectWithError(request, "domain_not_allowed", next);
  }

  const googleIdentity = user.identities?.find((i) => i.provider === "google");
  const googleSub =
    (googleIdentity?.identity_data?.sub as string | undefined) ?? null;

  const meta = user.user_metadata ?? {};
  const displayName =
    (meta.full_name as string | undefined) ??
    (meta.name as string | undefined) ??
    email.split("@")[0];

  const isStudentFlow = next.startsWith("/r/");

  try {
    if (isStudentFlow) {
      await upsertStudentFromAuth({
        id: user.id,
        email,
        display_name: displayName,
        google_sub: googleSub,
      });
    } else {
      // Service-role upsert: teachers has no INSERT policy by design.
      // M7.3 — capture the Google provider tokens too so server-side
      // Drive writes can fire without re-prompting the teacher.
      // Refresh_token is only returned on first consent (login route
      // sets prompt=consent + access_type=offline to force it). The
      // Google access_token's lifetime is ~1h; we conservatively
      // record expires_at at 55 min so the refresh helper triggers
      // before the boundary.
      const providerToken = session?.provider_token ?? null;
      const providerRefreshToken = session?.provider_refresh_token ?? null;
      const tokenExpiresAt = providerToken
        ? new Date(Date.now() + 55 * 60 * 1000).toISOString()
        : null;

      const tokenUpdates: Record<string, string | null> = {};
      if (providerToken) {
        const key = process.env.TEACHER_GTOKEN_ENC_KEY;
        if (!key) {
          // Fail loud — silent plaintext fallback would re-open the
          // at-rest leak this column shape exists to close.
          return redirectWithError(
            request,
            "TEACHER_GTOKEN_ENC_KEY not configured",
            next,
          );
        }
        tokenUpdates.google_access_token_encrypted = encryptSecret(
          providerToken,
          key,
        );
        if (tokenExpiresAt) {
          tokenUpdates.google_token_expires_at = tokenExpiresAt;
        }
        if (providerRefreshToken) {
          tokenUpdates.google_refresh_token_encrypted = encryptSecret(
            providerRefreshToken,
            key,
          );
        }
      }

      const admin = createAdminDbClient();
      const { error: upsertError } = await admin
        .from("teachers")
        .upsert(
          {
            auth_user_id: user.id,
            email,
            display_name: displayName,
            google_sub: googleSub,
            ...tokenUpdates,
          },
          { onConflict: "auth_user_id" },
        )
        .select("id")
        .single();
      if (upsertError) {
        return redirectWithError(request, upsertError.message, next);
      }
    }
  } catch (err) {
    return redirectWithError(request, (err as Error).message, next);
  }

  const dest = request.nextUrl.clone();
  dest.pathname = next.startsWith("/") ? next : "/dashboard";
  dest.search = "";
  const response = NextResponse.redirect(dest);
  if (session?.provider_refresh_token) {
    response.cookies.set("_grt", "1", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 365 * 24 * 60 * 60,
      path: "/",
    });
  }
  return response;
}

function redirectWithError(
  request: NextRequest,
  message: string,
  next: string,
) {
  const url = request.nextUrl.clone();
  // Send the user back where they started. Students return to /r/<token>
  // so the welcome screen can surface the error; teachers return to the
  // sign-in landing.
  url.pathname = next.startsWith("/r/") ? next : "/";
  url.search = "";
  url.searchParams.set("auth_error", message);
  return NextResponse.redirect(url);
}
