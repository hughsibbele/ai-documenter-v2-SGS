"use server";

import { revalidatePath } from "next/cache";
import { createAdminDbClient } from "@ai-documenter/db/admin";
import { getCurrentTeacher } from "@/lib/auth/teacher";
import { getCurrentAdminEmail } from "@/lib/auth/admin";
import { buildReflectionsCsv } from "@/lib/retention/csv";
import {
  loadReflectionsInScope,
  type RetentionScope,
} from "@/lib/retention/load";

export type RetentionExportInput = {
  /** "course" = a single Canvas course owned by the calling teacher.
   *  "mine" = every course owned by the calling teacher.
   *  "all" = every reflection in the system (admin-only). */
  target: "course" | "mine" | "all";
  /** Required when target='course'. */
  canvasCourseId?: string;
};

export type RetentionExportResult =
  | {
      ok: true;
      csv: string;
      rowCount: number;
      filename: string;
    }
  | { ok: false; message: string };

export async function exportReflectionsCsv(
  input: RetentionExportInput,
): Promise<RetentionExportResult> {
  const scopeResult = await resolveScope(input);
  if (!scopeResult.ok) return scopeResult;

  const rows = await loadReflectionsInScope(scopeResult.scope);
  const csv = buildReflectionsCsv(rows);
  const filename = buildFilename(input, "csv");
  return { ok: true, csv, rowCount: rows.length, filename };
}

export type HardDeleteInput = {
  target: "course" | "mine" | "all";
  canvasCourseId?: string;
  /** Optional ISO date — only delete sessions with created_at < this date.
   *  Omit to delete everything in scope. */
  beforeDate?: string;
  /** Type-this-to-confirm guard. Must equal the literal `"DELETE"` to proceed. */
  confirmText: string;
};

export type HardDeleteResult =
  | { ok: true; deletedCount: number }
  | { ok: false; message: string };

/**
 * Permanently delete reflection_sessions + their submission_attempts in
 * scope. Authority:
 *   - target='course' / 'mine'  → caller is the owning teacher.
 *   - target='all'              → caller is an admin.
 *
 * `confirmText` MUST equal "DELETE" exactly. UI forces this so an accidental
 * server-action call (re-render storm, double-submit) can't wipe data.
 *
 * Deletes via the admin client because student-self RLS would block the
 * teacher / admin direct-write path. `submission_attempts` cascades via
 * fk, but we'd rather not assume that — explicit two-step delete.
 */
export async function hardDeleteReflections(
  input: HardDeleteInput,
): Promise<HardDeleteResult> {
  if (input.confirmText !== "DELETE") {
    return {
      ok: false,
      message: 'Type "DELETE" exactly to confirm. (No deletion happened.)',
    };
  }

  const scopeResult = await resolveScope(input);
  if (!scopeResult.ok) return scopeResult;

  const rows = await loadReflectionsInScope(scopeResult.scope);
  const filtered = input.beforeDate
    ? rows.filter((r) => r.session.created_at < input.beforeDate!)
    : rows;

  if (filtered.length === 0) {
    return { ok: true, deletedCount: 0 };
  }

  const sessionIds = filtered.map((r) => r.session.id);
  const admin = createAdminDbClient();

  // Chunked deletes so the IN-list URL doesn't grow unbounded.
  const CHUNK = 200;
  for (let i = 0; i < sessionIds.length; i += CHUNK) {
    const slice = sessionIds.slice(i, i + CHUNK);
    const { error: attemptErr } = await admin
      .from("submission_attempts")
      .delete()
      .in("reflection_session_id", slice);
    if (attemptErr) {
      return { ok: false, message: attemptErr.message };
    }
    const { error: sessionErr } = await admin
      .from("reflection_sessions")
      .delete()
      .in("id", slice);
    if (sessionErr) {
      return { ok: false, message: sessionErr.message };
    }
  }

  revalidatePath("/dashboard/retention");
  revalidatePath("/admin/retention");
  return { ok: true, deletedCount: sessionIds.length };
}

// ---------------------------------------------------------------------------
// Helpers.

async function resolveScope(input: {
  target: "course" | "mine" | "all";
  canvasCourseId?: string;
}): Promise<{ ok: true; scope: RetentionScope } | { ok: false; message: string }> {
  if (input.target === "all") {
    const adminEmail = await getCurrentAdminEmail();
    if (!adminEmail) {
      return { ok: false, message: "Admin only." };
    }
    return { ok: true, scope: { kind: "admin_all" } };
  }

  const teacher = await getCurrentTeacher();
  if (input.target === "course") {
    if (!input.canvasCourseId) {
      return { ok: false, message: "canvasCourseId is required for target=course." };
    }
    return {
      ok: true,
      scope: {
        kind: "teacher_course",
        teacherId: teacher.id,
        canvasCourseId: input.canvasCourseId,
      },
    };
  }
  return {
    ok: true,
    scope: { kind: "teacher_all", teacherId: teacher.id },
  };
}

function buildFilename(
  input: { target: string; canvasCourseId?: string },
  ext: string,
): string {
  const stamp = new Date().toISOString().slice(0, 10);
  const tag =
    input.target === "course"
      ? `course-${input.canvasCourseId ?? "x"}`
      : input.target === "mine"
        ? "mine"
        : "all";
  return `ai-documenter-reflections-${tag}-${stamp}.${ext}`;
}
