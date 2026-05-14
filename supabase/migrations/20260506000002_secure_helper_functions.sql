-- 1) Pin search_path on set_updated_at trigger function (linter 0011).
create or replace function set_updated_at()
returns trigger language plpgsql
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- 2) Revoke REST-callable EXECUTE on the SECURITY DEFINER helper functions
--    (linter 0028 / 0029). RLS internal evaluation does not need this grant;
--    HTTP callers via /rest/v1/rpc do, and we don't want that.
revoke execute on function is_teacher_owner(uuid) from public;
revoke execute on function is_teacher_owner(uuid) from anon;
revoke execute on function is_teacher_owner(uuid) from authenticated;

revoke execute on function is_student_self(uuid) from public;
revoke execute on function is_student_self(uuid) from anon;
revoke execute on function is_student_self(uuid) from authenticated;
