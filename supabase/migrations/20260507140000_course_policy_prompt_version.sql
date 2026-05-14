-- Track which version of the course's reflection prompt is "current".
-- Bumped on every prompt save; written into the iframe marker block as
-- `prompt-version=N` so the dashboard can detect "stale" installs (where
-- the installed prompt-version is < the policy's current version).

alter table course_install_policies
  add column prompt_version int not null default 1;
