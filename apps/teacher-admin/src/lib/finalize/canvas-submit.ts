import "server-only";

import {
  CanvasError,
  lookupCourseStudentByEmail,
  postSubmissionCommentAsStudent,
  submitTextEntryAsStudent,
  type CanvasConfig,
} from "@ai-documenter/canvas";
import { anonToken, readSaltFromEnv } from "@ai-documenter/anonymizer";
import { decryptSecret, readKeyFromEnv } from "@ai-documenter/crypto";
import { createAdminDbClient } from "@ai-documenter/db/admin";
import type { Tables } from "@ai-documenter/db";

type Teacher = Tables<"teachers">;
type Student = Tables<"students">;
type ReflectionSession = Tables<"reflection_sessions">;
type TeacherAssignment = Tables<"teacher_assignments">;

export type CanvasSubmitResult =
  | { ok: true; submissionId: number; canvasUserId: string }
  | { ok: false; error: string; needsCompletionCode: boolean };

export type ReflectionMessage = {
  role: "ai" | "student";
  text: string;
  ts: string;
};
type AiChat = { tool: string; url: string; transcript_text: string | null };

/**
 * Build the Canvas submission body and POST it as the student.
 *
 * M6.18a — destination is now the triple `{post_to_drive,
 * post_to_canvas_comment, post_to_canvas_submission}` on teacher_assignments.
 * This finalizer only handles the Canvas legs; Drive write fires when M7.3
 * lands. Canvas leg branches on the submission flag:
 *
 *   - **post_to_canvas_submission=false** — comment-only path (or no-op if
 *     post_to_canvas_comment is also off, which only happens in "Drive only"
 *     mode — caller suppresses the Canvas call entirely in that case).
 *     PUTs the plain-text reflection as a submission comment via
 *     as_user_id masquerade. Works on every Canvas assignment type.
 *
 *   - **post_to_canvas_submission=true** — body-as-submission. POSTs the
 *     HTML reflection as an online_text_entry submission. On a 400/422
 *     (assignment doesn't allow text entry, e.g. file-upload-only), falls
 *     back to comment-PUT (only if post_to_canvas_comment is also true;
 *     otherwise reports the error). Used for AI-literacy assignments where
 *     the reflection IS the deliverable.
 *
 * Common to both paths:
 *   1. Decrypt the teacher's stored Canvas token.
 *   2. Resolve student.canvas_user_id — backfill via roster lookup if missing.
 *      On first backfill, re-key students.anon_token to the canonical
 *      (canvas_user_id, email) form.
 *   3. POST/PUT via Canvas's as_user_id masquerade (Canvas attributes the
 *      action to the student, not the teacher token holder).
 *   4. Persist canvas_submission_id + state='submitted' + submitted_at.
 *
 * On terminal failure, returns `ok:false` with `needsCompletionCode:true`
 * so the caller can show the 6-char completion code for manual paste.
 * Every attempt logs a submission_attempts row.
 */
