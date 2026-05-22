"use server";

import { randomBytes } from "node:crypto";
import { createAdminDbClient } from "@ai-documenter/db/admin";
import { getServerDbClient } from "@/lib/supabase/server";
import { resolveIframeToken } from "@/lib/iframe/resolve";
import { resolveCardTextForTeacher } from "@/lib/card-text/resolve";
import {
  loadRawRosterForCourse,
  RosterMissingError,
} from "@/lib/scrub/roster-scrub";

export type SubmitIntakeInput = {
  iframeToken: string;
  chats: { tool: "gemini" | "chatgpt" | "claude"; url: string }[];
  pasteFallbackText: string;
  timeSpentEstimate: "lt15" | "15_30" | "30_45" | "45_60" | "1_2h" | "gt2h";
  /** Locked-once-submitted first draft of the student's reflection. The whole
   * point of the M3 flow: commit your thinking before the coach helps deepen it. */
  firstDraft: string;
};

export type SubmitIntakeResult =
  | { ok: true; sessionId: string }
  | { ok: false; error: string };

// Allow-list of share-link URL patterns. Exact-host match keeps the surface
// small; we don't want to accept arbitrary URLs that happen to contain
// "/share/". Multiple chats with the same tool are fine.
const URL_PATTERNS: Record<SubmitIntakeInput["chats"][number]["tool"], RegExp> = {
  gemini: /^https:\/\/(?:gemini|g\.co)\.google\.com\/(?:share|app\/.*?\/share)\//,
  chatgpt: /^https:\/\/chatgpt\.com\/share\//,
  claude: /^https:\/\/claude\.ai\/share\//,
};

const TIME_BANDS = new Set([
  "lt15",
  "15_30",
  "30_45",
  "45_60",
  "1_2h",
  "gt2h",
]);

const MIN_FIRST_DRAFT_LENGTH = 50;

export async function submitIntake(
  input: SubmitIntakeInput,
): Promise<SubmitIntakeResult> {
  if (!TIME_BANDS.has(input.timeSpentEstimate)) {
    return { ok: false, error: "Invalid time-spent value" };
  }

  const firstDraft = input.firstDraft.trim();
  if (firstDraft.length < MIN_FIRST_DRAFT_LENGTH) {
    return {
      ok: false,
      error: `Write a little more — at least ${MIN_FIRST_DRAFT_LENGTH} characters. A sentence or two is the minimum; the coach builds on what you write here.`,
    };
  }

  const cleanedChats = input.chats
    .map((c) => ({ tool: c.tool, url: c.url.trim() }))
    .filter((c) => c.url.length > 0);

  for (const c of cleanedChats) {
    const pattern = URL_PATTERNS[c.tool];
    if (!pattern || !pattern.test(c.url)) {
      return {
        ok: false,
        error: `That ${c.tool} link doesn't look like a share URL — paste the link from the tool's "Share" button.`,
      };
    }
  }

  const paste = input.pasteFallbackText.trim();
  if (cleanedChats.length === 0 && paste.length < 20) {
    return {
      ok: false,
      error: "Add at least one share link, or paste your conversation text.",
    };
  }

  const ctx = await resolveIframeToken(input.iframeToken);
  if (!ctx) {
    return { ok: false, error: "This reflection link is no longer valid." };
  }

  const supabase = await getServerDbClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { ok: false, error: "You're not signed in." };
  }

  const admin = createAdminDbClient();
  const { data: student } = await admin
    .from("students")
    .select("id")
    .eq("auth_user_id", user.id)
    .maybeSingle();
  if (!student) {
    return { ok: false, error: "Your student account isn't set up yet." };
  }

  // Phase 1: snapshot the roster + card text + destination flags +
  // prompt body at intake time. Reads from these snapshots throughout the
  // session lifecycle (socratic.ts for Gemini calls, finalize.ts for
  // destination routing, scrub for PII) so a teacher edit / roster sync
  // mid-reflection cannot retroactively change what the reflection meant.
  //
  // Fail-closed: if the roster lookup throws RosterMissingError, refuse
  // to create the session (same Phase 0 contract). The student gets a
  // clear "tell your teacher" message; no half-snapshotted row lands.
  let rosterSnapshot;
  try {
    rosterSnapshot = await loadRawRosterForCourse(
      ctx.teacherAssignment.canvas_course_id,
    );
  } catch (err) {
    if (err instanceof RosterMissingError) {
      console.warn(
        `[submitIntake] roster_missing teacher_assignment=${ctx.teacherAssignment.id} reason=${err.reason}`,
      );
      return { ok: false, error: "roster_missing" };
    }
    throw err;
  }

  const cardText = await resolveCardTextForTeacher(
    ctx.teacherAssignment.teacher_id,
  );

  // Insert with a freshly-generated completion_code; retry once on the
  // (extremely unlikely) collision.
  for (let attempt = 0; attempt < 2; attempt++) {
    const completionCode = generateCompletionCode();
    const { data, error } = await admin
      .from("reflection_sessions")
      .insert({
        teacher_assignment_id: ctx.teacherAssignment.id,
        student_id: student.id,
        state: "in_progress",
        ai_chats: cleanedChats.map((c) => ({
          tool: c.tool,
          url: c.url,
          transcript_text: null,
        })),
        paste_fallback_text: paste.length > 0 ? paste : null,
        time_spent_estimate: input.timeSpentEstimate,
        ai_tools_used: Array.from(new Set(cleanedChats.map((c) => c.tool))),
        first_draft: firstDraft,
        completion_code: completionCode,
        // Phase 1 snapshots — frozen for the lifetime of the session.
        prompt_body_snapshot: ctx.prompt.body,
        student_facing_question_snapshot:
          ctx.prompt.student_facing_question ?? null,
        card_text_snapshot: {
          kicker: cardText.kicker,
          title: cardText.title,
          body: cardText.body,
          cta_label: cardText.ctaLabel,
          footnote: cardText.footnote,
        },
        post_to_canvas_comment_at_session:
          ctx.teacherAssignment.post_to_canvas_comment,
        post_to_canvas_submission_at_session:
          ctx.teacherAssignment.post_to_canvas_submission,
        post_to_drive_at_session: ctx.teacherAssignment.post_to_drive,
        roster_snapshot: rosterSnapshot,
      })
      .select("id")
      .single();

    if (!error && data) {
      return { ok: true, sessionId: data.id };
    }

    const isUniqueViolation =
      error?.code === "23505" && error.message.includes("completion_code");
    if (!isUniqueViolation) {
      return {
        ok: false,
        error: `Couldn't save your reflection: ${error?.message ?? "unknown"}`,
      };
    }
  }

  return { ok: false, error: "Couldn't generate a unique completion code." };
}

// 6-character code drawn from a 32-char alphabet (digits + uppercase, minus
// visually-ambiguous I/O/0/1). 32^6 ≈ 1B — collisions are vanishingly rare
// at school scale.
const ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
function generateCompletionCode(): string {
  const bytes = randomBytes(6);
  let out = "";
  for (let i = 0; i < 6; i++) {
    out += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return out;
}
