-- Reshape reflection_sessions to support multiple chats / multiple tools per
-- submission and a time-spent estimate from the intake screen.
-- Safe to drop columns: no data exists yet (zero rows per advisor check).

alter table reflection_sessions
  drop column ai_transcript_url,
  drop column ai_transcript_text;

alter table reflection_sessions
  add column ai_chats jsonb not null default '[]'::jsonb,
  add column paste_fallback_text text,
  add column time_spent_estimate text;

alter table reflection_sessions
  add constraint reflection_sessions_time_spent_estimate_check
  check (
    time_spent_estimate is null
    or time_spent_estimate in (
      'lt15', '15_30', '30_45', '45_60', '1_2h', 'gt2h'
    )
  );

comment on column reflection_sessions.ai_chats is
  'Array of {tool, url, transcript_text}. transcript_text is null until extraction runs server-side.';
comment on column reflection_sessions.paste_fallback_text is
  'Populated when share-link extraction is not possible. Coexists with ai_chats — both can be non-empty.';
comment on column reflection_sessions.time_spent_estimate is
  'One of: lt15 | 15_30 | 30_45 | 45_60 | 1_2h | gt2h. Bands match the student-form picker.';
