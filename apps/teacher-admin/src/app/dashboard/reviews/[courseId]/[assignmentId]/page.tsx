import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentTeacher } from "@/lib/auth/teacher";
import {
  loadAssignmentReview,
  type ReflectionView,
} from "@/lib/reviews/load";
import { ReviewClient } from "./ReviewClient";

export default async function ReviewPage({
  params,
}: {
  params: Promise<{ courseId: string; assignmentId: string }>;
}) {
  const { courseId, assignmentId } = await params;
  const teacher = await getCurrentTeacher();
  const bundle = await loadAssignmentReview(courseId, assignmentId);

  if (!bundle) notFound();

  const canvasAssignmentUrl = teacher.canvas_host
    ? `https://${teacher.canvas_host}/courses/${courseId}/assignments/${assignmentId}`
    : null;

  return (
    <div className="mx-auto max-w-5xl space-y-3 px-1">
      <div className="flex items-baseline justify-between">
        <div>
          <Link
            href="/dashboard/reviews"
            className="text-xs text-cool-gray hover:text-maroon"
          >
            ← All reviews
          </Link>
          <h1 className="mt-1 text-xl font-semibold tracking-tight">
            {bundle.assignmentName ?? "(unnamed assignment)"}
          </h1>
          <div className="mt-0.5 text-xs italic text-cool-gray">
            {bundle.courseName ?? "(unnamed course)"}
          </div>
        </div>
        {canvasAssignmentUrl && (
          <a
            href={canvasAssignmentUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-cool-gray underline-offset-2 hover:text-maroon hover:underline"
          >
            Open in Canvas ↗
          </a>
        )}
      </div>

      <ReviewClient
        reflections={serializeForClient(bundle.reflections)}
        canvasHost={teacher.canvas_host}
        canvasCourseId={courseId}
        canvasAssignmentId={assignmentId}
      />
    </div>
  );
}

// Server-component → client-component prop boundary: trim to JSON-friendly
// shape and pre-parse the JSONB blobs so the client doesn't have to type-
// narrow `Json`.
function serializeForClient(
  reflections: ReflectionView[],
): SerializedReflection[] {
  return reflections.map((r) => {
    const messages = Array.isArray(r.session.reflection_messages)
      ? (r.session.reflection_messages as unknown as {
          role: "ai" | "student";
          text: string;
          ts: string;
        }[])
      : [];
    const aiChats = Array.isArray(r.session.ai_chats)
      ? (r.session.ai_chats as unknown as {
          tool: string;
          url: string;
          transcript_text: string | null;
        }[])
      : [];
    return {
      sessionId: r.session.id,
      state: r.session.state,
      createdAt: r.session.created_at,
      completedAt: r.session.completed_at,
      submittedAt: r.session.submitted_at,
      canvasSubmissionId: r.session.canvas_submission_id,
      completionCode: r.session.completion_code,
      timeSpent: r.session.time_spent_estimate,
      firstDraft: r.session.first_draft,
      objectiveSummary: r.session.objective_summary,
      reflectionMessages: messages,
      aiChats,
      pasteFallback: r.session.paste_fallback_text,
      student: {
        id: r.student.id,
        displayName: r.student.display_name,
        email: r.student.email,
        canvasUserId: r.student.canvas_user_id,
      },
      latestAttempt: r.latestAttempt
        ? {
            success: r.latestAttempt.success,
            error: r.latestAttempt.error,
            attemptedAt: r.latestAttempt.attempted_at,
          }
        : null,
    };
  });
}

export type SerializedReflection = {
  sessionId: string;
  state: "started" | "in_progress" | "completed" | "submitted" | "failed";
  createdAt: string;
  completedAt: string | null;
  submittedAt: string | null;
  canvasSubmissionId: string | null;
  completionCode: string;
  timeSpent: string | null;
  firstDraft: string | null;
  objectiveSummary: string | null;
  reflectionMessages: { role: "ai" | "student"; text: string; ts: string }[];
  aiChats: { tool: string; url: string; transcript_text: string | null }[];
  pasteFallback: string | null;
  student: {
    id: string;
    displayName: string;
    email: string;
    canvasUserId: string | null;
  };
  latestAttempt: {
    success: boolean;
    error: string | null;
    attemptedAt: string;
  } | null;
};
