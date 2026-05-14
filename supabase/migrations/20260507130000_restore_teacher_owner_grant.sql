-- Reverse the over-cautious revoke from 20260506000002.
--
-- Postgres checks the calling role's EXECUTE privilege when a RLS policy
-- expression invokes a function — so revoking EXECUTE from `authenticated`
-- silently caused every policy that calls `is_teacher_owner(teacher_id)` to
-- return zero rows under user-context queries (teacher_assignments,
-- assignment_install_state, course_install_policies, canvas_course_cache,
-- canvas_assignment_cache).
--
-- Restoring the grant is safe: the function is SECURITY DEFINER and only
-- returns a boolean for whether a given teacher_id is owned by auth.uid() —
-- information the caller can already derive by reading their own teachers
-- row.
--
-- (is_student_self has the same problem and the same logic — restored too.)

grant execute on function is_teacher_owner(uuid) to authenticated;
grant execute on function is_student_self(uuid) to authenticated;
