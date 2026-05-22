-- Phase 1 of REMEDIATION_PLAN.md — snapshot semantics on reflection_sessions.
--
-- Goal: a reflection's prompt body, student-facing question, destination
-- flags, card text, and scrub roster are FROZEN at session start (intake
-- time). socratic.ts / finalize.ts / canvas-submit.ts read from the
-- snapshots, never from the live prompts / teacher_assignments / card_text
-- rows, so a teacher edit (auto-save fires every keystroke) cannot
-- retroactively change what an in-progress or already-finalized reflection
-- meant.
--
-- Same pattern as OE 20260521120000. AID's snapshot point is intake (rather
-- than an atomic begin_*_session RPC); Phase 2 introduces the atomic-claim
-- pattern for the bootstrap / advance / finalize transitions.
--
-- Background gotchas this addresses (from the 2026-05-21 audit):
--   session-state H2: prompts.body referenced live in socratic.ts; a teacher
--     edit mid-conversation produces a closing-Gemini-call with a different
--     system prompt than the alignment question used.
--   session-state H3: teacher_assignments.post_to_canvas_* and card text
--     referenced live in finalize / canvas-submit / install; a flip from
--     "submission" to "comment-only" between intake and finalize means the
--     student presumes the reflection IS the submission but it routes to a
--     comment, leaving the gradebook unsubmitted.
--   pii-scrub Bug 1+5: roster sync mid-session can widen the scrub gap or
--     swap which teacher's roster is used (lookup is keyed by
--     canvas_course_id only with .limit(1) — non-deterministic on shared
--     courses). Phase 1's roster_snapshot pins the roster used for the
--     whole session lifecycle to whatever was active at intake.

-- 1. Snapshot columns. Nullable so legacy sessions (created before this
--    migration) keep working; callers detect "snapshot populated" by
--    `prompt_body_snapshot IS NOT NULL` and fall back to live reads
--    otherwise. scrub_status is NOT NULL with a default for observability.

alter table reflection_sessions
  add column prompt_body_snapshot              text,
  add column student_facing_question_snapshot  text,
  add column card_text_snapshot                jsonb,
  add column post_to_canvas_comment_at_session boolean,
  add column post_to_canvas_submission_at_session boolean,
  add column post_to_drive_at_session          boolean,
  add column roster_snapshot                   jsonb,
  add column scrub_status                      text not null default 'ok'
    check (scrub_status in ('ok','failed','skipped'));

comment on column reflection_sessions.prompt_body_snapshot is
  'Phase 1: prompts.body frozen at session start. socratic.ts reads from here, never from the live prompts row. Sentinel for "is this a snapshot session" — null = legacy, fall back to live live read via teacher_assignments → prompts.';
comment on column reflection_sessions.student_facing_question_snapshot is
  'Phase 1: prompts.student_facing_question frozen at session start. Teacher review reads from here so the displayed question matches what the student saw.';
comment on column reflection_sessions.card_text_snapshot is
  'Phase 1: resolved card text (kicker/title/body/cta_label/footnote, post-fallback) at session start. Teacher review surface can render the exact card the student opened.';
comment on column reflection_sessions.post_to_canvas_comment_at_session is
  'Phase 1: teacher_assignments.post_to_canvas_comment frozen at session start. finalize/canvas-submit branch on this so a teacher destination flip between intake and finalize cannot retroactively change where the reflection lands.';
comment on column reflection_sessions.post_to_canvas_submission_at_session is
  'Phase 1: teacher_assignments.post_to_canvas_submission frozen at session start. See post_to_canvas_comment_at_session.';
comment on column reflection_sessions.post_to_drive_at_session is
  'Phase 1: teacher_assignments.post_to_drive frozen at session start. Writer plugs in when M7.3 ships; the snapshot is forward-compatible.';
comment on column reflection_sessions.roster_snapshot is
  'Phase 1: subset of course_rosters.students used for transcript scrubbing throughout the session lifecycle (bootstrap + closing Gemini calls). Frozen at session start so roster sync mid-reflection cannot widen the scrub gap.';
comment on column reflection_sessions.scrub_status is
  'Phase 1: ok = Gemini calls ran under a valid roster; failed = Phase 0 fail-closed event (shouldn''t land in DB but exposed for monitoring); skipped = legacy session predating snapshot.';

-- Backfill scrub_status='skipped' on existing rows so the observability
-- signal is honest (no snapshot was ever populated for them).
update reflection_sessions
   set scrub_status = 'skipped'
 where prompt_body_snapshot is null;
