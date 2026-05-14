-- C3.1 — Objective summary column
--
-- Generated server-side after the Socratic conversation completes via a
-- separate Gemini call using the `purpose='objective_summary'` system prompt.
-- ~100 words, descriptive (not evaluative). The output:
--   - Goes into the super-grader webhook envelope (super-grader displays it
--     in its AI Use card and uses it for grading suggestions).
--   - Renders on the teacher review surface in Phase D, always visible above
--     the reflection transcript.
--   - Does NOT appear in the Canvas submission body. Decision rationale:
--     teachers + super-grader see the objective lens of the student's AI use;
--     the Canvas submission stays the student's voice (first draft + Socratic
--     Q&A + AI transcript link).

ALTER TABLE reflection_sessions
  ADD COLUMN objective_summary text;

COMMENT ON COLUMN reflection_sessions.objective_summary IS
  'Server-generated ~100-word descriptive summary of the student''s AI use. Anonymized in / de-anonymized out. Source for super-grader webhook + teacher review surface; NOT included in Canvas submission body.';
