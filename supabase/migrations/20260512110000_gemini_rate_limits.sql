-- Per-teacher daily rate limit on Gemini calls. Defensive — protects the
-- centralized EHS-paid key from a runaway prompt loop or a teacher who
-- accidentally wires up something unusual.
--
-- Storage: one row per (teacher_id, date). Atomic check + increment runs
-- inside a SECURITY DEFINER function so the app can call it without needing
-- a service-role boundary at every Gemini call site.

create table if not exists public.gemini_usage_daily (
  teacher_id uuid not null references public.teachers(id) on delete cascade,
  date date not null,
  calls int not null default 0,
  denials int not null default 0,
  updated_at timestamptz not null default now(),
  primary key (teacher_id, date)
);

alter table public.gemini_usage_daily enable row level security;

-- Teachers see their own daily counts. Admins see everyone's.
create policy gemini_usage_daily_select_self
  on public.gemini_usage_daily
  for select
  using (
    public.is_teacher_owner(teacher_id) or public.is_admin()
  );

-- Writes go through the SECURITY DEFINER function below.
revoke insert, update, delete on public.gemini_usage_daily from authenticated;

-- Per-teacher cap override. Null = fall back to the env-driven default.
alter table public.teachers
  add column if not exists gemini_daily_cap int;

-- Atomic check + increment. Returns whether the call is allowed plus the
-- post-increment state for callers that want to surface it.
--
-- Behavior:
--   * Looks up the teacher's cap (column override, else the default param).
--   * Locks the day's usage row, reads `calls`, decides allow/deny.
--   * Allow: increment calls, return allowed=true.
--   * Deny:  increment denials, return allowed=false.
--   * No prior row for today → seeds one before the read.
create or replace function public.check_and_increment_gemini_call(
  p_teacher_id uuid,
  p_default_cap int
)
returns table(allowed boolean, calls_today int, denials_today int, daily_cap int)
language plpgsql security definer set search_path = public
as $$
declare
  v_cap int;
  v_calls int;
  v_denials int;
  v_date date := current_date;
begin
  select coalesce(t.gemini_daily_cap, p_default_cap) into v_cap
    from public.teachers t where t.id = p_teacher_id;
  if v_cap is null then v_cap := coalesce(p_default_cap, 500); end if;

  insert into public.gemini_usage_daily(teacher_id, date)
    values (p_teacher_id, v_date)
    on conflict (teacher_id, date) do nothing;

  select calls, denials into v_calls, v_denials
    from public.gemini_usage_daily
    where teacher_id = p_teacher_id and date = v_date
    for update;

  if v_calls >= v_cap then
    update public.gemini_usage_daily
      set denials = denials + 1, updated_at = now()
      where teacher_id = p_teacher_id and date = v_date;
    return query select false, v_calls, v_denials + 1, v_cap;
  else
    update public.gemini_usage_daily
      set calls = calls + 1, updated_at = now()
      where teacher_id = p_teacher_id and date = v_date;
    return query select true, v_calls + 1, v_denials, v_cap;
  end if;
end;
$$;

-- EXECUTE grant — without this the function silently returns nothing under
-- the authenticated role (see user-level memory note on Supabase RLS
-- function grants).
revoke all on function public.check_and_increment_gemini_call(uuid, int) from public;
grant execute on function public.check_and_increment_gemini_call(uuid, int) to authenticated;
grant execute on function public.check_and_increment_gemini_call(uuid, int) to service_role;
