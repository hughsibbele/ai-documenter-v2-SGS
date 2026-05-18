import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { buildReflectionBlock } from "@ai-documenter/canvas";
import { getCurrentTeacher } from "@/lib/auth/teacher";
import { getServerDbClient } from "@/lib/supabase/server";
import { DEFAULT_STUDENT_FACING_QUESTION } from "@/lib/iframe/resolve";
import PreviewFlow from "./PreviewFlow";

// Two Gemini calls run on bootstrap (summary + alignment Q); same as the real
// student route's reasoning for raising the timeout.
export const maxDuration = 60;

export default async function PromptPreviewPage({
  params,
}: {
  params: Promise<{ promptId: string }>;
}) {
  const { promptId } = await params;

  // Authz: teacher must exist. RLS on the prompts table handles "is this row
  // visible to this teacher" — system prompts are visible to all; teacher-
  // scope prompts are visible to their owner. A teacher viewing someone
  // else's prompt id returns notFound here.
  await getCurrentTeacher();
  const supabase = await getServerDbClient();
  const { data: prompt } = await supabase
    .from("prompts")
    .select("*")
    .eq("id", promptId)
    .eq("purpose", "reflection")
    .maybeSingle();

  if (!prompt) notFound();

  const studentFacingQuestion =
    prompt.student_facing_question?.trim() || DEFAULT_STUDENT_FACING_QUESTION;

  // Render the actual Canvas card HTML so the teacher sees what their
  // students see at the top of the assignment description. Use the request's
  // own host so the logo image loads from the same origin the teacher is on
  // — env-var fallbacks point at a stale prod that 404s in dev. The card's
  // "Open reflection →" anchor is intercepted on the client to advance the
  // preview state rather than navigating.
  const h = await headers();
  const host = h.get("host") ?? "localhost:3001";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const cardHtml = buildReflectionBlock({
    appBaseUrl: `${proto}://${host}`,
    iframeToken: "preview",
    promptVersion: 0,
  });

  return (
    <PreviewFlow
      promptId={prompt.id}
      promptLabel={prompt.label}
      studentFacingQuestion={studentFacingQuestion}
      cardHtml={cardHtml}
    />
  );
}
