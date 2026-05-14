import { getCurrentTeacher } from "@/lib/auth/teacher";
import { disconnectCanvas } from "@/lib/actions/canvas-token";
import { ConnectForm } from "./ConnectForm";

export default async function SetupPage() {
  const teacher = await getCurrentTeacher();
  const isConnected = Boolean(
    teacher.canvas_token_encrypted && teacher.canvas_host,
  );

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
