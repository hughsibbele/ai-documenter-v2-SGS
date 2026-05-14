import Link from "next/link";
import { getCurrentTeacher } from "@/lib/auth/teacher";
import { isAdmin } from "@/lib/auth/admin";
import { getServerDbClient } from "@/lib/supabase/server";
import { PromptCard } from "./PromptCard";
import { NewPromptForm } from "./NewPromptForm";
import { ReadOnlyPromptCard } from "./ReadOnlyPromptCard";

export default async function PromptsPage() {
  const teacher = await getCurrentTeacher();
  const viewerIsAdmin = await isAdmin();
  const supabase = await getServerDbClient();

  // RLS returns system prompts + this teacher's personal prompts. Filter to
  // reflection prompts — teachers don't see the objective-summary prompt.
  const [promptsRes, taRes, policiesRes] = await Promise.all([
    supabase
      .from("prompts")
      .select("*")
      .eq("purpose", "reflection")
      .order("scope", { ascending: false })
      .order("is_default", { ascending: false })
      .order("label"),
    supabase
      .from("teacher_assignments")
      .select("prompt_id")
      .eq("teacher_id", teacher.id),
    supabase
      .from("course_install_policies")
      .select("default_prompt_id")
      .eq("teacher_id", teacher.id),
  ]);

  const allPrompts = promptsRes.data ?? [];
  const systemPrompts = allPrompts.filter((p) => p.scope === "system");
  const teacherPrompts = allPrompts.filter((p) => p.scope === "teacher");
  const taList = taRes.data ?? [];
  const policies = policiesRes.data ?? [];

  const assignmentCountByPrompt = new Map<string, number>();
  for (const ta of taList) {
    assignmentCountByPrompt.set(
      ta.prompt_id,
      (assignmentCountByPrompt.get(ta.prompt_id) ?? 0) + 1,
    );
  }
  const policyCountByPrompt = new Map<string, number>();
  for (const p of policies) {
    policyCountByPrompt.set(
      p.default_prompt_id,
      (policyCountByPrompt.get(p.default_prompt_id) ?? 0) + 1,
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">
          Reflection prompts
        </h1>
        <p className="mt-1 text-sm text-stone-600">
          Pick a prompt when you install AI reflection on a Canvas assignment.
          Edits propagate instantly — no reinstall needed.
        </p>
      </div>

      {systemPrompts.length > 0 && (
        <section className="space-y-3">
          <div className="flex items-baseline justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-500">
              School prompts
            </h2>
            {viewerIsAdmin && (
              <Link
                href="/admin/prompts"
                className="text-xs text-dark-blue hover:underline"
              >
                Edit in admin →
              </Link>
            )}
          </div>
          <p className="text-xs text-stone-500">
            Shared across all teachers. {viewerIsAdmin
              ? "You can edit these in the admin console."
              : "Only admins can edit these."}
          </p>
          <div className="space-y-3">
            {systemPrompts.map((p) => (
              <ReadOnlyPromptCard
                key={p.id}
                prompt={p}
                assignmentsUsing={assignmentCountByPrompt.get(p.id) ?? 0}
                policiesUsing={policyCountByPrompt.get(p.id) ?? 0}
              />
            ))}
          </div>
        </section>
      )}

      <section className="space-y-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-500">
            Your prompts
          </h2>
          <NewPromptForm />
        </div>
        <p className="text-xs text-stone-500">
          Personal to you. You can create as many as you like.
        </p>
        {teacherPrompts.length === 0 ? (
          <div className="rounded-md border border-dashed border-stone-300 bg-white p-4 text-center text-xs text-stone-500">
            You haven&apos;t created any personal prompts yet.
          </div>
        ) : (
          <div className="space-y-3">
            {teacherPrompts.map((p) => (
              <PromptCard
                key={p.id}
                prompt={p}
                assignmentsUsing={assignmentCountByPrompt.get(p.id) ?? 0}
                policiesUsing={policyCountByPrompt.get(p.id) ?? 0}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
