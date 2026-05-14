"use server";

import { createAdminDbClient } from "@ai-documenter/db/admin";
import { getServerDbClient } from "@/lib/supabase/server";

export type StudentSessionInfo = {
  signedIn: boolean;
  displayName: string | null;
  hasActiveReflection: boolean;
  /** Locked first draft from the intake step. Null until intake submits.
   * Used by the Socratic page to display the student's committed thinking
   * above the coaching conversation. */
  firstDraft: string | null;
};

// Resolve the current student session for a given iframe_token. Returns
// signed-in state, display name, whether they already have an
// in-progress/completed reflection on this assignment (so the UI can resume
// to the conversation instead of re-prompting intake), and the locked first
// draft if there is one.
export async function getStudentSession(args: {
  iframeToken: string;
}): Promise<StudentSessionInfo> {
  const supabase = await getServerDbClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return {
      signedIn: false,
      displayName: null,
      hasActiveReflection: false,
      firstDraft: null,
    };
  }

  const admin = createAdminDbClient();
  const { data: student } = await admin
    .from("students")
    .select("id, display_name")
    .eq("auth_user_id", user.id)
    .maybeSingle();
  if (!student) {
    return {
      signedIn: false,
      displayName: null,
      hasActiveReflection: false,
      firstDraft: null,
    };
  }

  let hasActiveReflection = false;
  let firstDraft: string | null = null;
  if (args.iframeToken) {
    const { data: ta } = await admin
      .from("teacher_assignments")
      .select("id")
      .eq("iframe_token", args.iframeToken)
      .maybeSingle();
    if (ta) {
      const { data: rs } = await admin
        .from("reflection_sessions")
        .select("id, first_draft")
        .eq("teacher_assignment_id", ta.id)
        .eq("student_id", student.id)
        .in("state", ["in_progress", "completed", "submitted"])
        .limit(1)
        .maybeSingle();
      if (rs) {
        hasActiveReflection = true;
        firstDraft = rs.first_draft;
      }
    }
  }

  return {
    signedIn: true,
    displayName: student.display_name,
    hasActiveReflection,
    firstDraft,
  };
}
