// One-off backfill for 3 AID reflection_sessions stuck in state='submitted'
// without a Canvas comment, caused by the M3.8 super-grader scope-gate
// handing off to a SG assignment that wasn't actually configured. Run from
// the AID repo so the workspace's @supabase/supabase-js resolves.
//
//   pnpm dlx tsx /tmp/backfill-aid-canvas.ts
//
// Idempotent: skips sessions that already have canvas_submission_id set.

import { readFileSync } from "node:fs";
import { createDecipheriv, createHmac } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const ENV_PATH =
  "/Users/hkoeze/code/super-grader-suite/ai-documenter-v2-SGS/apps/teacher-admin/.env.local";
for (const raw of readFileSync(ENV_PATH, "utf8").split("\n")) {
  const m = raw.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (m && !process.env[m[1]]) {
    process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const ENC_KEY = process.env.CANVAS_TOKEN_ENC_KEY!;
const SALT = process.env.SUPER_GRADER_SALT!;
if (!SUPABASE_URL || !SERVICE_KEY || !ENC_KEY || !SALT) {
  throw new Error("missing one of NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CANVAS_TOKEN_ENC_KEY, SUPER_GRADER_SALT");
}

function anonToken(canvasUserId: string, email: string): string {
  const saltBytes = Buffer.from(SALT, "base64");
  const input = Buffer.concat([
    Buffer.from("ehs\0"),
    Buffer.from(canvasUserId),
    Buffer.from("\0"),
    Buffer.from(email.trim().toLowerCase()),
  ]);
  const mac = createHmac("sha256", saltBytes).update(input).digest("hex");
  return `Student_${mac.slice(0, 6)}`;
}

async function resolveCanvasUserIdFromRoster(
  teacherId: string,
  canvasCourseId: string,
  email: string,
): Promise<string | null> {
  const { data: roster } = await supabase
    .from("course_rosters")
    .select("students")
    .eq("teacher_id", teacherId)
    .eq("canvas_course_id", canvasCourseId)
    .single();
  if (!roster) return null;
  const list = (roster.students as Array<{ email: string; canvas_user_id: number | string }>) || [];
  const lower = email.trim().toLowerCase();
  const hit = list.find((r) => String(r.email).toLowerCase() === lower);
  return hit ? String(hit.canvas_user_id) : null;
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const SESSION_IDS = [
  "7268dbae-05c7-48e3-853c-76c2dc4893bc",
  "c2174f7f-615c-4123-b0ca-748417da9b5f",
  "8f6f9f48-b3ee-4665-ab14-203fec2dc2ca",
];

const DRY_RUN = process.argv.includes("--dry-run");

function decryptSecret(blob: string, keyB64: string): string {
  const key = Buffer.from(keyB64, "base64");
  if (key.length !== 32) throw new Error(`key must be 32 bytes, got ${key.length}`);
  const combined = Buffer.from(blob, "base64");
  const iv = combined.subarray(0, 12);
  const tag = combined.subarray(12, 28);
  const ct = combined.subarray(28);
  const d = createDecipheriv("aes-256-gcm", key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
}

type Msg = { role: "ai" | "student"; text: string; ts?: string };
type AiChat = { tool: string; url: string; transcript_text: string | null };

function sectionHeader(label: string): string {
  const upper = label.toUpperCase();
  return `${upper}\n${"-".repeat(upper.length)}`;
}
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// Mirrors apps/teacher-admin/src/lib/finalize/canvas-submit.ts:buildSubmissionBodyText
function buildText(args: {
  firstDraft: string;
  objectiveSummary: string;
  reflectionMessages: Msg[];
  aiChats: AiChat[];
  pasteFallback: string;
  driveDocUrl: string | null;
}): string {
  const parts: string[] = [];
  parts.push("AI USE REFLECTION");
  parts.push("=================");

  const chatRows = (args.aiChats || []).filter((c) => c.url);
  if (chatRows.length > 0) {
    parts.push(""); parts.push("");
    parts.push(sectionHeader("AI conversation(s)"));
    parts.push("");
    for (const c of chatRows) parts.push(`  • ${cap(c.tool)}: ${c.url}`);
  }

  parts.push(""); parts.push("");
  parts.push(sectionHeader("First-draft reflection"));
  parts.push("");
  parts.push((args.firstDraft || "").trim() || "(none submitted)");

  if ((args.objectiveSummary || "").trim()) {
    parts.push(""); parts.push("");
    parts.push(sectionHeader("Objective summary of AI use"));
    parts.push("");
    parts.push(args.objectiveSummary.trim());
  }

  if ((args.reflectionMessages || []).length > 0) {
    parts.push(""); parts.push("");
    parts.push(sectionHeader("Reflection conversation"));
    let qNumber = 0;
    let pendingAi: Msg | null = null;
    for (const m of args.reflectionMessages) {
      if (m.role === "ai") {
        if (pendingAi) {
          qNumber += 1;
          parts.push(""); parts.push(`Q${qNumber}. ${pendingAi.text.trim()}`);
        }
        pendingAi = m;
      } else {
        if (pendingAi) {
          qNumber += 1;
          parts.push(""); parts.push(`Q${qNumber}. ${pendingAi.text.trim()}`);
          parts.push(""); parts.push(m.text.trim());
          pendingAi = null;
        }
      }
    }
    if (pendingAi) {
      qNumber += 1;
      parts.push(""); parts.push(`Q${qNumber}. ${pendingAi.text.trim()}`);
    }
  }

  if (args.driveDocUrl) {
    parts.push(""); parts.push("");
    parts.push(`📄 View full AI conversation (Drive): ${args.driveDocUrl}`);
  } else if ((args.pasteFallback || "").trim().length > 0) {
    parts.push(""); parts.push("");
    parts.push(sectionHeader("AI conversation (pasted)"));
    parts.push("");
    parts.push(args.pasteFallback.trim());
  }
  return parts.join("\n");
}

async function processSession(sessionId: string): Promise<void> {
  console.log(`\n=== ${sessionId} ===`);

  const { data: session } = await supabase
    .from("reflection_sessions")
    .select("*")
    .eq("id", sessionId)
    .single();
  if (!session) { console.error("  session not found"); return; }

  if (session.canvas_submission_id) {
    console.log(`  SKIP: already has canvas_submission_id=${session.canvas_submission_id}`);
    return;
  }
  if (session.state !== "submitted") {
    console.log(`  SKIP: state=${session.state} (expected submitted)`);
    return;
  }

  const { data: ta } = await supabase
    .from("teacher_assignments").select("*").eq("id", session.teacher_assignment_id).single();
  const { data: teacher } = await supabase
    .from("teachers").select("*").eq("id", ta!.teacher_id).single();
  const { data: student } = await supabase
    .from("students").select("*").eq("id", session.student_id).single();

  if (!ta || !teacher || !student) { console.error("  missing ta/teacher/student"); return; }
  if (!teacher.canvas_host || !teacher.canvas_token_encrypted) {
    console.error("  ERROR: teacher Canvas not connected");
    return;
  }

  let canvasUserId = student.canvas_user_id;
  if (!canvasUserId) {
    canvasUserId = await resolveCanvasUserIdFromRoster(
      ta.teacher_id,
      ta.canvas_course_id,
      student.email,
    );
    if (!canvasUserId) {
      console.error("  ERROR: roster lookup failed (no canvas_user_id for student)");
      return;
    }
    const newAnonToken = anonToken(canvasUserId, student.email);
    console.log(`  roster lookup → canvas_user_id=${canvasUserId}, re-keying anon_token`);
    if (!DRY_RUN) {
      const { error: backfillErr } = await supabase
        .from("students")
        .update({ canvas_user_id: canvasUserId, anon_token: newAnonToken })
        .eq("id", student.id);
      if (backfillErr) {
        console.error(`  student backfill failed: ${backfillErr.message}`);
        return;
      }
    }
  }

  let token: string;
  try { token = decryptSecret(teacher.canvas_token_encrypted, ENC_KEY); }
  catch (err) { console.error(`  decrypt failed: ${(err as Error).message}`); return; }

  const textBody = buildText({
    firstDraft: session.first_draft || "",
    objectiveSummary: session.objective_summary || "",
    reflectionMessages: (session.reflection_messages as Msg[]) || [],
    aiChats: (session.ai_chats as AiChat[]) || [],
    pasteFallback: session.paste_fallback_text || "",
    driveDocUrl: session.drive_doc_url || null,
  });

  console.log(`  course=${ta.canvas_course_id} assignment=${ta.canvas_assignment_id} canvas_user=${canvasUserId} body=${textBody.length}c drive=${session.drive_doc_url ? "yes" : "no"}`);

  if (DRY_RUN) {
    console.log("  --- comment preview (first 500c) ---");
    console.log(textBody.slice(0, 500));
    console.log("  --- end preview ---");
    return;
  }

  const params = new URLSearchParams();
  params.set("comment[text_comment]", textBody);
  const rawHost = teacher.canvas_host.replace(/\/$/, "");
  const host = /^https?:\/\//.test(rawHost) ? rawHost : `https://${rawHost}`;
  const url = `${host}/api/v1/courses/${ta.canvas_course_id}/assignments/${ta.canvas_assignment_id}/submissions/${encodeURIComponent(canvasUserId)}?as_user_id=${encodeURIComponent(canvasUserId)}`;

  const res = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const errMsg = `Canvas ${res.status}: ${body.slice(0, 500)}`;
    console.error(`  PUT failed: ${errMsg}`);
    await supabase.from("submission_attempts").insert({
      reflection_session_id: sessionId,
      success: false,
      error: `[backfill 2026-05-28] ${errMsg}`,
    });
    return;
  }

  const data = (await res.json()) as { id: number };
  const submissionId = String(data.id);
  console.log(`  Canvas OK submissionId=${submissionId}`);

  const { error: upErr } = await supabase
    .from("reflection_sessions")
    .update({ canvas_submission_id: submissionId })
    .eq("id", sessionId)
    .is("canvas_submission_id", null);

  if (upErr) {
    console.error(`  DB update failed (Canvas comment already posted!): ${upErr.message}`);
    await supabase.from("submission_attempts").insert({
      reflection_session_id: sessionId,
      success: true,
      error: `[backfill 2026-05-28] Canvas accepted submissionId=${submissionId} but DB update errored: ${upErr.message}`,
    });
    return;
  }

  await supabase.from("submission_attempts").insert({
    reflection_session_id: sessionId,
    success: true,
    error: `[backfill 2026-05-28] M3.8 SG-scope hand-off bypassed Canvas write; manually posted comment via backfill script.`,
  });
  console.log(`  DB updated, audit row written`);
}

(async () => {
  console.log(DRY_RUN ? "DRY RUN — no Canvas writes" : "LIVE — will post comments to Canvas");
  for (const id of SESSION_IDS) {
    try { await processSession(id); }
    catch (err) { console.error(`  FATAL for ${id}: ${(err as Error).message}`); }
  }
  console.log("\nDone.");
  process.exit(0);
})();
