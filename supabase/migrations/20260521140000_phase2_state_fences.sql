-- Phase 2 of REMEDIATION_PLAN.md — state fences + idempotency.
--
-- Three patterns:
--   2a. Partial unique index for intake idempotency. Two concurrent
--       submitIntake calls (network blip + auto-retry, devtools replay,
--       refresh storm) can no longer both insert a new row; the second sees
--       a 23505 and submitIntake upgrades to "return the existing session
--       id" rather than failing or duplicating. Partial on non-terminal
--       states so a teacher reset (state='failed') can allow a fresh start.
--
--   2b. advance_socratic_turn RPC — atomic state-fenced advance for the
--       bootstrap / Q1→Q2 / Q2→close paths in socratic.ts. Caller passes
--       the expected reflection_messages length; UPDATE only applies if
--       length still matches at row level. Returns 1 if write applied, 0
--       if another caller advanced first (caller re-reads and returns
--       current state — idempotent UX, no clobber of the winner's payload).
--
--   2c. (No migration; finalize.ts gains a .eq("state","completed") fence
--       and persistSuccess returns ok:false on local-UPDATE failure. See
--       the Phase 2 commit on apps/teacher-admin/src/lib/actions/finalize.ts.)
--
-- Background gotchas this closes (from the 2026-05-21 audit):
--   session-state C1: no UNIQUE(teacher_assignment_id, student_id) means
--     double-click on intake mints two parallel sessions.
--   session-state C2: intake re-submission silently inserts over a finished
--     session (devtools replay attack: bury a finalized reflection under a
--     fresh in_progress row to re-run Gemini + re-fire the SG webhook).
--   session-state C3' (bootstrap race), H1 (per-turn race), C4 (finalize
--     race): all read-then-write with no atomic claim; concurrent callers
--     double-charge Gemini, clobber state, or double-post to Canvas.

-- 2a. Partial unique index — fence intake against duplicate active sessions.

create unique index reflection_sessions_active_per_assignment_uidx
  on reflection_sessions (teacher_assignment_id, student_id)
  where state in ('in_progress', 'completed', 'submitted');

comment on index reflection_sessions_active_per_assignment_uidx is
  'Phase 2: prevents two concurrent submitIntake calls from minting two sessions for the same (assignment, student). Partial — terminal states (failed) can be re-attempted; the index does not cover them so a recovery insert won''t collide.';

-- 2b. advance_socratic_turn — atomic state-fenced UPDATE for the three
--     conversation-advance paths in socratic.ts.

create or replace function advance_socratic_turn(
  p_session_id        uuid,
  p_expected_length   int,
  p_new_messages      jsonb,
  p_new_state         reflection_state,
  p_objective_summary text default null,
  p_completed_at      timestamptz default null
)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_rows int;
begin
  update reflection_sessions
     set reflection_messages = p_new_messages,
         state               = p_new_state,
         objective_summary   = coalesce(p_objective_summary, objective_summary),
         completed_at        = coalesce(p_completed_at, completed_at)
   where id = p_session_id
     and state = 'in_progress'
     and jsonb_array_length(reflection_messages) = p_expected_length;
  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

revoke execute on function advance_socratic_turn(
  uuid, int, jsonb, reflection_state, text, timestamptz
) from public;
revoke execute on function advance_socratic_turn(
  uuid, int, jsonb, reflection_state, text, timestamptz
) from anon;
grant execute on function advance_socratic_turn(
  uuid, int, jsonb, reflection_state, text, timestamptz
) to authenticated, service_role;

comment on function advance_socratic_turn(
  uuid, int, jsonb, reflection_state, text, timestamptz
) is
  'Phase 2: atomic state-fenced advance for socratic.ts. Caller passes expected reflection_messages length; UPDATE only applies if length still matches at row level. Returns 1 if write applied, 0 if another caller advanced first (caller should re-read and return current state).';
