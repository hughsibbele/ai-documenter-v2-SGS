-- Canvas roster cache, per (teacher, course). Powers the free-text PII
-- scrubber that runs over pasted AI transcripts before they reach Gemini.
-- Refreshed by the nightly cron alongside the assignment cache.
--
-- Storage shape: a single jsonb array of {canvas_user_id, name, email}
-- rather than a normalized table. Reads are always "give me the roster for
-- this course"; we don't query by individual student here. Compactness +
-- single-row reads beat a join table.

create table if not exists public.course_rosters (
  teacher_id uuid not null references public.teachers(id) on delete cascade,
  canvas_course_id text not null,
  students jsonb not null default '[]'::jsonb,
  last_synced_at timestamptz not null default now(),
  primary key (teacher_id, canvas_course_id)
);

alter table public.course_rosters enable row level security;

-- Teachers see their own course rosters. Admins see everything.
drop policy if exists course_rosters_select_self on public.course_rosters;
create policy course_rosters_select_self
  on public.course_rosters
  for select
  using (
    public.is_teacher_owner(teacher_id) or public.is_admin()
  );

-- Writes go through the service-role admin client (cron + manual refresh).
revoke insert, update, delete on public.course_rosters from authenticated;
