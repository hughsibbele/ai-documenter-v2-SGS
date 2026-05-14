-- Admin layer + shared system prompts.
--
-- 1) admins table — keyed on email, modeled on Handwritten-Assignment-Helper's
--    021_add_admin_layer migration. is_admin() is SECURITY DEFINER so RLS
--    policies can call it; like is_teacher_owner, it must be EXECUTE-able by
--    `authenticated` or RLS evaluation will silently fail (see
--    feedback_supabase_rls_function_grants.md in memory).
--
-- 2) prompts.scope: 'system' (admin-edited, shared across all teachers) or
--    'teacher' (per-teacher, owner-edited). The seeded Default rolls up from
--    a per-teacher Default into one shared system row — teacher_assignments
--    and course_install_policies that pointed at any per-teacher Default
--    rebind to the new system row.

-- 1) admins ------------------------------------------------------------------
create table admins (
  email text primary key check (email = lower(email)),
  granted_by_email text,
  granted_at timestamptz not null default now(),
  active boolean not null default true
);

alter table admins enable row level security;

create or replace function is_admin()
returns boolean language sql security definer set search_path = public, auth as $$
  select exists (
    select 1 from admins a
    where a.active = true
      and a.email = lower((auth.jwt() ->> 'email'))
  );
$$;

revoke execute on function is_admin() from public;
revoke execute on function is_admin() from anon;
grant execute on function is_admin() to authenticated;

-- Admins can read/manage the table. Bootstrap (first admin insertion) happens
-- via the service-role admin client in app code, which bypasses RLS.
create policy admins_select on admins
  for select using (is_admin());
create policy admins_modify on admins
  for all using (is_admin())
  with check (is_admin());

-- 2) prompts.scope ----------------------------------------------------------
alter table prompts add column scope text not null default 'teacher'
  check (scope in ('system', 'teacher'));

alter table prompts alter column teacher_id drop not null;

alter table prompts add constraint prompts_scope_teacher_id_check
  check (
    (scope = 'system' and teacher_id is null) or
    (scope = 'teacher' and teacher_id is not null)
  );

-- 3) Roll up existing per-teacher Default into one system Default ------------
-- Strategy: take the oldest is_default row, repurpose it as scope='system'.
-- For any other is_default rows, rebind their FK referrers to that one and
-- delete them. Today we only have one teacher so the loop body runs zero
-- times, but it's idempotent for future re-runs in dev.
do $$
declare
  system_default_id uuid;
  duplicate_id uuid;
begin
  select id into system_default_id
  from prompts
  where is_default = true
  order by created_at
  limit 1;

  if system_default_id is null then
    return;
  end if;

  update prompts
    set scope = 'system', teacher_id = null
    where id = system_default_id;

  for duplicate_id in
    select id from prompts where is_default = true and id != system_default_id
  loop
    update teacher_assignments
      set prompt_id = system_default_id
      where prompt_id = duplicate_id;
    update course_install_policies
      set default_prompt_id = system_default_id
      where default_prompt_id = duplicate_id;
    delete from prompts where id = duplicate_id;
  end loop;
end $$;

-- 4) Replace label uniqueness with scope-aware partial uniques --------------
alter table prompts drop constraint if exists prompts_teacher_id_label_key;
drop index if exists prompts_one_default_per_teacher;

create unique index prompts_label_unique_system
  on prompts (label) where scope = 'system';
create unique index prompts_label_unique_teacher
  on prompts (teacher_id, label) where scope = 'teacher';

-- 5) Scope-aware RLS for prompts --------------------------------------------
drop policy if exists prompts_self on prompts;

create policy prompts_select on prompts
  for select using (
    scope = 'system'
    or (scope = 'teacher' and is_teacher_owner(teacher_id))
  );

create policy prompts_modify on prompts
  for all using (
    (scope = 'system' and is_admin())
    or (scope = 'teacher' and teacher_id is not null and is_teacher_owner(teacher_id))
  )
  with check (
    (scope = 'system' and is_admin())
    or (scope = 'teacher' and teacher_id is not null and is_teacher_owner(teacher_id))
  );
