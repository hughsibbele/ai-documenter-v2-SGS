import Link from "next/link";
import { redirect } from "next/navigation";
import { getServerDbClient } from "@/lib/supabase/server";
import { BrandHeader } from "@/components/brand/BrandHeader";

const ERROR_MESSAGES: Record<string, string> = {
  domain_not_allowed:
    "Sign-in is restricted to @episcopalhighschool.org Google accounts.",
  missing_code: "Sign-in didn't complete. Please try again.",
  no_user: "Sign-in didn't complete. Please try again.",
  oauth_init_failed:
    "Couldn't start the Google sign-in. Please try again in a moment.",
};

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ auth_error?: string; next?: string }>;
}) {
  const supabase = await getServerDbClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (user) redirect("/dashboard");

  const { auth_error, next } = await searchParams;
  const errorMessage =
    auth_error && (ERROR_MESSAGES[auth_error] ?? `Sign-in failed: ${auth_error}`);

  const loginHref = next
    ? `/auth/login?next=${encodeURIComponent(next)}`
    : "/auth/login";

  return (
    <div className="flex min-h-dvh flex-col bg-paper">
      <BrandHeader eyebrow="AI Documenter" />

      <main className="flex-1 px-6 py-16">
        <article className="mx-auto w-full max-w-2xl space-y-10">
          <header className="space-y-4">
            <div className="ehs-eyebrow text-maroon">For teachers</div>
            <h1 className="text-4xl leading-[1.15] text-ink">
              Install AI-use reflections on your Canvas assignments.
            </h1>
            <p className="text-base leading-relaxed text-cool-gray">
              Pick a Canvas course, pick the assignments you want to enable,
              and we&rsquo;ll add a branded reflection card to each
              assignment&rsquo;s description. Students click through to a short
              Socratic reflection that submits back to Canvas automatically.
            </p>
          </header>

          <hr className="ehs-rule" />

          <section className="space-y-3">
            <div className="ehs-eyebrow text-cool-gray">Setup &mdash; once</div>
            <ol className="space-y-2.5 text-sm leading-relaxed text-ink">
              <li className="flex gap-3">
                <span className="text-maroon">i.</span>
                <span>
                  Sign in with your @episcopalhighschool.org Google account.
                </span>
              </li>
              <li className="flex gap-3">
                <span className="text-maroon">ii.</span>
                <span>
                  Paste a Canvas API token (we&rsquo;ll show you where to get
                  one).
                </span>
              </li>
              <li className="flex gap-3">
                <span className="text-maroon">iii.</span>
                <span>
                  Pick a reflection prompt &mdash; the school default works, or
                  write your own.
                </span>
              </li>
            </ol>
          </section>

          {errorMessage && (
            <div
              role="alert"
              className="rounded-sm border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900"
            >
              {errorMessage}
            </div>
          )}

          <div className="space-y-2 pt-2">
            <Link
              href={loginHref}
              className="inline-flex w-full items-center justify-center gap-2.5 rounded-sm bg-maroon px-5 py-3 text-sm font-medium text-white transition-colors hover:bg-maroon-dark"
            >
              <GoogleMark />
              Sign in with EHS Google
            </Link>
            <p className="text-center text-xs italic text-cool-gray">
              EHS Workspace accounts only.
            </p>
          </div>
        </article>
      </main>

      <footer className="px-6 py-6 text-center text-xs italic text-cool-gray">
        AI Documenter &middot; Episcopal High School
      </footer>
    </div>
  );
}

function GoogleMark() {
  return (
    <svg
      aria-hidden="true"
      width="16"
      height="16"
      viewBox="0 0 18 18"
      className="rounded-full bg-white p-0.5"
    >
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.47-.81 5.96-2.18l-2.92-2.26c-.81.54-1.84.86-3.04.86a5.27 5.27 0 0 1-4.96-3.66H.96v2.3A9 9 0 0 0 9 18z"
      />
      <path
        fill="#FBBC05"
        d="M4.04 10.76A5.4 5.4 0 0 1 3.76 9c0-.61.1-1.2.28-1.76V4.94H.96A9 9 0 0 0 0 9c0 1.45.35 2.83.96 4.06l3.08-2.3z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.32 0 2.51.45 3.44 1.35l2.59-2.59C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.94l3.08 2.3A5.27 5.27 0 0 1 9 3.58z"
      />
    </svg>
  );
}
