-- Revoke the auto-granted anon EXECUTE on the rate-limit RPC.
--
-- Supabase auto-grants EXECUTE to {anon, authenticated, postgres,
-- service_role} on every freshly-created function in the public schema.
-- `revoke ... from public` in the original migration didn't clear it
-- because the grant is held by the explicit `anon` role, not by PUBLIC.
--
-- Without this, an unauthenticated attacker who knows (or guesses) a
-- teacher's UUID could pound the RPC to inflate that teacher's daily
-- counter past the cap, denying their students any Gemini-backed
-- reflection traffic for the rest of the day. The function is a
-- write-counter, not a data-read, so the leak surface is the DoS, not
-- exfiltration — but still worth closing.
--
-- The other helper functions (is_admin, is_teacher_owner, is_student_self)
-- were created before this Supabase default kicked in (or were touched
-- by a manual cleanup), so their ACLs already exclude anon. Spot-checked
-- via pg_proc.proacl on 2026-05-12.

revoke execute on function public.check_and_increment_gemini_call(uuid, int) from anon;
