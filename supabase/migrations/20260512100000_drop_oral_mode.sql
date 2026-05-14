-- Cut oral mode entirely. Decision logged in CLAUDE.md (2026-05-12).
--
-- Removes:
--   * teacher_assignments.oral_mode_enabled (always false; never used)
--   * reflection_sessions.mode             (always 'written'; never anything else)
--   * reflection_mode enum                 (orphaned once mode column drops)
--
-- Idempotent against re-runs via the `if exists` guards. Safe at any data
-- volume: no production rows carry mode='oral' or oral_mode_enabled=true
-- (the oral surface never shipped), so this is a pure schema simplification.

alter table public.teacher_assignments
  drop column if exists oral_mode_enabled;

alter table public.reflection_sessions
  drop column if exists mode;

drop type if exists public.reflection_mode;
