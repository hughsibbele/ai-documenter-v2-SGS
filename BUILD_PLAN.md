# AI Documenter v2 — Build Plan

Companion to `CLAUDE.md` (which holds scope and decisions). This doc is the build order.

## Status snapshot — 2026-05-11

| Phase | Description | Status |
|---|---|---|
| **1** | Foundations (monorepo, packages, Supabase, Vercel, auth) | ✅ done |
| **2** | Teacher admin MVP (Canvas connect, install action) | ✅ done |
| **2.2** | Install ergonomics (cache, sync, accordion, bulk install) | ✅ done |
| **Admin layer** | Admin shell, system prompts, admin management | ✅ done |
| **3.1** | Intake (chat URLs + time + first-draft paragraph) | ✅ done |
| **3.2** | Socratic conversation — redesigned 2026-05-11 (summary + alignment Q + hardcoded Q + closing) | ✅ done |
| **3.3** | Closing pipeline (objective summary, Canvas auto-submit, super-grader webhook) | ✅ done |
| **M1** | Merge `student-form` into `teacher-admin`; cookie auth; standalone `/r/<token>` | ✅ done |
| **M2** | Canvas install: iframe → branded EHS reflection card | ✅ done |
| **M3** | Brand layer + UX redesign (Lora/Georgia, maroon palette, chatbot UI) | ✅ done |
| **SG** | super-grader-facing GET endpoints (`/prompts/objective_summary`, `/result`) | ✅ shipped 2026-05-12 (bearer `AI_DOCUMENTER_API_TOKEN`) |
| **4** | Teacher review surface | ✅ shipped 2026-05-12 (index + per-assignment scroll, j/k nav, filters, resend) |
| ~~**5**~~ | ~~Oral mode (Gemini Live)~~ | ❌ cut 2026-05-12 — written-only is enough |
| **6** | Hardening (retention sweep, Sentry, rate limits, roster sync) | ✅ shipped 2026-05-12 — minus the teacher onboarding 1-pager |
| **7** | Adoption-driven extras | ⏸ not started |

**What works end-to-end today:**
- Sign in via Google SSO (EHS Workspace domain enforced); unified `/auth/callback` routes by `next` prefix (student vs teacher)
- Connect Canvas: paste API token → encrypt at rest (AES-256-GCM) → live token verify against `/users/self`
- First-load Canvas sync into `canvas_course_cache` + `canvas_assignment_cache` (active-term filter); manual Refresh button + nightly Vercel cron
- Dashboard accordion: active-term courses up top, older courses tucked into "Other courses" expander; open-state persists in `sessionStorage` so revalidate-driven remounts don't collapse it
- Per-assignment install / uninstall: idempotent Canvas description patch emits the **branded EHS reflection card** (logo + maroon CTA, marker `v=2`). Three detection paths in `packages/canvas/install.ts`: marker comments → bare-card-by-token (anchor-href + div-depth walk) → legacy bare-iframe-by-token (cleans up pre-M2 installs). Reinstall converges on exactly one block.
- Per-teacher prompt library + admin-edited shared system prompts. Each prompt carries `student_facing_question` (shown to student) and `body` (Gemini system prompt). Install picker pulls system + teacher; reflection-only purpose filter prevents the objective-summary prompt from being installable.
- Admin layer: `/admin` shell, `/admin/prompts` (CRUD with delete-uninstalls-cross-teacher; both fields editable), `/admin/admins` (grant/revoke with last-admin lockout)
- **Student standalone surface at `/r/<token>` (post-M1, standalone web app, no iframe):** cookie-based Google SSO via `/auth/login?next=/r/<token>`. Intake = chat URL list + paste-fallback + time-spent + paragraph **first draft** (locked on submit, ≥50 chars). Persists to `reflection_sessions` including the new `first_draft` column.
- **Redesigned conversation flow (chatbot UI):** bootstrap fires two Gemini calls — objective summary (using `objective_summary` prompt) + alignment question (using reflection prompt). Both land as AI bubbles. Student answers; orchestrator hardcodes the next AI message ("What have you learned about working with AI from this assignment? What, if anything, will you do differently next time?"). Student answers; Gemini generates a warm closing summary. State → `completed`. Three Gemini calls total, two student turns. All `maxOutputTokens: 4096` to survive Gemini 3 Flash thinking-token consumption.
- **Closing pipeline (3.3):** `finalizeReflection` action orchestrates Canvas auto-submit (with sentinel marker `<!-- ai-documenter:reflection v=1 iframe-token=... -->`, `as_user_id` masquerade, `canvas_user_id` backfill via roster lookup + `anon_token` re-key) + fire-and-forget super-grader webhook (envelope per integration-contract §4). Canvas submission body: first draft + objective summary + Socratic conversation + AI chat links. Done-state UI shows "Submitted to Canvas" or surfaces the 6-char `completion_code` fallback.
- 17 Supabase migrations applied; RLS on every table; type generation pinned to live project. Schema additions across M3 + 3.3 + F + 2026-05-13 comment-first refactor: `prompts.student_facing_question`, `reflection_sessions.first_draft`, `reflection_sessions.objective_summary`, `teacher_assignments.use_submission_body`.
- 6 workspace packages, **83 tests passing** (canvas 32, anonymizer 30, crypto 10, prompts 11). Gemini + student-side actions still not test-covered.

