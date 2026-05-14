-- Canvas data cache: teacher's courses + assignments synced from Canvas API.
--
-- Reads from these tables are user-context (RLS-scoped); writes happen through
-- the service-role admin client (sync action / nightly cron). RLS therefore
-- only needs SELECT policies — the cache is read-only from the UI side.
--
-- Sync model: nightly cron + on-demand "Refresh now" button.
-- last_synced_at on each row is when that specific row was last upserted.
-- teachers.last_canvas_sync_at is the last successful full-sync timestamp,
-- shown in the dashboard header.

-- 1) canvas_course_cache -----------------------------------------------------
create table canvas_course_cache (
  teacher_id uuid not null references teachers(id) on delete cascade,
  canvas_course_id text not null,
  name text not null,
  course_code text,
  workflow_state text not null,
  start_at timestamptz,
  end_at timestamptz,
  term_name text,
  term_start_at timestamptz,
  term_end_at timestamptz,
  last_synced_at timestamptz not null default now(),
  primary key (teacher_id, canvas_course_id)
);

alter table canvas_course_cache enable row level security;

create policy canvas_course_cache_self_select on canvas_course_cache
  for select using (is_teacher_owner(teacher_id));

-- 2) canvas_assignment_cache -------------------------------------------------
create table canvas_assignment_cache (
  teacher_id uuid not null references teachers(id) on delete cascade,
  canvas_course_id text not null,
  canvas_assignment_id text not null,
  name text not null,
  description text,
  due_at timestamptz,
  points_possible numeric,
  workflow_state text not null,
  published boolean,
  last_synced_at timestamptz not null default now(),
  primary key (teacher_id, canvas_assignment_id)
);

create index canvas_assignment_cache_course_idx
  on canvas_assignment_cache (teacher_id, canvas_course_id);

alter table canvas_assignment_cache enable row level security;

create policy canvas_assignment_cache_self_select on canvas_assignment_cache
  for select using (is_teacher_owner(teacher_id));

-- 3) teachers.last_canvas_sync_at -------------------------------------------
alter table teachers add column last_canvas_sync_at timestamptz;
