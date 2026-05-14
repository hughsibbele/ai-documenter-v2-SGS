import { NextResponse, type NextRequest } from "next/server";
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
  const { error: exchangeError } =
    await supabase.auth.exchangeCodeForSession(code);

  if (exchangeError) {
    return redirectWithError(request, exchangeError.message, next);
  }

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
      const admin = createAdminDbClient();
      const { error: upsertError } = await admin
        .from("teachers")
        .upsert(
          {
            auth_user_id: user.id,
            email,
            display_name: displayName,
            google_sub: googleSub,
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
  return NextResponse.redirect(dest);
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
