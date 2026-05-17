import "server-only";

import type { Tables } from "@ai-documenter/db";

type Teacher = Tables<"teachers">;
type Student = Tables<"students">;
type ReflectionSession = Tables<"reflection_sessions">;
type TeacherAssignment = Tables<"teacher_assignments">;

export type NotifyResult =
  | { ok: true; status: number }
  | { ok: false; error: string; skipped: boolean };

type AiChat = { tool: string; url: string; transcript_text: string | null };
type SocraticMessage = { role: "ai" | "student"; text: string; ts: string };

/**
 * Fire-and-forget POST to super-grader's `/api/ingest/ai_documenter` webhook.
 *
 * Envelope shape mirrors super-grader's integration-contract §4 (the same
 * shape as the GET response). Idempotent on
 * `(peer, canvas_user_id, canvas_assignment_id)` — super-grader upserts.
 *
 * Auth: bearer token via `SUPER_GRADER_INGEST_TOKEN`. URL via
 * `SUPER_GRADER_API_URL`. If either env var is missing we skip and return
 * a `skipped:true` failure — the student's Canvas submission isn't blocked
 * by super-grader being unreachable.
 *
 * Returns the status so the caller can log it. The student-facing flow
 * doesn't surface this failure; super-grader retries via its own pull-on-view
 * path next time the teacher loads the assignment.
 */
export async function notifySuperGrader(args: {
  session: ReflectionSession;
  teacher: Teacher;
  teacherAssignment: TeacherAssignment;
  student: Student;
}): Promise<NotifyResult> {
  const baseUrl = process.env.SUPER_GRADER_API_URL?.replace(/\/$/, "");
  const token = process.env.SUPER_GRADER_INGEST_TOKEN;
  // M4.3 transition: prefer NEXT_PUBLIC_APP_URL; fall back to legacy name.
  const appUrl = (
    process.env.NEXT_PUBLIC_APP_URL ?? process.env.NEXT_PUBLIC_STUDENT_FORM_URL
  )?.replace(/\/$/, "");

  if (!baseUrl || !token) {
    return {
      ok: false,
      error:
        "SUPER_GRADER_API_URL or SUPER_GRADER_INGEST_TOKEN not set — webhook skipped.",
      skipped: true,
    };
  }

  if (!appUrl) {
    // Super-grader's envelope validator rejects an empty links.detail_url.
    // Better to skip the webhook than POST something that 422s on the
    // other side and trips an alert. Surface as skipped so the closing
    // pipeline doesn't show this as a hard failure to the student.
    return {
      ok: false,
      error:
        "NEXT_PUBLIC_APP_URL (or legacy NEXT_PUBLIC_STUDENT_FORM_URL) not set — webhook skipped (super-grader requires a detail_url).",
      skipped: true,
    };
  }

  if (!args.student.canvas_user_id) {
    return {
      ok: false,
      error: "Student has no canvas_user_id — webhook skipped.",
      skipped: true,
    };
  }

  const envelope = buildEnvelope(args, appUrl);

  try {
    const res = await fetch(`${baseUrl}/api/ingest/ai_documenter`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(envelope),
    });
    if (!res.ok) {
      const body = await safeText(res);
      return {
        ok: false,
        error: `super-grader returned ${res.status}: ${body.slice(0, 200)}`,
        skipped: false,
      };
    }
    return { ok: true, status: res.status };
  } catch (err) {
    return {
      ok: false,
      error: `super-grader fetch failed: ${(err as Error).message}`,
      skipped: false,
    };
  }
}

// ---------------------------------------------------------------------------

function buildEnvelope(
  args: {
    session: ReflectionSession;
    teacher: Teacher;
    teacherAssignment: TeacherAssignment;
    student: Student;
  },
  appUrl: string,
) {
  const { session, teacherAssignment, student } = args;
  const completedAt =
    session.submitted_at ?? session.completed_at ?? new Date().toISOString();

  // Phase D's review surface. Required (not optional) because super-grader's
  // validatePeerEnvelope rejects an envelope with `links.detail_url` missing
  // or empty. Caller guarantees appUrl is set before we get here.
  const detailUrl = `${appUrl}/dashboard/reviews/${encodeURIComponent(
    teacherAssignment.canvas_course_id,
  )}/${encodeURIComponent(teacherAssignment.canvas_assignment_id)}#session-${encodeURIComponent(session.id)}`;

  return {
    schema_version: 1,
    peer: "ai_documenter" as const,
    canvas_user_id: student.canvas_user_id!,
    canvas_assignment_id: teacherAssignment.canvas_assignment_id,
    anon_token: student.anon_token,
    completed_at: completedAt,
    summary: {
      session_id: session.id,
      time_spent_estimate: session.time_spent_estimate,
      tools_used: (session.ai_tools_used ?? []) as string[],
      ai_chats: ((session.ai_chats as AiChat[] | null) ?? []).map((c) => ({
        tool: c.tool,
        url: c.url,
      })),
      paste_fallback_text: session.paste_fallback_text,
      first_draft: session.first_draft,
      socratic_messages:
        (session.reflection_messages as SocraticMessage[] | null) ?? [],
      objective_summary: session.objective_summary,
    },
    links: { detail_url: detailUrl },
  };
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "(no body)";
  }
}
