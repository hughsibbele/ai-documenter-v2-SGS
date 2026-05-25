-- M7.11 — per-assignment preview mode for teachers.
--
-- Teachers can preview the full student reflection flow without polluting
-- the gradebook or pushing to Canvas/Drive/super-grader.

alter table reflection_sessions
  add column is_preview boolean not null default false;

-- One active preview per teacher per assignment. Starting a new preview
-- deletes the old one (app logic), but the constraint is belt-and-braces.
create unique index reflection_sessions_preview_unique
  on reflection_sessions (teacher_assignment_id)
  where is_preview = true;
