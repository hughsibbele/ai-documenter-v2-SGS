// M7.3 — automatic Drive save for a reflection_session. Called from
// finalizeReflection after the Socratic conversation completes.
//
// Direct port of HH M7.5's `save-discussion.ts` shape with the AID-
// specific doc body composition (per BUILD_PLAN M7 AID row: summary +
// Socratic Q/A + full pasted transcript). Drive ownership = teacher
// per the M7 invariant.
//
// Idempotent at the caller — finalizeReflection skips this step if
// the session row already has a drive_doc_url. Inside this function
// we don't dedup further; a re-run would create a second doc.

import type { Auth } from "googleapis";
import { createAdminDbClient } from "@ai-documenter/db/admin";
import { createDoc } from "./docs";
import {
  getOrCreateAppFolder,
  shareWithDomain,
  type DriveFileRef,
} from "./drive";
import { getTeacherGoogleClient } from "./auth";

const APP_FOLDER_NAME = "AI Documenter";

export type SavedReflectionRefs = {
  doc: DriveFileRef;
  folder: { id: string; created: boolean };
};

export type ReflectionMessage = { role: "ai" | "student"; text: string; ts: string };
export type AiChat = { tool: string; url: string; transcript_text: string | null };

export type ReflectionSessionForDriveSave = {
  id: string;
  teacher_id: string;
  student_id: string;
  canvas_assignment_id: string;
  first_draft: string | null;
  objective_summary: string | null;
  reflection_messages: ReflectionMessage[];
  ai_chats: AiChat[];
  paste_fallback_text: string | null;
  completed_at: string | null;
  created_at: string;
};

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function composeBaseName(args: {
  studentName: string;
  assignmentName: string;
  date: string;
}): string {
  // BUILD_PLAN M7 AID row: `{student} – {date} – {assignment}`.
  return `${args.studentName} – ${formatDate(args.date)} – ${args.assignmentName}`;
}

function composeDocBody(args: {
  firstDraft: string | null;
  objectiveSummary: string | null;
  reflectionMessages: ReflectionMessage[];
  aiChats: AiChat[];
  pasteFallback: string | null;
}): string {
  const sections: string[] = [];

  if (args.objectiveSummary && args.objectiveSummary.trim().length > 0) {
    sections.push("OBJECTIVE SUMMARY OF AI USE", "", args.objectiveSummary.trim());
  }

  const chatRows = args.aiChats.filter((c) => c.url);
  if (chatRows.length > 0) {
    if (sections.length > 0) sections.push("", "", "AI CONVERSATION LINKS", "");
    else sections.push("AI CONVERSATION LINKS", "");
    for (const c of chatRows) {
      const label = c.tool.charAt(0).toUpperCase() + c.tool.slice(1);
      sections.push(`${label}: ${c.url}`);
    }
  }

  if (args.firstDraft && args.firstDraft.trim().length > 0) {
    if (sections.length > 0) sections.push("", "", "FIRST-DRAFT REFLECTION", "");
    else sections.push("FIRST-DRAFT REFLECTION", "");
    sections.push(args.firstDraft.trim());
  }

  if (args.reflectionMessages.length > 0) {
    if (sections.length > 0) sections.push("", "", "REFLECTION CONVERSATION", "");
    else sections.push("REFLECTION CONVERSATION", "");
    let qNumber = 0;
    let pendingAi: ReflectionMessage | null = null;
    for (const m of args.reflectionMessages) {
      if (m.role === "ai") {
        if (pendingAi) {
          qNumber += 1;
          sections.push(`Q${qNumber}. ${pendingAi.text}`, "");
        }
        pendingAi = m;
      } else {
        if (pendingAi) {
          qNumber += 1;
          sections.push(`Q${qNumber}. ${pendingAi.text}`, "", m.text, "");
          pendingAi = null;
        }
      }
    }
    if (pendingAi) {
      qNumber += 1;
      sections.push(`Q${qNumber}. ${pendingAi.text}`);
    }
  }

  if (args.pasteFallback && args.pasteFallback.trim().length > 0) {
    if (sections.length > 0) sections.push("", "", "FULL AI CONVERSATION (PASTED)", "");
    else sections.push("FULL AI CONVERSATION (PASTED)", "");
    sections.push(args.pasteFallback.trim());
  }

  if (sections.length === 0) {
    sections.push("(reflection has no content yet)");
  }
  return sections.join("\n");
}

async function loadLabels(args: {
  teacherId: string;
  studentId: string;
  canvasAssignmentId: string;
}): Promise<{ studentName: string; assignmentName: string }> {
  const admin = createAdminDbClient();
  const [{ data: student }, { data: assignment }] = await Promise.all([
    admin
      .from("students")
      .select("display_name")
      .eq("id", args.studentId)
      .maybeSingle(),
    admin
      .from("canvas_assignment_cache")
      .select("name")
      .eq("teacher_id", args.teacherId)
      .eq("canvas_assignment_id", args.canvasAssignmentId)
      .maybeSingle(),
  ]);
  return {
    studentName: student?.display_name ?? "Student",
    assignmentName: assignment?.name ?? args.canvasAssignmentId,
  };
}

/**
 * Drive-save the reflection's full doc (objective summary + AI links +
 * first-draft + Q/A + pasted fallback).
 *
 * Persists the resulting folder id back to `teachers.drive_folder_id` if
 * it was auto-created. Returns the Drive ref for the caller to write
 * onto the reflection_sessions row.
 */
export async function saveReflectionToDrive(
  session: ReflectionSessionForDriveSave,
): Promise<SavedReflectionRefs> {
  const admin = createAdminDbClient();

  const { data: teacher, error: teacherErr } = await admin
    .from("teachers")
    .select("drive_folder_id")
    .eq("id", session.teacher_id)
    .single();
  if (teacherErr || !teacher) {
    throw new Error(`teacher lookup: ${teacherErr?.message ?? "not found"}`);
  }

  const client: Auth.OAuth2Client = await getTeacherGoogleClient(
    session.teacher_id,
  );

  const folder = await getOrCreateAppFolder(
    client,
    teacher.drive_folder_id,
    APP_FOLDER_NAME,
  );
  if (folder.created) {
    await admin
      .from("teachers")
      .update({ drive_folder_id: folder.id })
      .eq("id", session.teacher_id);
  }

  const labels = await loadLabels({
    teacherId: session.teacher_id,
    studentId: session.student_id,
    canvasAssignmentId: session.canvas_assignment_id,
  });
  const baseName = composeBaseName({
    studentName: labels.studentName,
    assignmentName: labels.assignmentName,
    date: session.completed_at ?? session.created_at,
  });

  const docBody = composeDocBody({
    firstDraft: session.first_draft,
    objectiveSummary: session.objective_summary,
    reflectionMessages: session.reflection_messages,
    aiChats: session.ai_chats,
    pasteFallback: session.paste_fallback_text,
  });
  const doc = await createDoc(client, baseName, docBody, folder.id);
  // Share the doc with the EHS domain too — M7 invariant. Best-effort.
  await shareWithDomain(client, doc.id).catch(() => {});

  return {
    folder: { id: folder.id, created: folder.created },
    doc,
  };
}
