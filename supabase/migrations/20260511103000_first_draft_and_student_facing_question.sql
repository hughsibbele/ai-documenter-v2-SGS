-- M3.1 — First-draft reflection + student-facing prompt question
--
-- Two new columns to support the M3 student-side UX redesign:
--
-- 1. `prompts.student_facing_question` — the short, official question that
--    displays to students on the intake + Socratic pages. The existing
--    `prompts.body` stays as the Gemini system prompt (full of model
--    instructions like "refer to the student as 'you', never apologize…"),
--    which is the wrong shape for student display. Nullable for now;
--    `objective_summary`-purpose prompts are admin infrastructure and never
--    student-facing, so they leave it null. Reflection-purpose prompts
--    should always have it set — the UI enforces this.
--
-- 2. `reflection_sessions.first_draft` — the locked-once-submitted paragraph
--    a student writes on the intake screen, before the Socratic coaching
--    begins. Becomes part of the Canvas submission body alongside the
--    Socratic Q&A (per the M3 design decision: Canvas gets first draft +
--    coaching transcript + AI transcript link; objective summary goes only
--    to teacher review + super-grader, not Canvas).

ALTER TABLE prompts
  ADD COLUMN student_facing_question text;

ALTER TABLE reflection_sessions
  ADD COLUMN first_draft text;

-- Seed the system reflection prompt with a sensible default question.
-- Objective-summary prompts stay null (intentional).
UPDATE prompts
SET student_facing_question =
  'Reflect on how you used AI for this assignment. What was your process? Where did the AI help your thinking, and where did it just give you an answer?'
WHERE scope = 'system' AND purpose = 'reflection' AND is_default = true;

COMMENT ON COLUMN prompts.student_facing_question IS
  'Short, official-tone question shown to students on the intake + Socratic pages. The full prompts.body remains the Gemini system prompt (model instructions). Required for reflection-purpose prompts (UI-enforced); null for objective_summary.';

COMMENT ON COLUMN reflection_sessions.first_draft IS
  'Locked-once-submitted student paragraph written on the intake screen. Becomes part of the Canvas submission alongside the Socratic Q&A.';
