import { getCurrentTeacher } from "@/lib/auth/teacher";
import { disconnectCanvas } from "@/lib/actions/canvas-token";
import {
  loadCardTextDefaults,
  loadTeacherCardOverrides,
} from "@/lib/card-text/resolve";
import { ConnectForm } from "./ConnectForm";
import { CardTextEditor } from "./CardTextEditor";

export default async function SetupPage() {
  const teacher = await getCurrentTeacher();
  const isConnected = Boolean(
    teacher.canvas_token_encrypted && teacher.canvas_host,
  );
  const [defaults, overrides] = await Promise.all([
    loadCardTextDefaults(),
    loadTeacherCardOverrides(teacher.id),
  ]);
  const appBaseUrl =
    process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3001";

  // M7.2 — AID's Google OAuth tokens land encrypted (M7.3 scaffolding).
  // Drive scopes are requested at sign-in (auth/login route). A teacher
  // shows as connected once both encrypted tokens are present.
  const driveConnected = Boolean(
    teacher.google_access_token_encrypted &&
      teacher.google_refresh_token_encrypted,
  );
  const driveFolderUrl = teacher.drive_folder_id
    ? `https://drive.google.com/drive/folders/${teacher.drive_folder_id}`
    : null;

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">
          Canvas connection
        </h1>
        <p className="mt-1 text-sm text-stone-600">
          We use your Canvas API token to read your courses and write the AI
          reflection iframe into assignment descriptions on your behalf.
        </p>
      </div>

      {isConnected ? (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 p-4 text-sm">
          <div className="flex items-center gap-2 font-medium text-emerald-900">
            <span className="inline-flex h-2 w-2 rounded-full bg-emerald-500" />
            Connected
          </div>
          <div className="mt-1 text-emerald-800">
            Authenticated on{" "}
            <span className="font-mono text-xs">{teacher.canvas_host}</span>.
            Token is encrypted at rest.
          </div>
          <form action={disconnectCanvas} className="mt-3">
            <button
              type="submit"
              className="text-xs font-medium text-emerald-900 underline underline-offset-2 hover:text-emerald-700"
            >
              Disconnect
            </button>
          </form>
        </div>
      ) : (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-4 text-sm">
          <div className="flex items-center gap-2 font-medium text-amber-900">
            <span className="inline-flex h-2 w-2 rounded-full bg-amber-500" />
            Not connected
          </div>
          <div className="mt-1 text-amber-800">
            Generate a Canvas access token and paste it below to enable course
            and assignment listings.
          </div>
        </div>
      )}

      <div className="rounded-md border border-stone-200 bg-white p-5 text-sm">
        <h2 className="mb-2 text-sm font-semibold text-stone-900">
          {isConnected ? "Replace token" : "Connect Canvas"}
        </h2>
        <ol className="mb-3 list-decimal space-y-1 pl-5 text-xs leading-relaxed text-stone-600">
          <li>
            Open Canvas → <em>Account</em> → <em>Settings</em>.
          </li>
          <li>
            Scroll to <em>Approved Integrations</em> and click{" "}
            <em>+ New Access Token</em>.
          </li>
          <li>
            Give it a name like &ldquo;AI Documenter&rdquo;, leave the
            expiration blank, click <em>Generate Token</em>, and copy the value
            it shows you (Canvas only shows it once).
          </li>
        </ol>
        <ConnectForm />
      </div>

      {/* M7.2 — Google Drive section. Drive ownership is per-teacher; */}
      {/* every finalized reflection auto-saves a Doc into the teacher's */}
      {/* "AI Documenter" folder (M7.3). */}
      <div className="rounded-md border border-stone-200 bg-white p-5 text-sm">
        <h2 className="mb-2 text-sm font-semibold text-stone-900">
          Google Drive
        </h2>
        <p className="mb-3 text-xs text-stone-600">
          Per-teacher OAuth. Drive scopes are requested when you sign in
          with Google. Every finalized reflection auto-creates a Google
          Doc in a per-teacher{" "}
          <strong>AI Documenter</strong> folder; the Canvas comment or
          body carries a link to it in place of the inline transcript.
        </p>
        <dl className="mb-3 grid grid-cols-[8rem_1fr] gap-y-1 text-xs">
          <dt className="text-stone-500">Status</dt>
          <dd>
            {driveConnected ? (
              <span className="text-emerald-800">
                ✓ Connected for {teacher.display_name}
              </span>
            ) : (
              <span className="text-amber-700">
                Not connected — sign out and back in with Google to grant
                Drive scopes.
              </span>
            )}
          </dd>
          {driveConnected && (
            <>
              <dt className="text-stone-500">App folder</dt>
              <dd>
                {driveFolderUrl ? (
                  <a
                    href={driveFolderUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-stone-900 underline-offset-2 hover:underline"
                  >
                    Open &ldquo;AI Documenter&rdquo; in Drive ↗
                  </a>
                ) : (
                  <span className="italic text-stone-500">
                    Auto-created on your first reflection.
                  </span>
                )}
              </dd>
              {teacher.google_token_expires_at && (
                <>
                  <dt className="text-stone-500">Access token expires</dt>
                  <dd className="text-stone-700">
                    {new Date(
                      teacher.google_token_expires_at,
                    ).toLocaleString()}{" "}
                    <span className="text-stone-500">
                      (auto-refreshed when within 5 min of expiry)
                    </span>
                  </dd>
                </>
              )}
            </>
          )}
        </dl>
        {!driveConnected && (
          <form action="/auth/logout" method="post">
            <button
              type="submit"
              className="rounded border border-stone-400 px-3 py-1.5 text-xs font-medium text-stone-900 transition-colors hover:bg-stone-900 hover:text-white"
            >
              Sign out to reconnect
            </button>
          </form>
        )}
      </div>

      <CardTextEditor
        defaults={defaults}
        overrides={overrides}
        appBaseUrl={appBaseUrl}
      />

      <div className="rounded-md border border-stone-200 bg-white p-5 text-sm">
        <h2 className="mb-2 text-sm font-semibold text-stone-900">
          What we use the token for
        </h2>
        <ul className="list-disc space-y-1 pl-5 text-stone-700">
          <li>List your courses and assignments to populate the picker.</li>
          <li>
            Append the AI reflection iframe to selected assignment descriptions
            (idempotently — re-running replaces, never duplicates).
          </li>
          <li>
            Submit each completed reflection to Canvas on the student&apos;s
            behalf as an additional submission.
          </li>
        </ul>
        <p className="mt-2 text-xs text-stone-500">
          We never use it to read student names. All Gemini calls run through a
          PII anonymizer first; Canvas writes are de-anonymized only at the
          edge.
        </p>
      </div>
    </div>
  );
}
