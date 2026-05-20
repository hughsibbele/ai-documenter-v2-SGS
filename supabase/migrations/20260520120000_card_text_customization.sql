-- M6.15b: per-teacher Canvas reflection-card text customization.
--
-- Admin sets system defaults for the 5 strings inside the branded card
-- (kicker / title / body / cta label / footnote). Teachers override any
-- subset on their own row; effective value at install time = teacher
-- override ?? card_text_defaults ?? DEFAULT_REFLECTION_CARD_TEXT in the
-- @ai-documenter/canvas package. Per-assignment variation is NOT
-- supported — the card text is a global per-teacher knob.
--
-- Ports OE's 20260518040000_card_text_customization shape verbatim, with
-- AID-specific seeded defaults reflecting the reflection flow.

-- Singleton table for admin defaults. Mirrors OE's safety_envelope
-- singleton pattern (id=1, CHECK pinned).
create table public.card_text_defaults (
  id smallint primary key check (id = 1),
  kicker text not null default 'AI Use Reflection · Required for credit',
  title text not null default 'Reflect on your AI use for this assignment',
  body text not null default 'Before this assignment is complete, you''ll have a brief Socratic conversation about how you used AI tools while working — Gemini, ChatGPT, Claude, or others. It takes 5–10 minutes, and your reflection submits to Canvas automatically when you finish.',
  cta_label text not null default 'Open reflection →',
  footnote text not null default 'Sign in with your @episcopalhighschool.org Google account.',
  updated_at timestamptz not null default now()
);

insert into public.card_text_defaults (id) values (1);

create trigger card_text_defaults_set_updated_at before update on public.card_text_defaults
  for each row execute function set_updated_at();

alter table public.card_text_defaults enable row level security;

grant select, insert, update, delete on public.card_text_defaults to authenticated;
grant select, insert, update, delete on public.card_text_defaults to service_role;
-- intentionally no grant to anon — AI Documenter is admin-private.

-- Any signed-in user can read the defaults (the install path needs them to
-- compose the effective card text). Admin-only write.
create policy card_text_defaults_read on public.card_text_defaults
  for select to authenticated using (true);

create policy card_text_defaults_admin_write on public.card_text_defaults
  for all to authenticated using (is_admin()) with check (is_admin());

-- Per-teacher overrides. Each column is nullable; null = inherit from
-- card_text_defaults. The install path reads both and resolves at PUT time,
-- so changing a default propagates to next install for every teacher who
-- hasn't overridden the field.
alter table public.teachers
  add column card_kicker text,
  add column card_title text,
  add column card_body text,
  add column card_cta_label text,
  add column card_footnote text;

comment on column public.teachers.card_kicker is
  'M6.15b: optional teacher override for the card''s top "AI USE REFLECTION · REQUIRED FOR CREDIT" kicker.';
comment on column public.teachers.card_title is
  'M6.15b: optional teacher override for the card''s h3 title.';
comment on column public.teachers.card_body is
  'M6.15b: optional teacher override for the card''s body paragraph.';
comment on column public.teachers.card_cta_label is
  'M6.15b: optional teacher override for the CTA button label.';
comment on column public.teachers.card_footnote is
  'M6.15b: optional teacher override for the card''s italic footnote.';
