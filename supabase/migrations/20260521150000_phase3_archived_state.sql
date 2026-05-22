-- Phase 3 of REMEDIATION_PLAN.md — stale-session sweep terminal state.
--
-- The sweep cron (/api/cron/sweep-sessions) needs a distinct terminal
-- state for "stuck >14 days, never finalized" so:
--   - the dashboard / reviews / SG envelope path can tell them apart from
--     a Canvas-failed 'failed' (which is retryable)
--   - the Phase 2 partial unique index (which covers in_progress / completed
--     / submitted) automatically RELEASES on archive — a teacher reset of a
--     stuck session lets the student start a fresh intake the next time
--     they open the /r/<token> link, without code-side coordination
--
-- 'archived' goes after 'failed' so the enum ordering reads
-- start -> in_progress -> completed -> submitted (terminal-success) and
-- failed / archived (terminal-recoverable / terminal-stuck).

alter type reflection_state add value 'archived' after 'failed';

comment on type reflection_state is
  'Lifecycle: started -> in_progress -> completed -> submitted (terminal); failed (Canvas POST failed, retryable); archived (Phase 3: stuck >14d, swept by /api/cron/sweep-sessions, terminal).';
