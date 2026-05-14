import { createAdminDbClient } from "@ai-documenter/db/admin";
import { authorizeSuperGraderRequest } from "@/lib/super-grader/auth";

type AiChat = { tool: string; url: string; transcript_text: string | null };
type SocraticMessage = { role: "ai" | "student"; text: string; ts: string };

/**
 * `GET /api/super-grader/result?canvas_user_id=…&canvas_assignment_id=…`
 *
 * Pull-on-view counterpart to the POST `/api/ingest/ai_documenter` webhook
 * on super-grader's side. Super-grader's E8 "AI Use" card calls this when
 * the teacher loads a student's submission, so the card always reflects the
 * latest AI Documenter state even if the original webhook was dropped or
 * fired before the student finished.
 *
 * Envelope mirrors super-grader integration-contract §4 exactly — same
 * shape as what `notifySuperGrader` POSTs, so super-grader can use one
 * deserializer for both paths.
 *
 * Auth: bearer `AI_DOCUMENTER_API_TOKEN`.
 *
 * Lookup:
 *   1. students by canvas_user_id (canonical join key; if the student hasn't
 *      had canvas_user_id backfilled yet, no result).
 *   2. teacher_assignments by canvas_assignment_id (one or more rows — a
 *      Canvas assignment could in principle be co-taught; we accept any
 *      install).
 *   3. reflection_sessions filtered to those teacher_assignment ids +
 *      that student, ordered by submitted_at DESC NULLS LAST so a submitted
 *      session always wins over a completed-but-not-submitted one.
 *
 * Returns 404 when no session exists. 200 OK when one does. Cache-Control
 * is private + short — super-grader makes one call per teacher view, and
 * the result can change as students resubmit, but back-to-back loads in
 * the same minute can safely re-use.
 */
export async function GET(request: Request): Promise<Response> {
  const denied = authorizeSuperGraderRequest(request);
  if (denied) return denied;

  const url = new URL(request.url);
  const canvasUserId = url.searchParams.get("canvas_user_id");
  const canvasAssignmentId = url.searchParams.get("canvas_assignment_id");

  if (!canvasUserId || !canvasAssignmentId) {
    return Response.json(
      {
        ok: false,
        error:
          "Both `canvas_user_id` and `canvas_assignment_id` query params are required.",
      },
      { status: 400 },
    );
  }

  const admin = createAdminDbClient();

  const { data: student, error: studentErr } = await admin
    .from("students")
    .select("id, anon_token, canvas_user_id")
    .eq("canvas_user_id", canvasUserId)
    .maybeSingle();
  if (studentErr) {
    return Response.json(
      { ok: false, error: studentErr.message },
      { status: 500 },
    );
  }
  if (!student) {
    return Response.json(
      { ok: false, error: "No student with that canvas_user_id." },
      { status: 404 },
    );
  }

  const { data: teacherAssignments, error: taErr } = await admin
    .from("teacher_assignments")
    .select("id, canvas_course_id, canvas_assignment_id")
    .eq("canvas_assignment_id", canvasAssignmentId);
  if (taErr) {
    return Response.json(
      { ok: false, error: taErr.message },
      { status: 500 },
    );
  }
  const taIds = (teacherAssignments ?? []).map((t) => t.id);
  if (taIds.length === 0) {
    return Response.json(
      {
        ok: false,
        error: "AI Documenter isn't installed on that assignment.",
      },
      { status: 404 },
    );
  }

  const { data: session, error: sessionErr } = await admin
    .from("reflection_sessions")
    .select("*")
    .eq("student_id", student.id)
    .in("teacher_assignment_id", taIds)
    .order("submitted_at", { ascending: false, nullsFirst: false })
    .order("completed_at", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (sessionErr) {
    return Response.json(
      { ok: false, error: sessionErr.message },
      { status: 500 },
    );
  }
  if (!session) {
    return Response.json(
      {
        ok: false,
        error:
          "No reflection session for that student on that assignment yet.",
      },
      { status: 404 },
    );
  }

  // Map back to the teacher_assignments row that owns this session — we need
  // its canvas_course_id to build the detail_url.
  const ta = (teacherAssignments ?? []).find(
    (t) => t.id === session.teacher_assignment_id,
  );

  const appUrl = process.env.NEXT_PUBLIC_STUDENT_FORM_URL?.replace(/\/$/, "");
  if (!appUrl || !ta) {
    // Super-grader's validatePeerEnvelope rejects an empty links.detail_url.
    // Better to surface "AI Documenter misconfigured" as a 500 than silently
    // return a payload that super-grader will mark `invalid` and hide.
    return Response.json(
      {
        error:
          "NEXT_PUBLIC_STUDENT_FORM_URL is not configured on this deploy; cannot build a valid detail_url.",
      },
      { status: 500 },
    );
  }

  const detailUrl = `${appUrl}/dashboard/reviews/${encodeURIComponent(
    ta.canvas_course_id,
  )}/${encodeURIComponent(ta.canvas_assignment_id)}#session-${encodeURIComponent(session.id)}`;

  const completedAt =
    session.submitted_at ?? session.completed_at ?? session.created_at;

  const aiChats = ((session.ai_chats as AiChat[] | null) ?? []).map((c) => ({
    tool: c.tool,
    url: c.url,
  }));
  const socraticMessages =
    (session.reflection_messages as SocraticMessage[] | null) ?? [];

  const envelope = {
    schema_version: 1,
    peer: "ai_documenter" as const,
    canvas_user_id: canvasUserId,
    canvas_assignment_id: canvasAssignmentId,
    anon_token: student.anon_token,
    completed_at: completedAt,
    summary: {
      // Extra fields beyond AiDocumenterSummary are non-breaking per
      // integration-contract §8. session_id + state are useful for
      // teacher-side debugging in super-grader's prompts/audit views.
      session_id: session.id,
      state: session.state,
      time_spent_estimate: session.time_spent_estimate,
      tools_used: session.ai_tools_used ?? [],
      ai_chats: aiChats,
      paste_fallback_text: session.paste_fallback_text,
      first_draft: session.first_draft,
      socratic_messages: socraticMessages,
      objective_summary: session.objective_summary,
    },
    links: { detail_url: detailUrl },
  };

  return Response.json(envelope, {
    headers: {
      "Cache-Control": "private, max-age=30",
    },
  });
}
