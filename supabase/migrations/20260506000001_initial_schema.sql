-- AI Documenter v2 — initial schema
-- Tables: teachers, students, teacher_assignments, reflection_sessions,
-- submission_attempts, course_install_policies, assignment_install_state.
-- RLS via auth.uid() match against teachers.auth_user_id / students.auth_user_id.
-- Backend writes use service role and bypass RLS.

-- 1) teachers ------------------------------------------------------------------
create table teachers (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid not null unique references auth.users(id) on delete cascade,
  google_sub text unique,
  email text not null unique check (email = lower(email)),
  display_name text not null,
  canvas_token_encrypted text,
  canvas_host text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 2) students ------------------------------------------------------------------
create table students (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid unique references auth.users(id) on delete cascade,
  canvas_user_id text unique,
  google_sub text unique,
  email text not null unique check (email = lower(email)),
  display_name text not null,
  anon_token text not null unique,
  created_at timestamptz not null default now()
);

create index students_anon_token_idx on students (anon_token);

-- 3) teacher_assignments -------------------------------------------------------
create table teacher_assignments (
  id uuid primary key default gen_random_uuid(),
  teacher_id uuid not null references teachers(id) on delete cascade,
  canvas_course_id text not null,
  canvas_assignment_id text not null,
  reflection_prompt text not null,
  allowed_tools text[] not null default array['gemini', 'chatgpt', 'claude'],
  oral_mode_enabled boolean not null default false,
  written_mode_enabled boolean not null default true,
  iframe_token text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  unique (teacher_id, canvas_assignment_id)
);

create index teacher_assignments_teacher_idx on teacher_assignments (teacher_id);
create index teacher_assignments_canvas_assignment_idx on teacher_assignments (canvas_assignment_id);

-- 4) reflection_sessions -------------------------------------------------------
create type reflection_mode as enum ('written', 'oral');
create type reflection_state as enum ('started', 'in_progress', 'completed', 'submitted', 'failed');

create table reflection_sessions (
  id uuid primary key default gen_random_uuid(),
  teacher_assignment_id uuid not null references teacher_assignments(id) on delete cascade,
  student_id uuid not null references students(id) on delete cascade,
  mode reflection_mode not null,
  state reflection_state not null default 'started',
  ai_transcript_url text,
  ai_transcript_text text,
  ai_tools_used text[],
  reflection_messages jsonb not null default '[]'::jsonb,
  canvas_submission_id text,
  completion_code text not null unique,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  submitted_at timestamptz,
  expires_at timestamptz not null default (now() + interval '1 year')
);

create index reflection_sessions_assignment_idx on reflection_sessions (teacher_assignment_id);
create index reflection_sessions_student_idx on reflection_sessions (student_id);

-- 5) submission_attempts -------------------------------------------------------
create table submission_attempts (
  id uuid primary key default gen_random_uuid(),
  reflection_session_id uuid not null references reflection_sessions(id) on delete cascade,
  attempted_at timestamptz not null default now(),
  success boolean not null,
  error text
);

create index submission_attempts_session_idx on submission_attempts (reflection_session_id);

-- 6) course_install_policies (Phase B2) ----------------------------------------
create table course_install_policies (
  id uuid primary key default gen_random_uuid(),
  teacher_id uuid not null references teachers(id) on delete cascade,
  canvas_course_id text not null,
  default_reflection_prompt text not null,
  default_allowed_tools text[] not null default array['gemini', 'chatgpt', 'claude'],
  auto_install_new_assignments boolean not null default false,
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (teacher_id, canvas_course_id)
);

-- 7) assignment_install_state (Phase B2) ---------------------------------------
create type install_status as enum ('installed', 'uninstalled', 'failed');

create table assignment_install_state (
  id uuid primary key default gen_random_uuid(),
  teacher_id uuid not null references teachers(id) on delete cascade,
  canvas_course_id text not null,
  canvas_assignment_id text not null,
  status install_status not null,
  prompt_version int,
  iframe_token text,
  installed_at timestamptz,
  uninstalled_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (teacher_id, canvas_assignment_id)
);

create index assignment_install_state_teacher_idx on assignment_install_state (teacher_id);

-- updated_at triggers ----------------------------------------------------------
create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger teachers_set_updated_at before update on teachers
  for each row execute function set_updated_at();
create trigger teacher_assignments_set_updated_at before update on teacher_assignments
  for each row execute function set_updated_at();
create trigger course_install_policies_set_updated_at before update on course_install_policies
  for each row execute function set_updated_at();
create trigger assignment_install_state_set_updated_at before update on assignment_install_state
  for each row execute function set_updated_at();

-- RLS helpers + policies -------------------------------------------------------
-- SECURITY DEFINER + search_path=public to avoid recursion when other tables'
-- policies check it (super-grader hit recursion without this).
create or replace function is_teacher_owner(t_id uuid)
returns boolean language sql security definer set search_path = public as $$
  select exists (
    select 1 from teachers t
    where t.id = t_id and t.auth_user_id = auth.uid()
  );
$$;

create or replace function is_student_self(s_id uuid)
returns boolean language sql security definer set search_path = public as $$
  select exists (
    select 1 from students s
    where s.id = s_id and s.auth_user_id = auth.uid()
  );
$$;

alter table teachers enable row level security;
alter table students enable row level security;
alter table teacher_assignments enable row level security;
alter table reflection_sessions enable row level security;
alter table submission_attempts enable row level security;
alter table course_install_policies enable row level security;
alter table assignment_install_state enable row level security;

-- teachers: a teacher sees and updates only their own row
create policy teachers_self_select on teachers
  for select using (auth_user_id = auth.uid());
create policy teachers_self_update on teachers
  for update using (auth_user_id = auth.uid());

-- students: a student sees only their own row (teacher reads via service role)
create policy students_self_select on students
  for select using (auth_user_id = auth.uid());

-- teacher_assignments: teacher manages their own
create policy teacher_assignments_self_select on teacher_assignments
  for select using (is_teacher_owner(teacher_id));
create policy teacher_assignments_self_modify on teacher_assignments
  for all using (is_teacher_owner(teacher_id))
  with check (is_teacher_owner(teacher_id));

-- reflection_sessions: teacher sees sessions under their assignments;
-- student sees their own
create policy reflection_sessions_teacher_select on reflection_sessions
  for select using (
    exists (
      select 1 from teacher_assignments ta
      where ta.id = reflection_sessions.teacher_assignment_id
        and is_teacher_owner(ta.teacher_id)
    )
  );
create policy reflection_sessions_student_select on reflection_sessions
  for select using (is_student_self(student_id));

-- submission_attempts: teacher only
create policy submission_attempts_teacher_select on submission_attempts
  for select using (
    exists (
      select 1 from reflection_sessions rs
      join teacher_assignments ta on ta.id = rs.teacher_assignment_id
      where rs.id = submission_attempts.reflection_session_id
        and is_teacher_owner(ta.teacher_id)
    )
  );

-- course_install_policies / assignment_install_state: teacher only
create policy course_install_policies_self on course_install_policies
  for all using (is_teacher_owner(teacher_id))
  with check (is_teacher_owner(teacher_id));

create policy assignment_install_state_self on assignment_install_state
  for all using (is_teacher_owner(teacher_id))
  with check (is_teacher_owner(teacher_id));
