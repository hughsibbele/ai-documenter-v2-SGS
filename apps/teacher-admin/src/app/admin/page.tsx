import Link from "next/link";

export default function AdminHome() {
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Admin console</h1>
        <p className="mt-1 text-sm text-stone-600">
          School-wide settings. Changes here affect every teacher using AI
          Documenter at EHS.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Tile
          href="/admin/prompts"
          title="System prompts"
          description="Edit the shared Default prompt and any other prompts every teacher should see in their picker."
        />
        <Tile
          href="/admin/admins"
          title="Admins"
          description="Grant or revoke admin access. Last admin can't be revoked."
        />
        <Tile
          href="/admin/retention"
          title="Retention"
          description="Export and hard-delete reflection data per course or school-wide. End-of-year sweep lives here."
        />
      </div>
    </div>
  );
}

function Tile({
  href,
  title,
  description,
}: {
  href: string;
  title: string;
  description: string;
}) {
  return (
    <Link
      href={href}
      className="group block rounded-md border border-stone-200 bg-white p-5 transition-colors hover:border-dark-blue/40 hover:bg-stone-50"
    >
      <div className="text-sm font-semibold text-stone-900 group-hover:text-dark-blue">
        {title} →
      </div>
      <p className="mt-1 text-xs leading-relaxed text-stone-600">
        {description}
      </p>
    </Link>
  );
}
