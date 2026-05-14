import { createAdminDbClient } from "@ai-documenter/db/admin";
import { SystemPromptCard } from "./SystemPromptCard";
import { NewSystemPromptForm } from "./NewSystemPromptForm";

export default async function AdminPromptsPage() {
  // Service-role read so we get cross-teacher counts.
  const admin = createAdminDbClient();

  const [promptsRes, taRes, policiesRes] = await Promise.all([
    admin
      .from("prompts")
      .select("*")
      .eq("scope", "system")
      .order("is_default", { ascending: false })
      .order("label"),
    admin.from("teacher_assignments").select("prompt_id"),
    admin.from("course_install_policies").select("default_prompt_id"),
  ]);

  const prompts = promptsRes.data ?? [];
  const reflectionPrompts = prompts.filter((p) => p.purpose === "reflection");
  const summaryPrompts = prompts.filter((p) => p.purpose === "objective_summary");
  const taList = taRes.data ?? [];
  const policies = policiesRes.data ?? [];

  const assignmentCount = new Map<string, number>();
  for (const ta of taList) {
    assignmentCount.set(
      ta.prompt_id,
      (assignmentCount.get(ta.prompt_id) ?? 0) + 1,
    );
  }
  const policyCount = new Map<string, number>();
  for (const p of policies) {
    policyCount.set(
      p.default_prompt_id,
      (policyCount.get(p.default_prompt_id) ?? 0) + 1,
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">System prompts</h1>
        <p className="mt-1 text-sm text-stone-600">
          School-wide prompts. Edits propagate instantly — no Canvas re-write
          needed, since the student-form reads the prompt body live.
        </p>
      </div>

      <section className="space-y-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-500">
            Reflection prompts
          </h2>
          <NewSystemPromptForm />
        </div>
        <p className="text-xs text-stone-500">
          Visible to every teacher in their install picker. The Default is
          what new course installs use unless the teacher picks something
          else.
        </p>
        <div className="space-y-4">
          {reflectionPrompts.map((p) => (
            <SystemPromptCard
              key={p.id}
              prompt={p}
              assignmentsUsing={assignmentCount.get(p.id) ?? 0}
              policiesUsing={policyCount.get(p.id) ?? 0}
            />
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-500">
          Objective summary prompt
        </h2>
        <p className="text-xs text-stone-500">
          Used after every reflection completes to generate a short,
          descriptive summary of the student&apos;s AI use. The summary is
          posted to Canvas alongside the reflection. Teachers can&apos;t
          edit this — only admins.
        </p>
        {summaryPrompts.length === 0 ? (
          <div className="rounded-md border border-dashed border-stone-300 bg-white p-4 text-center text-xs text-stone-500">
            No objective-summary prompt seeded.
          </div>
        ) : (
          <div className="space-y-4">
            {summaryPrompts.map((p) => (
              <SystemPromptCard
                key={p.id}
                prompt={p}
                assignmentsUsing={0}
                policiesUsing={0}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
