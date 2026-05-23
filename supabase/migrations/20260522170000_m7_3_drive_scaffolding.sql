-- M7.3 (scaffolding only) — Google OAuth tokens + Drive folder + per-
-- session Drive ref columns. No user-visible behavior change yet — the
-- subsequent M7.3 wiring commit hooks save-to-Drive into the finalize
-- flow and replaces the inline transcript section in Canvas body with
-- a Drive link.
--
-- Direct port of HH M7.5's column shape; greenfield for AID since AID
-- hasn't previously stored Google OAuth tokens (no Drive integration
-- existed). Encrypted-only — no legacy plaintext fallback debt to
-- carry. Key: TEACHER_GTOKEN_ENC_KEY (new env var; matches HH's
-- naming for cross-app rotation alignment).
--
-- canvas_comment_enabled added for cross-app symmetry even though AID's
-- Canvas-comment gating today flows through teacher_assignments.post_
-- to_canvas_comment (M6.18 destination picker). Keeps the teachers
-- shape aligned with HH + OE for the eventual M5 consolidation.

alter table teachers
  add column google_access_token_encrypted text,
  add column google_refresh_token_encrypted text,
  add column google_token_expires_at timestamptz,
  add column drive_folder_id text,
  add column canvas_comment_enabled boolean not null default true;

alter table reflection_sessions
  add column drive_doc_id text,
  add column drive_doc_url text;

comment on column teachers.google_access_token_encrypted is
  'M7.3 — AES-256-GCM envelope of Google OAuth access_token. base64(iv '
  '|| authTag || ciphertext). Key: TEACHER_GTOKEN_ENC_KEY. Encrypted-'
  'only (no legacy plaintext columns; AID never stored these before).';
comment on column teachers.google_refresh_token_encrypted is
  'M7.3 — AES-256-GCM envelope of Google OAuth refresh_token. Same '
  'shape as google_access_token_encrypted. Only returned on first '
  'consent (prompt=consent + access_type=offline at /auth/login).';
comment on column teachers.drive_folder_id is
  'M7.3 — Google Drive folder id for this teacher''s "AI Documenter" '
  'folder. Auto-created on first save; self-healed on 404. Null on '
  'first use.';
comment on column teachers.canvas_comment_enabled is
  'M7.3 — master switch for AID''s Canvas-comment writes. Default '
  'true. AID''s per-assignment override lives on teacher_assignments.'
  'post_to_canvas_comment (M6.18 destination picker); this teacher-'
  'level switch lets an admin turn the whole behavior off globally.';
comment on column reflection_sessions.drive_doc_url is
  'M7.3 — Drive webViewLink for the auto-created Doc containing the '
  'summary + Socratic Q/A + full pasted transcript. Set after the '
  'save-to-drive step succeeds; presence is the idempotency sentinel.';
