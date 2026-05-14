import "server-only";

import type { RetentionRow } from "./load";

type AiChat = { tool: string; url: string; transcript_text: string | null };
type ReflectionMessage = { role: "ai" | "student"; text: string; ts: string };

const COLUMNS = [
  "session_id",
  "student_name",
  "student_email",
  "course_name",
  "assignment_name",
  "canvas_course_id",
  "canvas_assignment_id",
  "state",
  "created_at",
  "completed_at",
  "submitted_at",
  "canvas_submission_id",
  "completion_code",
  "time_spent_estimate",
  "tools_used",
  "ai_chat_urls",
  "first_draft",
  "objective_summary",
  "reflection_conversation",
  "paste_fallback_text",
] as const;

/**
 * Serialize a set of reflection rows into a CSV string. One row per session.
 * The "reflection_conversation" column packs the whole Q/A as a single
 * multi-line cell — fine for spreadsheets, and beats trying to model an
 * unbounded number of turn columns.
 *
 * Format:
 *   - RFC 4180 quoting: every cell wrapped in `"..."`, internal `"` doubled.
 *   - CRLF line endings (\r\n) per spec.
 *   - UTF-8; caller is responsible for a BOM if Excel-on-Windows users need
 *     one (most modern Excel doesn't).
 */
export function buildReflectionsCsv(rows: RetentionRow[]): string {
  const lines: string[] = [];
  lines.push(COLUMNS.map(csvEscape).join(","));
  for (const r of rows) {
    const aiChats = ((r.session.ai_chats as AiChat[] | null) ?? []).filter(
      (c) => c.url,
    );
    const messages =
      (r.session.reflection_messages as ReflectionMessage[] | null) ?? [];
    const conversation = messages
      .map((m) => `${m.role === "ai" ? "AI" : "Student"}: ${m.text}`)
      .join("\n\n");
    const aiChatUrls = aiChats
      .map((c) => `${c.tool}: ${c.url}`)
      .join("\n");
    const toolsUsed = (r.session.ai_tools_used ?? []).join(", ");

    const cells: Record<(typeof COLUMNS)[number], string> = {
      session_id: r.session.id,
      student_name: r.student.display_name,
      student_email: r.student.email,
      course_name: r.courseName ?? "",
      assignment_name: r.assignmentName ?? "",
      canvas_course_id: r.teacherAssignment.canvas_course_id,
      canvas_assignment_id: r.teacherAssignment.canvas_assignment_id,
      state: r.session.state,
      created_at: r.session.created_at,
      completed_at: r.session.completed_at ?? "",
      submitted_at: r.session.submitted_at ?? "",
      canvas_submission_id: r.session.canvas_submission_id ?? "",
      completion_code: r.session.completion_code,
      time_spent_estimate: r.session.time_spent_estimate ?? "",
      tools_used: toolsUsed,
      ai_chat_urls: aiChatUrls,
      first_draft: r.session.first_draft ?? "",
      objective_summary: r.session.objective_summary ?? "",
      reflection_conversation: conversation,
      paste_fallback_text: r.session.paste_fallback_text ?? "",
    };
    lines.push(COLUMNS.map((c) => csvEscape(cells[c])).join(","));
  }
  return lines.join("\r\n");
}

function csvEscape(value: string): string {
  // Always quote — simpler and removes the "does this cell contain a comma /
  // newline?" branch logic. Doubles internal quotes per RFC 4180.
  return `"${value.replace(/"/g, '""')}"`;
}