**What's deployed:**
- `https://ai-documenter-v2-teacher-admin.vercel.app` — single merged Vercel project (renamed `ai-documenter-v2`, default URL kept since the new subdomain didn't auto-issue). Serves all surfaces: `/` (sign-in landing), `/dashboard/*`, `/admin/*`, `/r/<token>` (student).
- Vercel deploys remain manual; `vercel deploy --prod` from `v2/` after `vercel link --project ai-documenter-v2 --yes`. Dual-deploy gripe is gone — single project now.
- Legacy projects flagged for dashboard deletion: `ai-documenter-v2-student-form`, `student-form` (the latter an earlier orphan).

**Pending env vars** — set on `ai-documenter-v2` (Production + Preview):
- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
- `CANVAS_TOKEN_ENC_KEY`, `SUPER_GRADER_SALT`
- `INITIAL_ADMIN_EMAIL`, `ADMIN_EMAIL_DOMAIN`, `CRON_SECRET`
- `NEXT_PUBLIC_STUDENT_FORM_URL` — currently `https://ai-documenter-v2-teacher-admin.vercel.app` (the original URL still serves the renamed project; `ai-documenter-v2.vercel.app` is claimed elsewhere on Vercel)
- `GEMINI_API_KEY` (Sensitive — Production + Preview only; Development reads from shell `~/.zshrc` export locally)
- `SUPER_GRADER_API_URL=https://super-grader.vercel.app`
- `SUPER_GRADER_INGEST_TOKEN` (Sensitive — same value as super-grader's `AI_DOCUMENTER_INGEST_TOKEN`)
- `AI_DOCUMENTER_API_TOKEN` (Sensitive — bearer presented by super-grader on `/api/super-grader/*` GETs; same value set on the super-grader side under whatever name super-grader uses for AI Documenter's outbound peer auth)
- `GEMINI_MODEL` (optional override; defaults to `gemini-3-flash-preview`)
- `GEMINI_DEFAULT_DAILY_CAP` (optional; integer cap on Gemini calls per teacher per day; falls back to 500 if unset)
- `SENTRY_DSN` + `NEXT_PUBLIC_SENTRY_DSN` (optional; activate Sentry error telemetry. Missing = no-op, no events shipped)

## MVP definition

The smallest deployable thing: **one teacher, one Canvas course, one assignment, written-mode reflection only, with PII anonymization in place from day one**.

If a real EHS teacher can install it on a real assignment and a real student can complete a reflection that auto-submits to Canvas with the three artifacts (reflection transcript + AI transcript link + objective summary), MVP is done. In-app review surface and teacher analytics come after.

## Architecture summary

- **Frontend:** single merged Next.js 16 app on Vercel (`apps/teacher-admin`, project name `ai-documenter-v2`). Three route groups: `(student)/r/[token]` (standalone reflection), `(dashboard)/*` for teachers, `(admin)/*` for admins. The historical two-app split (`student-form` + `teacher-admin`) was retired 2026-05-11.
- **Backend:** Next.js API routes / server actions. No separate service.
- **Data:** Supabase (Postgres + Auth + Storage + RLS). Service-role admin client for cross-teacher writes (sync, install, admin operations); cookie-context client for ownership-scoped reads/writes.
- **AI:** Gemini text API for the conversation flow (objective summary + alignment question + closing — three calls per reflection). Centralized EHS-paid API key, server-side only.
- **Auth:** Google SSO restricted to EHS Workspace domain. Unified `/auth/callback` routes by `next` prefix — `/r/...` → upsert student; else → upsert teacher. Cookie-based throughout (no iframe contortions).
- **Canvas integration:** Teacher's stored Canvas API token PUTs a branded reflection card into the assignment description (install) and POSTs the student's reflection as a submission via `as_user_id` masquerade (auto-submit). 6-char completion code as fallback. Active-term sync.

## Repo layout

```
/v2/
  /apps/
    teacher-admin/        # merged Next.js 16 app — student + teacher + admin
                          # (directory name historical; renaming flagged but deferred)
  /packages/
    db/                   # Supabase schema, migrations, generated types
    canvas/               # Canvas API client + reflection-card install marker
                          # + submitTextEntryAsStudent + lookupCourseStudentByEmail
    crypto/               # AES-256-GCM at-rest secret encryption
    anonymizer/           # Student_xxxxxx tokens + name-redaction scrubbers
    prompts/              # super-grader prompt-registry fetcher (legacy)
    gemini/               # Gemini v1beta REST chat wrapper (URL-context, thinking config)
  /supabase/              # local supabase project (migrations, seed)
```

`packages/transcript-ingest/` is still planned (per-provider share-link scrapers, see Open follow-ups). Paste-fallback covers the reliable path; Gemini's URL-context tool runs as best-effort.

Monorepo via pnpm workspaces. Shared types live in `packages/db`.

## Data model (current)

```
teachers
  id (uuid, pk)
  auth_user_id (uuid, unique fk auth.users)
  google_sub (text, unique)        -- from SSO
  email (text)                     -- @episcopalhighschool.org
  display_name (text)
  canvas_token_encrypted (text)    -- base64 AES-256-GCM blob
  canvas_host (text)               -- episcopalhighschool.instructure.com
  last_canvas_sync_at (timestamptz)
  created_at, updated_at

admins                              -- email-keyed; HAH-style admin layer
  email (text, pk, lowercased)
  granted_by_email (text)
  granted_at (timestamptz)
  active (bool)

prompts                             -- system + teacher; reflection + objective_summary
  id (uuid, pk)
  teacher_id (uuid, fk teachers, NULL for scope='system')
  scope (text: 'system' | 'teacher')
  purpose (text: 'reflection' | 'objective_summary')
  label (text)                     -- unique per (scope, label) for system; (teacher_id, label) for teacher
  body (text)
  is_default (bool)                -- one per scope; the seeded ones
  created_at, updated_at

teacher_assignments                 -- one per (teacher, canvas_assignment) pair, stable iframe_token
  id (uuid, pk)
  teacher_id (fk teachers.id)
  canvas_course_id (text)
  canvas_assignment_id (text)
  prompt_id (fk prompts.id)        -- which prompt drives this assignment's reflection
  allowed_tools (text[])           -- default ['gemini','chatgpt','claude']
  written_mode_enabled (bool)      -- vestigial; only mode left after oral cut 2026-05-12
  use_submission_body (bool)       -- default false. true = legacy body POST path
                                   --   (HTML, sentinel marker, comment-fallback on 400/422).
                                   --   false = comment-only path (plain text, no body POST).
                                   --   Set per-assignment at install time. New default 2026-05-13.
  iframe_token (text, unique)      -- random; in iframe URL instead of raw IDs
  created_at, updated_at, archived_at

assignment_install_state            -- lifecycle (installed/uninstalled/failed) per assignment
  id (uuid, pk)
  teacher_id (fk teachers.id)
  canvas_course_id (text)
  canvas_assignment_id (text)
  status (enum: installed/uninstalled/failed)
  iframe_token (text)
  installed_at, uninstalled_at (timestamptz)
  last_error (text)
  created_at, updated_at

course_install_policies             -- per-course defaults + auto-install toggle
  id (uuid, pk)
  teacher_id (fk teachers.id)
  canvas_course_id (text)
  auto_install_new_assignments (bool)
  default_prompt_id (fk prompts.id)
  default_allowed_tools (text[])
  prompt_version (int)
  created_at, updated_at

canvas_course_cache                 -- per-teacher Canvas course cache (sync target)
  teacher_id, canvas_course_id (composite pk)
  name, course_code, workflow_state
  start_at, end_at
  term_name, term_start_at, term_end_at
  last_synced_at

canvas_assignment_cache             -- per-teacher Canvas assignment cache (active-term only)
  teacher_id, canvas_assignment_id (composite pk)
  canvas_course_id
  name, description, due_at, points_possible
  workflow_state, published
  last_synced_at

reflection_sessions                 -- one per student per assignment per attempt
  id (uuid, pk)
  teacher_assignment_id (fk)
  student_id (fk students.id)
  state (enum: started, in_progress, completed, submitted, failed)
  ai_chats (jsonb)                 -- [{tool, url, transcript_text}]
  paste_fallback_text (text)
  time_spent_estimate (text)       -- 'lt15' | '15_30' | '30_45' | '45_60' | '1_2h' | 'gt2h'
  ai_tools_used (text[])           -- denormalized
  reflection_messages (jsonb)      -- the Socratic Q/A turns
  -- objective_summary (text)      -- to be added in Phase 3
  canvas_submission_id (text)
  completion_code (text)
  created_at, completed_at, submitted_at, expires_at

students
  id (uuid, pk)
  auth_user_id (uuid, fk auth.users)
  google_sub, email, display_name
  canvas_user_id (text)
  anon_token (text, unique)        -- "Student_xxxxxx", stable per student
  created_at

submission_attempts
  id, reflection_session_id, attempted_at, success, error
```

**Helper functions** (all SECURITY DEFINER, EXECUTE granted to `authenticated`):
- `is_teacher_owner(t_id uuid)` — used by RLS on every teacher-owned table
- `is_student_self(s_id uuid)` — used by RLS on student tables
- `is_admin()` — checks `lower(auth.jwt()->>'email')` against `admins.active`

**RLS posture:**
- Every public table has RLS enabled.
- Teacher-owned tables: `is_teacher_owner(teacher_id)` for select/modify.
- Cache tables: select-only via `is_teacher_owner`; writes go through service-role admin client (sync, cron).
- Prompts: scope-aware. System rows readable by all, modifiable by admins. Teacher rows readable+modifiable by owner.
- Admins table: `is_admin()` for both select and modify; bootstrap insert goes through service-role.

**Migration template (new tables):**

Supabase is dropping the default `public`-schema auto-grant for new tables — enforced on existing projects 2026-10-30 (per their 2026-05-13 announcement). Existing tables keep their grants; nothing breaks today. But every `CREATE TABLE` in `public` from here on should pair the CREATE with explicit grants + RLS + policies in the same migration:

```sql
CREATE TABLE public.your_table ( ... );

ALTER TABLE public.your_table ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.your_table TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.your_table TO service_role;
-- intentionally NO grant to anon — AI Documenter is admin-private; anon
--   has no business reading or writing anything in this schema.

CREATE POLICY "..." ON public.your_table FOR ... TO authenticated USING (...);
```

Helper functions follow the same rule: `GRANT EXECUTE ... TO authenticated, service_role`, never `anon`. The `20260512140000_revoke_anon_from_rate_limit_rpc.sql` migration is the precedent — Supabase auto-grants EXECUTE to `{anon, authenticated, postgres, service_role}` on every new public function, and `REVOKE ... FROM PUBLIC` doesn't clear role-specific grants. So new functions need explicit `REVOKE EXECUTE ... FROM anon` or be created with `SECURITY DEFINER` + targeted grants.

## PII anonymization design

**Non-negotiable rule:** real student PII never enters a Gemini API call. Not in messages, not in system prompts, not in transcripts, not in metadata.

**Mechanism** (synthesized from Canvas-Agent + Students of Concern Dashboard):

- **Token format:** `Student_xxxxxx` where `xxxxxx` is the first 6 chars of `HMAC-SHA256(salt, "ehs\0" + student_id)`. Salt lives in `SUPER_GRADER_SALT` (shared across the EHS AI ecosystem so cross-tool joins work).
- **Stability:** EHS-wide and durable. Same student → same token across all courses, all assignments, all years.
- **Storage:** `students.anon_token` column. Generated once on first SSO login, stored, never recomputed.
- **Outbound (anonymize):** Before any Gemini call (reflection turns AND objective-summary generation), run the payload through `packages/anonymizer/scrub()`:
  1. Structured fields: replace `student.display_name`, email, etc. with the token.
  2. Free text: regex-redact known names of the *current* student (and any other students appearing in the EHS roster — variant handling for first-only, last-only, possessives) using the Dashboard's compiled-pattern approach. Cache the compiled pattern per process; invalidate on roster change.
  3. Teacher names pass through (they're the principal, not the protected subject).
- **Inbound (de-anonymize) for teacher view:** Gemini's responses come back tokenized. The teacher-admin app server-side renders `Student_xxxxxx` → real name on the way to the browser. Tokens never round-trip through Gemini for de-anon.
- **Storage of conversations:** store the **anonymized** form in `reflection_messages` and `objective_summary`. De-anonymize at render time.
- **Canvas submission body:** de-anonymized — Canvas is on EHS's side of the privacy boundary, and the teacher needs real names in the gradebook view.

**Roster source:** still an open follow-up. Canvas API roster pull on a schedule is the leading candidate.

## Phased build

### Phase 1 — Foundations ✅

All complete:
- pnpm workspace, Next.js 16 scaffolds for both apps.
- Supabase project (`ai-documenter-v2`, us-east-1). 8 migrations applied: initial schema; secure helpers; reflection-session intake reshape; canvas cache; restore is_teacher_owner grant (corrected the over-cautious revoke that silently broke RLS); course policy prompt_version; prompts library; admins + system prompts + roll-up; prompt purpose + objective summary seed.
- Vercel projects deployed. All env vars present (`SUPER_GRADER_SALT`, `CANVAS_TOKEN_ENC_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, public Supabase keys).
- Google SSO with `hd=episcopalhighschool.org` domain restriction; callback enforces domain match server-side.
- `packages/anonymizer` (30 tests). Output is byte-identical to super-grader's per integration contract §2.
- `packages/crypto` (10 tests). AES-256-GCM via Node `crypto`.
- `packages/canvas` — REST client + idempotent install marker-block logic (23 tests).
- `packages/prompts` — fetches from super-grader's prompt registry (11 tests).
- `packages/db` — typed Supabase client factories.

### Phase 2 — Teacher admin MVP ✅

All complete:
1. ✅ First-run wizard at `/dashboard/setup`: paste Canvas token → verify via `/users/self` → encrypt and store on `teachers.canvas_token_encrypted`.
2. ✅ Course/assignment data: live, sourced from `canvas_course_cache` + `canvas_assignment_cache` (sync'd from Canvas API).
3. ✅ Prompt management at `/dashboard/prompts`: per-teacher personal prompts library + read-only system prompt section. Admins edit system prompts at `/admin/prompts`.
4. ✅ Allowed-tools — schema field `teacher_assignments.allowed_tools` exists; UI not yet exposed (Phase 3 will surface it on the install picker).
5. ✅ Install on Canvas via API. Server action at `installOnAssignments(courseId, assignmentIds[], promptId)`:
   - Loads or creates `teacher_assignments` row (stable `iframe_token`)
   - GETs current Canvas description, splices in the marker block via `replaceOrAppendIframeBlock`
   - PUTs the updated description (no-op if marker is already correct, so re-installs with a new prompt are DB-only)
   - Upserts `assignment_install_state`
   - Sequential rather than parallel: Canvas dislikes burst writes from a single token

### Phase 2.2 — Install ergonomics & sync ✅

All complete as of 2026-05-12 — the previously-pending auto-install policy persistence + nightly sweep both shipped today.

1. ✅ Searchable, multi-select assignment list per course (in the dashboard accordion).
2. ✅ Bulk install / uninstall via the bulk-action bar.
3. ✅ Auto-install policy per course — `AutoInstallToggle` calls `setCourseAutoInstall(courseId, enabled)`, which upserts `course_install_policies.auto_install_new_assignments`. First-time enable seeds the policy with the system Default reflection prompt; subsequent flips just update the boolean. Optimistic UI flip with rollback on server error.
4. ✅ Reconciliation cron — `/api/cron/sync-all-teachers` (nightly via `vercel.json`) refreshes the cache AND, for each teacher with policy-enabled courses, sweeps for newly-encountered published assignments and installs the reflection card on each. Skips anything the teacher has explicitly uninstalled (status='uninstalled' rows stay sticky — auto-install never brings back a removed assignment).
5. 🟡 Manage installations view — covered by the dashboard accordion with Install/Uninstall buttons; no dedicated "manage" page yet.
6. ✅ Idempotency marker design — implemented in `packages/canvas/install.ts`:

   ```html
   <!-- ehs-ai-reflect:begin v=1 iframe-token=... prompt-version=N -->
   <iframe src="..." width="100%" height="720" ...></iframe>
   <!-- ehs-ai-reflect:end -->
   ```

   `prompt-version=N` is now mostly informational since the student-form reads the prompt body live; kept for backward-compat audit. The "stale" badge concept is also obsolete — edits to a prompt propagate instantly without needing reinstall.

### Admin layer ✅

Modeled on Handwritten-Assignment-Helper's pattern. Built 2026-05-07.

1. ✅ `admins` table + `is_admin()` SECURITY DEFINER helper (with EXECUTE granted to `authenticated`).
2. ✅ `getCurrentAdminEmail()` DAL — service-role lookup, self-bootstrap from `INITIAL_ADMIN_EMAIL` if table empty.
3. ✅ `/admin` shell with redirect-to-/dashboard for non-admins; teal "Admin →" badge in `/dashboard` header for admins only.
4. ✅ `/admin/prompts` — two sections: Reflection prompts (CRUD) and Objective summary prompt (single editable card; can't be deleted). Cross-teacher uninstall on delete (any installed assignment using the prompt is uninstalled from Canvas before the prompt row goes).
5. ✅ `/admin/admins` — grant new admin (with optional `ADMIN_EMAIL_DOMAIN` allowlist), revoke (with last-admin-lockout protection).

### Phase 3 — Student reflection flow ✅ shipped (all slices)

Standalone surface at `https://<host>/r/<token>` (post-M1 merge — no longer an iframe). The flow has been redesigned end-to-end on 2026-05-11; see CLAUDE.md Refinements for the architectural shift.

**3.1 — Entry + SSO + intake ✅**

1. ✅ Page entry: `app/(student)/r/[token]/page.tsx` reads `token` from the dynamic segment → `resolveIframeToken` admin-client lookup returns `{teacher_assignment, prompt, courseName, assignmentName}` (or null → BrokenLink view).
2. ✅ Cookie-based SSO via `/auth/login?next=/r/<token>` → unified `/auth/callback` (detects `next.startsWith('/r/')` to route as student vs teacher). Standard `@supabase/ssr` cookie session — no popup, no postMessage, no localStorage tokens.
3. ✅ Multi-chat intake: `(tool, url)` list with allow-list URL validation per provider; paste-fallback prominent + always-visible.
4. ✅ Time-spent picker → `reflection_sessions.time_spent_estimate`.
5. ✅ **First-draft paragraph (M3 add):** student writes a ≥50-char reflection on intake; persists to `reflection_sessions.first_draft`; locked once submitted.

**3.2 — Socratic conversation ✅ (redesigned 2026-05-11)**

State machine in `nextSocraticTurn` (lengths in `reflection_messages`):

0 → bootstrap: two Gemini calls back-to-back; emit `[summary, alignment_question]` as two AI messages → length=2.
2 → student answers → append student turn + hardcoded final Q ("What have you learned... will you do differently next time?") → length=4.
4 → student answers → append student turn + Gemini-generated closing → length=6, state='completed'.
6 → conversationDone.

- ✅ Three Gemini calls per conversation: summary (uses `purpose='objective_summary'` prompt), alignment Q (reflection prompt body + alignment guard rail), closing (reflection prompt body + closing guard rail). Two student answers total.
- ✅ All Gemini calls pass `maxOutputTokens: 4096` to leave headroom for Gemini 3 Flash thinking tokens.
- ✅ Chatbot UI: real chat bubbles (left=AI, right=student). First draft renders as the opening student bubble. "Reflection Partner" label on the first AI bubble; subsequent bubbles rely on alignment. Composer is rows=6 (paragraph-shaped); thinking dots; auto-scroll-to-latest.
- ✅ Structured-field anonymizer at the boundary (display name → `Student_xxxxxx`); free-text scrubbing of AI transcripts is deferred (needs roster source).

**3.3 — Closing pipeline ✅ (shipped 2026-05-11; comment-first refactor 2026-05-13)**

On `state='completed'`, the client calls `finalizeReflection({iframeToken})`:

- `lib/finalize/objective-summary.ts` is reused for the bootstrap-time summary generation (so finalize doesn't regenerate; idempotent fast path on resubmit).
- `lib/finalize/canvas-submit.ts`: decrypt teacher's Canvas token → backfill `students.canvas_user_id` via roster lookup (`lookupCourseStudentByEmail` in `packages/canvas/submissions.ts` — matches against `primary_email`, `email`, `login_id`-as-full-email, AND `login_id`-as-local-part-of-email so EHS-style logins like `jsmith42` for `jsmith42@episcopalhighschool.org` resolve cleanly) → re-key `anon_token` to canonical `(canvas_user_id, email)` form → branch on `teacher_assignment.use_submission_body`:
  - **false (default, comment-first 2026-05-13):** build plain-text body (ALL-CAPS headings, link block at top, Q1/Q2 turns) → `PUT submissions/:user_id` with `comment[text_comment]=<plain text>` via `as_user_id` masquerade. No body POST attempted; on comment failure, surface the 6-char completion code. Works on every Canvas assignment type (file upload, online_text_entry, on_paper, discussion, quiz) via `find_or_create_submission`. Comment doesn't carry a sentinel marker (super-grader only scrapes bodies). Side effect: the shell submission stays `workflow_state="unsubmitted"`, so the gradebook column shows "Not Submitted" — accepted tradeoff, tracked above in CLAUDE.md.
  - **true (opt-in legacy body path):** build HTML body (sentinel marker + link block at top + first draft + objective summary + Socratic conversation + paste fallback) → POST via `submitTextEntryAsStudent` with `as_user_id`. On 400/422 (assignment doesn't allow `online_text_entry`), fall back to the same comment PUT described above. Reserved for AI-literacy assignments where the reflection IS the deliverable.
  - **Both paths:** persist `canvas_submission_id` + `state='submitted'` + log to `submission_attempts`.
- `lib/finalize/super-grader.ts`: fire-and-forget POST to `${SUPER_GRADER_API_URL}/api/ingest/ai_documenter` with bearer `SUPER_GRADER_INGEST_TOKEN`. Envelope shape matches super-grader's integration-contract §4: `{schema_version: 1, peer, canvas_user_id, canvas_assignment_id, anon_token, completed_at, summary: {...}, links: {detail_url}}`. Gracefully skips if env vars are absent.
- `FinalizeStatus` UI: "Finalizing…" with thinking dots → "Submitted to Canvas" (success) OR "Canvas didn't accept the auto-submit" with the 6-char completion code in monospace (fallback path; teacher gets visibility via `submission_attempts.success=false`).

**Done.** Real students can complete a reflection end-to-end. Canvas auto-submit + super-grader webhook both wired and tested.

### Phase 4 — Teacher review surface ✅ shipped 2026-05-12

**Design locked 2026-05-07; shipped 2026-05-12.**

- **Where it lives**: `/dashboard/reviews/[courseId]/[assignmentId]` — one page per assignment, all students in a single scroll. Two entry points:
  1. ✅ Dashboard accordion's `AssignmentRow` grows a "View N reflections →" link on each installed row that has at least one session (count batched via `loadReflectionCountsByAssignment`).
  2. ✅ Top-level **Reviews** nav link in `dashboard/layout.tsx` → `/dashboard/reviews` index. The index groups assignments by course and shows total / submitted / failed / in-progress counts per assignment. Empty assignments are hidden from the index until at least one student touches them.
- **Per-student card** (rendered top to bottom for the whole class — see `StudentCard.tsx`):
  - ✅ Header: real name (de-anonymized — student rows store the real `display_name`/`email` server-side, so no separate reverse-mapping step is needed), state badge, time-spent band, AI tool(s) used (derived from `ai_chats`).
  - ✅ **First draft** (always visible).
  - ✅ **Objective summary** (always visible, ~100 words).
  - ✅ **Reflection conversation** (always visible, full Q/A bubbles styled by role).
  - ✅ `▸ AI transcript` `<details>` collapsed by default; expands inline to show share links + pasted transcript. No modal, no new page.
  - ✅ "Open in Canvas ↗" link to the submission (uses `canvas_user_id` + teacher's `canvas_host`).
  - ✅ "Resend to Canvas" button when the most recent `submission_attempts.success = false`. Wired to `resendToCanvas(reflectionSessionId)` server action which reuses `submitReflectionToCanvas`.
- **Page-level navigation** (in `ReviewClient.tsx`):
  - ✅ Sticky `N of M · jump to ▼` student picker. Renders all visible (post-filter) students.
  - ✅ `j` / `k` keyboard shortcuts step through cards; suppressed while typing in inputs/textareas so search isn't hijacked. Smooth-scrolls the next card into view.
  - ✅ Filter pills: All / Submitted / Failed / In progress (each shows a live count); plus a name/email search box.
- **"Not started" footer:** ⏸ deferred — needs a Canvas roster sweep + the planned roster-source decision. Tracked under Phase 6 follow-ups.

**Done when:** a teacher can read every reflection for their assignment, with summary + conversation visible in a single scroll, without leaving our app. ✅ — minus the roster-driven "not started" footer.

### ~~Phase 5 — Oral mode~~ ❌ cut 2026-05-12

Decision: oral reflection is out of scope. Written-mode covers the goal, and the Gemini Live audio path adds complexity (WebSocket relay, mic/audio handling, STT review UX, audio retention) without a clear win over a paragraph the student types. Migration `20260512100000_drop_oral_mode.sql` drops the now-unused columns and enum.

### Phase 6 — Hardening (shipped 2026-05-12)

1. ✅ **Retention sweep with CSV export** — teachers can export then hard-delete their own reflection data via `/dashboard/retention`; admins can do the same school-wide via `/admin/retention`. No automatic age-based delete — explicit "type DELETE to confirm" gate. CSV columns include first draft, objective summary, full Socratic Q&A, AI chat URLs, and paste-fallback. UTF-8 + BOM for Excel.
2. ❌ ~~Cost monitoring~~ — handled externally via AI Studio per the centralized Gemini key. Don't reinvent.
3. ✅ **Per-teacher rate limits** — `gemini_usage_daily(teacher_id, date, calls, denials)` keyed table; atomic check + increment via the SECURITY DEFINER `check_and_increment_gemini_call(teacher_id, default_cap)` Postgres function. Per-teacher override on `teachers.gemini_daily_cap`; env default via `GEMINI_DEFAULT_DAILY_CAP` (falls back to 500). Plugged into both the Socratic coach turns and the objective-summary call. Rate-limit denial fails open on DB hiccup so a transient DB issue doesn't break the student flow.
4. ✅ **Error telemetry** — `@sentry/nextjs` wired via `instrumentation.ts` (server + edge) and `instrumentation-client.ts` (browser). Activates when `SENTRY_DSN` / `NEXT_PUBLIC_SENTRY_DSN` is set; no-op otherwise. `onRequestError` funnels server-action / route-handler errors into Sentry. Tracing off (`tracesSampleRate: 0`) until we have a baseline cost shape.
5. ⏸ Teacher-facing onboarding: a 1-pager + 3-minute video. (Out of code scope.)
6. ✅ **Canvas roster sync** — nightly cron pulls `/api/v1/courses/{id}/users?enrollment_type[]=student` and upserts a jsonb array into `course_rosters(teacher_id, canvas_course_id, students)`. `scrubSessionForGemini(session, canvasCourseId)` compiles the roster into a name-redaction regex (cached in-process for 5 min) and scrubs `first_draft`, `paste_fallback_text`, and `ai_chats[].transcript_text` before either Gemini boundary call. Empty roster / missing salt → no-op (defense-in-depth, not a hard gate).
7. ✅ Auto-install policy + nightly sweep (shipped 2026-05-12 earlier in the day).

### Phase 7 — Adoption-driven extras

Only build when teachers ask: prompt versioning, conversation export, lightweight analytics, multiple-prompts-per-course shortcuts, etc.

## Build order (revised)

```
1 → 2 → 2.2 → Admin → 3 → 4 → 6 → 7
```

1, 2, 2.2, the admin layer, Phase 3, Phase 4, Phase 6 (minus the teacher 1-pager), and the super-grader endpoints are all done as of 2026-05-12. Phase 5 was cut. Phase 7 is open-ended.

## Open follow-ups (don't block MVP)

- **"Not started" footer on review pages.** Roster source now exists (`course_rosters` jsonb cache); wire it into the per-assignment review page to surface students with no `reflection_sessions` row.
- **Teacher-facing onboarding.** 1-pager + 3-min video. Should explicitly cover the comment-only default's "Not Submitted" gradebook-column behavior so teachers don't think reflections silently failed.
- **Per-provider transcript scrapers.** URL context grounding via Gemini doesn't reliably reach Gemini share pages (hit-or-miss for ChatGPT/Claude). Paste-fallback is the reliable path today; longer-term, build server-side fetch + parse per provider's share-link HTML.
- **Anonymizer test corpus.** Fixture of fake students with tricky names (apostrophes, hyphens, single-name students, names shared with teachers).
- **Delete legacy Vercel projects.** `ai-documenter-v2-student-form` (post-merge orphan) and `student-form` (earlier orphan). Dashboard click; the MCP doesn't expose project deletion.
- **Custom domain.** `reflect.episcopalhighschool.org` (or similar). The default `.vercel.app` URL after the project rename stuck on `ai-documenter-v2-teacher-admin.vercel.app` because `ai-documenter-v2.vercel.app` is claimed elsewhere on Vercel.
- **Turnitin Plagiarism Framework + body-mode warning.** When a teacher opts into `use_submission_body=true` at install on an assignment with Turnitin's plagiarism review enabled, Turnitin will scan our reflection HTML as if it were student-authored work. Either: (a) probe `assignment.turnitin_enabled` at install time and surface a warning, or (b) accept the small-numerator risk and document it. Comment-only (the default) sidesteps this entirely.

### Resolved (no longer follow-ups)

- ~~Iframe SSO UX in Canvas~~ — iframe model retired 2026-05-11.
- ~~Canvas submission sentinel marker~~ — shipped in 3.3.
- ~~Conversation textarea sizing (rows=2 → paragraph-sized)~~ — shipped in M3 chatbot UI.
- ~~Dual-deploy ergonomics~~ — single project after M1 merge.
- ~~SG endpoints (objective_summary + result GETs)~~ — shipped 2026-05-12, bearer `AI_DOCUMENTER_API_TOKEN`.
- ~~Auto-install policy persistence + nightly sweep~~ — shipped 2026-05-12; cron now refreshes cache then installs on newly-encountered published assignments in policy-enabled courses, sticky on uninstalls.
- ~~Oral mode (Phase 5)~~ — cut 2026-05-12 as out of scope.
- ~~Cost monitoring~~ — handled externally via AI Studio.
- ~~Retention sweep / cron / soft vs hard delete~~ — shipped 2026-05-12 (CSV export + type-DELETE-to-confirm hard delete, per-course or school-wide).
- ~~Roster source for free-text PII regex~~ — shipped 2026-05-12 (nightly Canvas roster pull → `course_rosters` jsonb cache → in-process compiled regex with 5-min TTL).
- ~~Cost monitoring + per-teacher rate limits + error telemetry~~ — cost out of scope; rate limits + Sentry shipped 2026-05-12.
- ~~Submission body formatting + link-goes-first~~ — both resolved 2026-05-13. Default switched to comment-only with clean plain-text format (link block first). HTML body path remains as a per-assignment opt-in.
- ~~Super-grader marker filter contract drift~~ — shipped 2026-05-13. `classifySubmission` now actually filters marker-tagged AI Documenter bodies; integration-contract §12 reconciled with reality.
- ~~Split-submission test artifact (one body-only-link, one full reflection)~~ — diagnosed 2026-05-13 as student-authored Canvas paste preceding our auto-submit. Becomes moot under comment-only default.

## What's explicitly out of scope (for now)

- LTI (decided, recorded in CLAUDE.md).
- Non-EHS deployments.
- Teacher-side grading or rubrics inside this app — the teacher grades in Canvas as normal.
- Sharing reflections between teachers / department-level prompt libraries (other than the school-wide system prompts admins control).
- Mobile-native apps.