export async function submitReflectionToCanvas(args: {
  session: ReflectionSession;
  teacher: Teacher;
  teacherAssignment: TeacherAssignment;
  student: Student;
}): Promise<CanvasSubmitResult> {
  const { session, teacher, teacherAssignment, student } = args;
  const admin = createAdminDbClient();

  if (!teacher.canvas_host || !teacher.canvas_token_encrypted) {
    await logAttempt(admin, session.id, false, "Teacher Canvas not connected");
    return {
      ok: false,
      error: "Teacher hasn't connected Canvas",
      needsCompletionCode: true,
    };
  }

  let token: string;
  try {
    token = decryptSecret(teacher.canvas_token_encrypted, readKeyFromEnv());
  } catch (err) {
    const message = `Token decrypt failed: ${(err as Error).message}`;
    await logAttempt(admin, session.id, false, message);
    return { ok: false, error: message, needsCompletionCode: true };
  }
  const config: CanvasConfig = { host: teacher.canvas_host, token };

  // Resolve / backfill canvas_user_id.
  let canvasUserId = student.canvas_user_id;
  let workingAnonToken = student.anon_token;
  if (!canvasUserId) {
    try {
      const found = await lookupCourseStudentByEmail(
        config,
        teacherAssignment.canvas_course_id,
        student.email,
      );
      if (!found) {
        const message = `Couldn't find ${student.email} on the Canvas roster for course ${teacherAssignment.canvas_course_id}.`;
        await logAttempt(admin, session.id, false, message);
        return { ok: false, error: message, needsCompletionCode: true };
      }
      canvasUserId = String(found.id);

      // Re-key the anon_token to the canonical (canvas_user_id, email) form.
      const newToken = anonToken(
        canvasUserId,
        student.email,
        readSaltFromEnv(),
      );
      const { error: updateError } = await admin
        .from("students")
        .update({ canvas_user_id: canvasUserId, anon_token: newToken })
        .eq("id", student.id);
      if (updateError) {
        const message = `Couldn't persist canvas_user_id backfill: ${updateError.message}`;
        await logAttempt(admin, session.id, false, message);
        return { ok: false, error: message, needsCompletionCode: true };
      }
      workingAnonToken = newToken;
    } catch (err) {
      const message = `Roster lookup failed: ${(err as Error).message}`;
      await logAttempt(admin, session.id, false, message);
      return { ok: false, error: message, needsCompletionCode: true };
    }
  }
  void workingAnonToken;

  const reflectionMessages =
    (session.reflection_messages as ReflectionMessage[] | null) ?? [];
  const aiChats = (session.ai_chats as AiChat[] | null) ?? [];
  const firstDraft = session.first_draft ?? "";
  const objectiveSummary = session.objective_summary ?? "";
  const pasteFallback = session.paste_fallback_text ?? "";

  const bodyArgs = {
    iframeToken: teacherAssignment.iframe_token,
    firstDraft,
    objectiveSummary,
    reflectionMessages,
    aiChats,
    pasteFallback,
  };

  // Phase 1: prefer destination flags frozen at intake time. A teacher who
  // flips between comment-mode and submission-mode while the student is
  // mid-reflection shouldn't have the deliverable route change under them.
  // Legacy (pre-snapshot) sessions fall back to the live teacher_assignments
  // value, same as before Phase 1.
  const postToCanvasSubmission =
    session.post_to_canvas_submission_at_session ??
    teacherAssignment.post_to_canvas_submission;

  // Default path: comment-only. The teacher's actual submission (essay, file,
  // discussion posts, etc.) stays as the canonical submission; our reflection
  // attaches as a side-channel comment. No body-POST attempted — if the
  // teacher wanted that path, they would have set
  // post_to_canvas_submission=true at install (M6.18a). The legacy column
  // `use_submission_body` is kept in sync at write time for one cycle.
  if (!postToCanvasSubmission) {
    const textBody = buildSubmissionBodyText(bodyArgs);
    try {
      const { submissionId } = await postSubmissionCommentAsStudent(
        config,
        teacherAssignment.canvas_course_id,
        teacherAssignment.canvas_assignment_id,
        canvasUserId,
        textBody,
      );
      await persistSuccess(admin, session.id, submissionId, "comment");
      return { ok: true, submissionId, canvasUserId };
    } catch (err) {
      const message = buildErrorMessage(err);
      await logAttempt(admin, session.id, false, message);
      return { ok: false, error: message, needsCompletionCode: true };
    }
  }

  // Body-as-submission path: try online_text_entry POST first. On a 400/422
  // (assignment doesn't allow text entry — file-upload-only, external_tool,
  // etc.) fall back to comment-PUT so the reflection still lands somewhere.
  const htmlBody = buildSubmissionBody(bodyArgs);
  try {
    const { submissionId } = await submitTextEntryAsStudent(
      config,
      teacherAssignment.canvas_course_id,
      teacherAssignment.canvas_assignment_id,
      canvasUserId,
      htmlBody,
    );
    await persistSuccess(admin, session.id, submissionId, "submission");
    return { ok: true, submissionId, canvasUserId };
  } catch (err) {
    // 400/422 = submission_types[] doesn't include online_text_entry. Other
    // statuses (401/403 auth, 404 not found, 5xx server, network errors)
    // won't be fixed by switching endpoints.
    const status = err instanceof CanvasError ? err.status : 0;
    const shouldFallback = status === 400 || status === 422;
    if (!shouldFallback) {
      const message = buildErrorMessage(err);
      await logAttempt(admin, session.id, false, message);
      return { ok: false, error: message, needsCompletionCode: true };
    }
    await logAttempt(
      admin,
      session.id,
      false,
      `Text-entry submit rejected — falling back to comment. ${buildErrorMessage(err)}`,
    );
  }

  const textBody = buildSubmissionBodyText(bodyArgs);
  try {
    const { submissionId } = await postSubmissionCommentAsStudent(
      config,
      teacherAssignment.canvas_course_id,
      teacherAssignment.canvas_assignment_id,
      canvasUserId,
      textBody,
    );
    await persistSuccess(admin, session.id, submissionId, "comment");
    return { ok: true, submissionId, canvasUserId };
  } catch (err) {
    const message = `Comment fallback also failed. ${buildErrorMessage(err)}`;
    await logAttempt(admin, session.id, false, message);
    return { ok: false, error: message, needsCompletionCode: true };
  }
}

