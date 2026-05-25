import Link from "next/link";
import {
  resolveIframeToken,
  DEFAULT_STUDENT_FACING_QUESTION,
} from "@/lib/iframe/resolve";
import { tryGetCurrentTeacher } from "@/lib/auth/teacher";
import StudentFlow from "./StudentFlow";

export const dynamic = "force-dynamic";
// Server action calls into Gemini with URL-context grounding can take 20-40s
// (Google fetches the share-link page on its side). 10s default would 504
// before the model finishes.
export const maxDuration = 60;

// Token comes from the /r/<token> dynamic segment. DB column `iframe_token`
// is the opaque entry token — the name is historical.
//
// auth_error is set by /auth/callback when sign-in fails (domain mismatch,
// OAuth error, etc.) — the welcome screen surfaces it.
export default async function ReflectionRoute({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ auth_error?: string }>;
}) {
  const { token = "" } = await params;
  const { auth_error } = await searchParams;
  const ctx = token ? await resolveIframeToken(token) : null;

  // M7.11 — detect if the visitor is the teacher who owns this assignment.
  // If so, offer a preview affordance before the student gate kicks in.
  const teacher = await tryGetCurrentTeacher();
  const isOwner =
    teacher && ctx && teacher.id === ctx.teacherAssignment.teacher_id;
  const promptId = ctx?.prompt.id ?? null;

  if (isOwner && promptId) {
    return (
      <div className="mx-auto max-w-md px-4 pt-24 text-center space-y-4">
        <p className="text-sm text-stone-600">
          You&rsquo;re the teacher for this assignment.
        </p>
        <Link
          href={`/dashboard/prompts/${promptId}/preview`}
          className="inline-block rounded bg-maroon px-4 py-2 text-sm font-medium text-white hover:bg-maroon/90"
        >
          Preview as student
        </Link>
        <p className="text-xs text-stone-400">
          Or{" "}
          <Link href="/dashboard" className="underline">
            back to dashboard
          </Link>
        </p>
      </div>
    );
  }

  // Pull the student-facing question off the bound prompt. Falls back to a
  // sensible default for older teacher-scope prompts that pre-date M3.1.
  const studentFacingQuestion =
    ctx?.prompt.student_facing_question?.trim() ||
    DEFAULT_STUDENT_FACING_QUESTION;

  return (
    <StudentFlow
      iframeToken={token}
      ctxValid={ctx !== null}
      courseName={ctx?.courseName ?? null}
      assignmentName={ctx?.assignmentName ?? null}
      studentFacingQuestion={studentFacingQuestion}
      initialAuthError={auth_error ?? null}
    />
  );
}
