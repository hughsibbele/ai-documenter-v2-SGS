-- Fix the auto-install "installs on everything" bug.
--
-- The previous check was: install on every published assignment that has no
-- `assignment_install_state` row at all. The intent ("install on assignments
-- created after auto-install was enabled") only matches the implementation
-- on courses where the teacher has previously installed on at least some
-- assignments — pristine courses get a full sweep on the first run.
--
-- Two new fields fix this cleanly:
--   - `course_install_policies.auto_install_enabled_at`: when the policy
--     flipped from off → on. Updated by setCourseAutoInstall.
--   - `canvas_assignment_cache.first_seen_at`: set on INSERT (default now()),
--     preserved across upserts. The sync upsert doesn't write this column,
--     so existing rows keep their first-seen timestamp on every refresh.
--
-- Auto-install now filters: install only when
--   `assignment.first_seen_at > policy.auto_install_enabled_at`
-- AND no assignment_install_state row exists. Assignments that were already
-- in the cache when auto-install was enabled get baselined automatically.

alter table public.course_install_policies
  add column if not exists auto_install_enabled_at timestamptz;

alter table public.canvas_assignment_cache
  add column if not exists first_seen_at timestamptz not null default now();

-- Backfill: any existing policy with auto-install already on gets a fresh
-- enabled_at = now(). The "stop installing on assignments that already
-- existed" semantics kicks in from this moment forward for those teachers.
-- Without this backfill, the next sweep would still install on everything
-- (because enabled_at IS NULL means the filter never matches).
update public.course_install_policies
  set auto_install_enabled_at = now()
  where auto_install_new_assignments = true
    and auto_install_enabled_at is null;