async function persistSuccess(
  admin: ReturnType<typeof createAdminDbClient>,
  sessionId: string,
  submissionId: number,
  via: "submission" | "comment",
): Promise<void> {
  const { error: updateError } = await admin
    .from("reflection_sessions")
    .update({
      canvas_submission_id: String(submissionId),
      state: "submitted",
      submitted_at: new Date().toISOString(),
    })
    .eq("id", sessionId);

  if (updateError) {
    // Canvas accepted but we couldn't record it. Don't fail the student —
    // they still got credit. Log the discrepancy.
    await logAttempt(
      admin,
      sessionId,
      true,
      `Canvas accepted (via ${via}) but local update failed: ${updateError.message}`,
    );
  } else {
    await logAttempt(
      admin,
      sessionId,
      true,
      via === "comment" ? "Submitted via comment fallback." : null,
    );
  }
}

function buildErrorMessage(err: unknown): string {
  const status = err instanceof CanvasError ? err.status : 0;
  // Canvas puts the real reason ("submission_types does not include
  // online_text_entry", "is closed for submissions", etc.) in the response
  // body, not the status line. Trim to 500 chars so the DB column doesn't
  // grow unbounded on a particularly verbose Canvas error.
  const body =
    err instanceof CanvasError && err.body
      ? ` Body: ${err.body.slice(0, 500)}`
      : "";
  return status >= 400
    ? `Canvas rejected the submission (HTTP ${status}). ${(err as Error).message}${body}`
    : (err as Error).message;
}

// ---------------------------------------------------------------------------
// Submission body composition.
// Sanitization is server-side on Canvas's end, so we keep to a small set of
// HTML elements + inline styles. No classes (Canvas may strip unknown ones).
//
// Canvas's RCE flattens raw <h3>/<h4> to barely-distinguishable text, so we
// rely on explicit inline styles (color, size, weight, top margin) to carry
// the visual hierarchy rather than the tag default. <hr> rules separate
// major sections cleanly.

const HEADING_STYLE =
  "font-family:Georgia,'Times New Roman',serif;color:#7a1e46;font-size:17px;font-weight:bold;margin:24px 0 8px 0;";
const TITLE_STYLE =
  "font-family:Georgia,'Times New Roman',serif;color:#1a1a1a;font-size:22px;font-weight:bold;margin:0 0 16px 0;";
const RULE_STYLE =
  "border:none;border-top:1px solid #d6d6d6;margin:24px 0;";
const BODY_STYLE =
  "font-family:Georgia,'Times New Roman',serif;color:#1a1a1a;font-size:15px;line-height:1.6;margin:0 0 12px 0;";

