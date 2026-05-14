import {
  resolveIframeToken,
  DEFAULT_STUDENT_FACING_QUESTION,
} from "@/lib/iframe/resolve";
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
