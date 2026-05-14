-- Per-assignment opt-in for body-as-submission vs comment-as-submission.
--
-- Background: prior to 2026-05-13, finalize tried a regular online_text_entry
-- POST first and fell back to a submission-comment PUT only on 400/422
-- (file-upload-only assignments). That arrangement had two practical issues:
--   1. On Turnitin-Plagiarism-Framework assignments, the body POST fed our
--      reflection HTML to Turnitin's similarity engine as if it were the
--      student's essay — producing meaningless similarity scores against our
--      boilerplate phrases.
--   2. Super-grader's Canvas scrape (per integration-contract §12) was
--      supposed to filter marker-tagged AI Documenter bodies but didn't —
--      so super-grader surfaced our reflection HTML as the student's primary
--      work in its grading view.
--
-- The new default is comment-as-submission for every assignment type. The
-- reflection content lands as a submission comment authored by the student
-- (via as_user_id masquerade); the student's actual essay/file/upload stays
-- as the canonical submission. Teachers who want the reflection to BE the
-- submission (AI-literacy assignments, capstone reflections) opt in at
-- install time via this column.
--
-- Default false so every existing teacher_assignments row flips to comment
-- on the next finalize. No data migration needed — finalize is idempotent
-- and reads the flag fresh per submit.

ALTER TABLE teacher_assignments
  ADD COLUMN use_submission_body boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN teacher_assignments.use_submission_body IS
  'When true, finalize POSTs the reflection as an online_text_entry submission body (with comment-fallback on 400/422). When false (default), finalize PUTs the reflection as a submission comment only. Set at install time per assignment.';