export function buildSubmissionBody(args: {
  iframeToken: string;
  firstDraft: string;
  objectiveSummary: string;
  reflectionMessages: ReflectionMessage[];
  aiChats: AiChat[];
  pasteFallback: string;
}): string {
  const parts: string[] = [];
  // Sentinel marker — super-grader's Canvas-scrape pipeline filters these so
  // the AI Documenter envelope arrives via the /api/ingest webhook only,
  // not via the scrape (which would otherwise produce duplicates).
  parts.push(
    `<!-- ai-documenter:reflection v=1 iframe-token=${escapeMarkerToken(args.iframeToken)} -->`,
  );

  parts.push(`<h3 style="${TITLE_STYLE}">AI Use Reflection</h3>`);

  const chatRows = args.aiChats.filter((c) => c.url);
  if (chatRows.length > 0) {
    parts.push(`<h4 style="${HEADING_STYLE}">AI conversation(s)</h4>`);
    parts.push('<ul style="margin:0 0 12px 0;padding-left:24px;">');
    for (const c of chatRows) {
      const url = escapeHtmlAttr(c.url);
      parts.push(
        `  <li style="${BODY_STYLE}margin-bottom:6px;"><strong>${capitalize(c.tool)}:</strong> <a href="${url}">${url}</a></li>`,
      );
    }
    parts.push("</ul>");
  }

  parts.push(`<hr style="${RULE_STYLE}" />`);
  parts.push(`<h4 style="${HEADING_STYLE}">First-draft reflection</h4>`);
  parts.push(textToStyledParagraphs(args.firstDraft));

  if (args.objectiveSummary.trim()) {
    parts.push(`<hr style="${RULE_STYLE}" />`);
    parts.push(
      `<h4 style="${HEADING_STYLE}">Objective summary of AI use</h4>`,
    );
    parts.push(textToStyledParagraphs(args.objectiveSummary));
  }

  if (args.reflectionMessages.length > 0) {
    parts.push(`<hr style="${RULE_STYLE}" />`);
    parts.push(`<h4 style="${HEADING_STYLE}">Reflection conversation</h4>`);
    let qNumber = 0;
    let pendingAi: ReflectionMessage | null = null;
    const rendered: string[] = [];
    for (const m of args.reflectionMessages) {
      if (m.role === "ai") {
        if (pendingAi) {
          qNumber += 1;
          rendered.push(renderTurn(qNumber, pendingAi, null));
        }
        pendingAi = m;
      } else {
        if (pendingAi) {
          qNumber += 1;
          rendered.push(renderTurn(qNumber, pendingAi, m));
          pendingAi = null;
        }
      }
    }
    if (pendingAi) {
      qNumber += 1;
      rendered.push(renderTurn(qNumber, pendingAi, null));
    }
    parts.push(rendered.join("\n"));
  }

  if (args.pasteFallback.trim().length > 0) {
    parts.push(`<hr style="${RULE_STYLE}" />`);
    parts.push(`<h4 style="${HEADING_STYLE}">AI conversation (pasted)</h4>`);
    parts.push(
      `<pre style="white-space:pre-wrap;font-family:Georgia,'Times New Roman',serif;font-size:14px;line-height:1.5;color:#1a1a1a;background:#f7f7f7;padding:12px;border-radius:3px;margin:0;">${escapeHtml(args.pasteFallback)}</pre>`,
    );
  }

  return parts.join("\n");
}

function renderTurn(
  qNumber: number,
  ai: ReflectionMessage,
  student: ReflectionMessage | null,
): string {
  const out: string[] = [];
  out.push(
    `<p style="${BODY_STYLE}margin-top:16px;"><strong style="color:#7a1e46;">Q${qNumber}.</strong> ${escapeHtml(ai.text)}</p>`,
  );
  if (student) {
    out.push(textToStyledParagraphs(student.text));
  }
  return out.join("\n");
}

// Styled paragraph wrapper for body content — applies BODY_STYLE so Canvas's
// flattened defaults don't squash the rendering. Same shape as
// textToParagraphs (one or more <p> blocks, <br> for single newlines) but
// every <p> carries inline styles for color/size/leading.
function textToStyledParagraphs(s: string): string {
  const trimmed = s.trim();
  if (!trimmed) return "";
  return trimmed
    .split(/\n\s*\n/)
    .map(
      (p) =>
        `<p style="${BODY_STYLE}">${escapeHtml(p).replace(/\n/g, "<br>")}</p>`,
    )
    .join("");
}

