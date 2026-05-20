-- M6.18a: 3-checkbox deliverable-destination picker.
--
-- Replaces the single `teacher_assignments.use_submission_body` boolean
-- with three independent booleans:
--   - post_to_drive            (default true; writer fires when M7.3 lands)
--   - post_to_canvas_comment   (default true; teacher's SpeedGrader pass)
--   - post_to_canvas_submission (default false; opt-in for "reflection IS the deliverable")
--
-- The columns are independent — any combination including all three is
-- valid. "Drive only" is `post_to_drive=true` + both Canvas flags false.
-- The legacy `use_submission_body` column stays for one cycle as a fallback
-- in case rollback is needed; M6.18a-followup drops it.

ALTER TABLE public.teacher_assignments
  ADD COLUMN post_to_drive boolean NOT NULL DEFAULT true,
  ADD COLUMN post_to_canvas_comment boolean NOT NULL DEFAULT true,
  ADD COLUMN post_to_canvas_submission boolean NOT NULL DEFAULT false;

-- Backfill from the legacy column. Pre-existing rows where the teacher
-- opted in to "Reflection IS the submission" become submission=true +
-- comment=false; everything else inherits the new defaults.
UPDATE public.teacher_assignments
SET
  post_to_canvas_submission = true,
  post_to_canvas_comment = false
WHERE use_submission_body = true;

COMMENT ON COLUMN public.teacher_assignments.post_to_drive IS
  'M6.18a: deliverable lands in the teacher''s Drive folder. Writer fires when M7.3 ships; checkbox stores teacher intent immediately.';
COMMENT ON COLUMN public.teacher_assignments.post_to_canvas_comment IS
  'M6.18a: deliverable lands as a draft comment in SpeedGrader (teacher reviews before student sees).';
COMMENT ON COLUMN public.teacher_assignments.post_to_canvas_submission IS
  'M6.18a: deliverable IS the student''s submission body (or discussion reply on discussion-topic assignments).';
COMMENT ON COLUMN public.teacher_assignments.use_submission_body IS
  'DEPRECATED 2026-05-20: replaced by post_to_canvas_submission + post_to_canvas_comment. Kept for one cycle as a rollback safety net; readers should already be migrated. Drop in a follow-up migration.';
