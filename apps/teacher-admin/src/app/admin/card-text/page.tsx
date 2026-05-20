import { loadCardTextDefaultsRow } from "@/lib/card-text/resolve";
import { CardTextDefaultsEditor } from "./CardTextDefaultsEditor";

export default async function AdminCardTextPage() {
  const defaults = await loadCardTextDefaultsRow();
  const appBaseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3001";

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">
          Canvas card text — system defaults
        </h1>
        <p className="mt-1 text-sm text-cool-gray">
          What teachers see as the placeholder fallback in their own
          per-teacher overrides. Changes apply to anyone who hasn&apos;t
          overridden the field on their{" "}
          <code className="rounded bg-paper px-1">/dashboard/setup</code>{" "}
          page.
        </p>
      </div>
      <CardTextDefaultsEditor initial={defaults} appBaseUrl={appBaseUrl} />
    </div>
  );
}