// ---------------------------------------------------------------------------
// Plain-text equivalent of buildSubmissionBody, for the comment-fallback path.
// Canvas's submission comment text is rendered as plain text in the gradebook
// (no rich text editor), so we ship headings as ALL-CAPS lines with blank-line
// separators rather than HTML tags.
//
// The sentinel marker (`<!-- ai-documenter:reflection v=1 ... -->`) that
// super-grader's scrape pipeline uses to dedupe submissions is intentionally
// omitted here: super-grader scrapes Canvas submission *bodies*, not
// comments, so there's nothing to dedupe — and the literal angle-bracket
// text would just clutter the comment UI. The iframeToken arg stays in the
// signature for symmetry with buildSubmissionBody in case we surface it
// later, but isn't rendered.

function buildSubmissionBodyText(args: {
  iframeToken: string;
  firstDraft: string;
  objectiveSummary: string;
  reflectionMessages: ReflectionMessage[];
  aiChats: AiChat[];
  pasteFallback: string;
}): string {
  void args.iframeToken; // intentionally unused in the plain-text path
  const parts: string[] = [];

  // Title with rule below for visual weight in Canvas's monospace-ish comment
  // rendering. Section headers get the same treatment: ALL CAPS + dash rule
  // + blank line on both sides so the eye finds them quickly.
  parts.push("AI USE REFLECTION");
  parts.push("=================");

  const chatRows = args.aiChats.filter((c) => c.url);
  if (chatRows.length > 0) {
    parts.push("");
    parts.push("");
    parts.push(sectionHeader("AI conversation(s)"));
    parts.push("");
    for (const c of chatRows) {
      parts.push(`  • ${capitalize(c.tool)}: ${c.url}`);
    }
  }

  parts.push("");
  parts.push("");
  parts.push(sectionHeader("First-draft reflection"));
  parts.push("");
  parts.push(args.firstDraft.trim() || "(none submitted)");

  if (args.objectiveSummary.trim()) {
    parts.push("");
    parts.push("");
    parts.push(sectionHeader("Objective summary of AI use"));
    parts.push("");
    parts.push(args.objectiveSummary.trim());
  }

  if (args.reflectionMessages.length > 0) {
    parts.push("");
    parts.push("");
    parts.push(sectionHeader("Reflection conversation"));
    let qNumber = 0;
    let pendingAi: ReflectionMessage | null = null;
    for (const m of args.reflectionMessages) {
      if (m.role === "ai") {
        if (pendingAi) {
          qNumber += 1;
          parts.push("");
          parts.push(`Q${qNumber}. ${pendingAi.text.trim()}`);
        }
        pendingAi = m;
      } else {
        if (pendingAi) {
          qNumber += 1;
          parts.push("");
          parts.push(`Q${qNumber}. ${pendingAi.text.trim()}`);
          parts.push("");
          parts.push(m.text.trim());
          pendingAi = null;
        }
      }
    }
    if (pendingAi) {
      qNumber += 1;
      parts.push("");
      parts.push(`Q${qNumber}. ${pendingAi.text.trim()}`);
    }
  }

  if (args.pasteFallback.trim().length > 0) {
    parts.push("");
    parts.push("");
    parts.push(sectionHeader("AI conversation (pasted)"));
    parts.push("");
    parts.push(args.pasteFallback.trim());
  }

  return parts.join("\n");
}

function sectionHeader(label: string): string {
  const upper = label.toUpperCase();
  return `${upper}\n${"-".repeat(upper.length)}`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeHtmlAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function escapeMarkerToken(s: string): string {
  // Restrict to URL-safe chars — teacher_assignments.iframe_token always
  // conforms; this strips anything weird as a defense-in-depth measure.
  return s.replace(/[^A-Za-z0-9_-]/g, "");
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

async function logAttempt(
  admin: ReturnType<typeof createAdminDbClient>,
  sessionId: string,
  success: boolean,
  error: string | null,
): Promise<void> {
  await admin.from("submission_attempts").insert({
    reflection_session_id: sessionId,
    success,
    error,
  });
}
