# AI Documenter v2 — Testing Regimen

Last updated 2026-05-12 after Phase D + Phase F + the post-push static audit. Work top-to-bottom for a full audit; cherry-pick sections after targeted changes. Each step says **exactly what to do** and **exactly what to check** so failures are unambiguous.

## How to use this doc

- Run the merged Next.js app locally on `:3001`, or against a Vercel preview deploy. Both are valid; preview is closer to prod but slower to iterate.
- Each section nests checks. A `[ ]` checkbox = a single observable behavior. `[x]` = already verified (auto or manual). A failing checkbox means investigate, don't continue.
- Where a step writes data, prefer a fresh test course / assignment to avoid contaminating real student data. The retention surface (§7) lets you clean up after.
- `→` means "follow this path / click this thing." Quoted strings are literal.

## What's already pre-verified (no human needed)

The 2026-05-12 static audit (run from this repo, against the live Supabase + super-grader's planning + parser code) green-lit everything below. **You can skip these sections** unless you want to re-verify after a code change:

- §0 Pre-flight — tsc, lint, `next build`, all 83 package tests, migration count, schema column drops, `database.types.ts` parity
- §6.3 partial — flat `{ owner, key, body, version, updated_at }` shape matches super-grader's `fetchLivePrompt` parser
- §6.5 — anon-token byte-identical to integration-contract §2 reference impl (added a permanent `contract.test.ts` would be a follow-up; this run used a temp test)
- §8 partial — RLS enabled on every public table; policies on `gemini_usage_daily` / `course_rosters` / `reflection_sessions` / `submission_attempts` reference the right helpers; `check_and_increment_gemini_call` + 3 helpers all have `EXECUTE` granted to `authenticated` only (anon-revoke fix applied 2026-05-12, migration `20260512140000_revoke_anon_from_rate_limit_rpc.sql`)
- §9 partial — zero oral-mode references in live code; every `process.env.X` reference matches a documented env var; no dangling TODOs

## What's been verified live (2026-05-12 walkthrough)

Hugh ran prod against a sandbox course:

- §1 Smoke — all routes, signed-in + signed-out. Clean after the post-walkthrough fixes (landing-page redesigns, header overflow, collapsed prompt cards, review section reorder).
- §2.1 Canvas connect — token reused from a prior session; still working.
- §2.2 Initial sync — accordion populates, Refresh works.
- §2.3 Install / uninstall — single, reinstall (with new prompt), and uninstall all converge to exactly one card; bulk install verified.
- §3 partial — real student completed the reflection flow end-to-end. Surfaced two bugs (now fixed): (a) Canvas roster lookup by full email returned zero hits at EHS because `login_id` is the email's local part — now matches against local part in addition to other fields; (b) Canvas 400'd the regular `online_text_entry` POST because the assignment's `submission_types[]` didn't include text entry — now falls back to a `comment[text_comment]` PUT, which works regardless of submission types.

## What still needs you at a browser / Canvas / Gemini / super-grader peer

- §2.4 Auto-install policy + nightly cron sweep
- §3 Student end-to-end (intake → Socratic conversation → finalize)
- §4 Review surface UX (j/k, sticky picker, resend-to-Canvas)
- §5 Admin clicks (admin grant/revoke, prompt CRUD with cross-teacher uninstall)
- §6.1–6.4 Live webhook + GET against super-grader, sentinel marker filtering
- §7 Phase F runtime behavior — rate limit hit, Sentry events landing, CSV download, roster scrub in flight
- §10 Env-toggling failure modes

## 0. Pre-flight

Block testing if anything here fails — the rest is meaningless without a healthy baseline. Items marked `[x]` were pre-verified by the 2026-05-12 audit and need re-running only after a relevant code change.

- [ ] `pnpm install` clean (no peer-dep warnings that mention `@sentry/nextjs`, `@supabase/*`, or `next`).
- [x] `pnpm -r --filter='!@ai-documenter/gemini' test` passes. 83 tests across `anonymizer`, `canvas`, `crypto`, `prompts`. The gemini package legitimately has no tests yet.
- [x] `cd apps/teacher-admin && pnpm exec tsc --noEmit` exits 0 with no output.
- [x] `cd apps/teacher-admin && pnpm exec next build` succeeds. Route list includes all of:
  - `/dashboard`, `/dashboard/prompts`, `/dashboard/reviews`, `/dashboard/reviews/[courseId]/[assignmentId]`, `/dashboard/retention`, `/dashboard/setup`
  - `/admin`, `/admin/admins`, `/admin/prompts`, `/admin/retention`
  - `/api/cron/sync-all-teachers`, `/api/super-grader/prompts/objective_summary`, `/api/super-grader/result`
  - `/r/[token]`, `/auth/{login,callback,logout}`
- [ ] All env vars set on the Vercel project (`ai-documenter-v2`) — **human check via the Vercel dashboard, can't be inspected from this repo**:
  - **Supabase**: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
  - **Crypto + salt**: `CANVAS_TOKEN_ENC_KEY`, `SUPER_GRADER_SALT` (must equal super-grader's value exactly)
  - **Admin bootstrap**: `INITIAL_ADMIN_EMAIL`, `ADMIN_EMAIL_DOMAIN`
  - **Cron**: `CRON_SECRET`
  - **App URL**: `NEXT_PUBLIC_APP_URL` (must be set — without it the webhook skips and `/api/super-grader/result` returns 500). During M4.3 transition the legacy name `NEXT_PUBLIC_STUDENT_FORM_URL` is still accepted as a fallback; setting either works.
  - **Gemini**: `GEMINI_API_KEY`, optional `GEMINI_MODEL`, optional `GEMINI_DEFAULT_DAILY_CAP`
  - **Super-grader peer**: `SUPER_GRADER_API_URL`, `SUPER_GRADER_INGEST_TOKEN`, `AI_DOCUMENTER_API_TOKEN`
  - **Sentry (optional)**: `SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_DSN`
- [x] Supabase migrations applied (17 total; the six most recent are 2026-05-12 + 2026-05-13):
  - `20260512100000_drop_oral_mode.sql`
  - `20260512110000_gemini_rate_limits.sql`
  - `20260512120000_course_rosters.sql`
  - `20260512140000_revoke_anon_from_rate_limit_rpc.sql` (post-audit fix)
  - `20260512150000_auto_install_baseline.sql`
  - `20260513120000_use_submission_body.sql` — applied 2026-05-13 via Supabase MCP. All 26 pre-existing `teacher_assignments` rows back-filled with `use_submission_body=false` (the NOT NULL DEFAULT), so on next finalize they all take the new comment-only path.
  Verified via Supabase MCP `list_migrations`.
- [x] `packages/db/src/database.types.ts` includes: `teacher_assignments.use_submission_body` boolean column (added 2026-05-13). Manually updated in the commit; live schema confirmed via `list_tables` after migration apply. Re-running `generate_typescript_types` against the live project for a second confirmation pass is optional but harmless.

## 1. Smoke (every public surface loads)

For each route, open in an incognito window first to confirm auth gating; then sign in as your test teacher account and confirm content renders.

- [ ] `/` — sign-in landing. Signed-out: shows Google SSO. Signed-in: redirects to `/dashboard`.
- [ ] `/dashboard` — accordion of courses; teacher account.
- [ ] `/dashboard/prompts` — personal + system prompts.
- [ ] `/dashboard/reviews` — index of assignments-with-reflections, or "No reflections yet" empty state.
- [ ] `/dashboard/reviews/<courseId>/<assignmentId>` — for an installed assignment with at least one reflection.
- [ ] `/dashboard/retention` — scope picker, summary card, export + delete sections.
- [ ] `/dashboard/setup` — Canvas connect form.
- [ ] `/admin` — admins only. Non-admin teacher gets redirected to `/dashboard`.
- [ ] `/admin/prompts` — reflection prompts CRUD + objective_summary admin card.
- [ ] `/admin/admins` — grant/revoke UI.
- [ ] `/admin/retention` — admin variant, with "Everyone (admin)" radio enabled.
- [ ] `/r/<token>` — student reflection page. Valid token: intake form. Invalid token: broken-link view.

## 2. Teacher core flow (Phase B + B2)

### 2.1 Canvas connect

- [ ] Paste a known-good Canvas API token at `/dashboard/setup` → success message; teacher row has `canvas_host` and `canvas_token_encrypted` populated.
- [ ] Paste an invalid token → clear error; nothing persisted.
- [ ] Sign out, sign back in → token still works (encrypted at rest, decrypted on read).

### 2.2 Initial sync

- [ ] First load of `/dashboard` after Canvas connect → "Pulling your Canvas data…" banner; courses populate within ~30 sec.
- [ ] Active-term courses show first; inactive ones tucked under "Other courses ▸".
- [ ] Each course row shows accurate name, term, course code.

### 2.3 Install / uninstall

- [ ] Pick an unpublished test assignment. Expand the course → select → choose a prompt → leave "Reflection IS the submission" unchecked → "Install AI reflection."
- [ ] Canvas description in the browser now shows the EHS reflection card (logo, maroon CTA, "Open reflection →").
- [ ] `assignment_install_state` row has `status='installed'`, `installed_at` recent. `teacher_assignments.use_submission_body = false` for that assignment.
- [ ] Reinstall with a different prompt AND check "Reflection IS the submission" → only the prompt label + `use_submission_body` change; description stays one card (no duplicates). The hint text under the bulk-action bar updates with the toggle state.
- [ ] Bulk-select 3 assignments → install → all three flip status; row shows green "Installed". The submission-mode toggle applies uniformly to the batch.
- [ ] Uninstall one → Canvas description card disappears; status flips to `uninstalled`; reinstall later still works.
- [ ] **Comment-stripped Canvas test**: manually edit a Canvas description to strip the marker comments around the card (Canvas's RCE does this sometimes). Reinstall → the bare-card-by-token fallback still finds it; ends up with exactly one card. Same for legacy `v=1` iframe blocks (pre-M2).

### 2.4 Auto-install policy

- [ ] On a course, flip "Auto-install on new assignments in this course" → "saving…" indicator → settles.
- [ ] `course_install_policies.auto_install_new_assignments` is `true` for that (teacher, course).
- [ ] Create a NEW published assignment in Canvas in that course.
- [ ] Hit `/api/cron/sync-all-teachers` with `Authorization: Bearer $CRON_SECRET`:
  ```
  curl -H "Authorization: Bearer $CRON_SECRET" https://<your-deploy>/api/cron/sync-all-teachers
  ```
- [ ] Response JSON shows `autoInstall.assignmentsInstalled >= 1`. Canvas description on the new assignment now carries the reflection card. `assignment_install_state` has a fresh row.
- [ ] Uninstall it manually → flip the toggle off / leave on → re-run cron → the previously-uninstalled assignment **does not** reappear (uninstalls are sticky).

## 3. Student core flow (Phase C)

### 3.1 Standalone reflection link

- [ ] Open the Canvas assignment as a logged-in student in Canvas; click "Open reflection →" on the card. Lands on `/r/<token>` in a new tab.
- [ ] If not signed in to Google: redirected to `/auth/login?next=/r/<token>` → Google OAuth → back to the reflection page. Cookie set, no popup, no localStorage tokens.
- [ ] Non-EHS domain SSO → blocked at `/auth/callback` with "EHS Workspace accounts only."

### 3.2 Intake

- [ ] Add a tool + URL (Gemini share link). URL validated against the allow-list.
- [ ] Paste fallback text in the always-visible section.
- [ ] Pick a time-spent band.
- [ ] Type a first-draft paragraph ≥50 chars.
- [ ] Submit → first draft locks (read-only). `reflection_sessions` row exists with `state='in_progress'`, `first_draft` populated, no `mode` column (oral mode is gone).

### 3.3 Socratic conversation

- [ ] Bootstrap: two AI bubbles land back-to-back: objective summary + alignment question. Both render as Lora/Georgia chat bubbles, left side, "Reflection Partner" label on the first.
- [ ] Type an answer ≥30 chars → submit.
- [ ] Next AI bubble is the hardcoded final question: "What have you learned about working with AI from this assignment? What, if anything, will you do differently next time?" (NOT a Gemini call — verify by checking Network panel or Gemini logs.)
- [ ] Second answer → submit.
- [ ] Third AI bubble (closing summary) renders. `reflection_sessions.state` → `completed`. `objective_summary` is populated on the row.
- [ ] Refresh the page → conversation is in done-state ("Finalizing…" then closing UI).

### 3.4 Finalize pipeline

**Default path — assignment installed with `use_submission_body=false` (comment-only, the new default):**

- [ ] On reflection completion, Canvas does NOT receive a submission body — a **submission comment** appears in SpeedGrader, authored by the student (student avatar + name, no UI tell of teacher-token masquerade), containing the plain-text reflection: ALL-CAPS section headings (`AI USE REFLECTION`, `AI CONVERSATION(S)`, `FIRST-DRAFT REFLECTION`, `OBJECTIVE SUMMARY OF AI USE`, `REFLECTION CONVERSATION`, `AI CONVERSATION (PASTED)`) + AI chat URLs at the top + Q1./Q2./Q3. labeled turns. No `<!--` sentinel marker visible (intentional).
- [ ] `reflection_sessions.canvas_submission_id` populated with the shell submission's ID. `state='submitted'`.
- [ ] `submission_attempts` shows ONE `success=true` row with `error=null`. No "Text-entry submit rejected — falling back to comment." log entry (we never attempted the body POST).
- [ ] In the gradebook, the assignment column shows "Not Submitted" for the student (comment-only PUTs don't change `workflow_state`). Expected; teacher uses the dashboard's "View N reflections →" link to verify completion.
- [ ] Done-state UI shows "Submitted to Canvas".
- [ ] Super-grader webhook fired — see §6.1.
- [ ] **Body-mode marker is absent.** Confirm the Canvas submission body is empty/null — only the comment carries the reflection content.

**Opt-in body path — assignment installed with `use_submission_body=true`, assignment allows `online_text_entry`:**

- [ ] Canvas submission body contains: sentinel marker (`<!-- ai-documenter:reflection v=1 iframe-token=... -->`), AI chat link block at the top, first draft, objective summary, full Socratic Q/A, optional paste fallback. Open it as the teacher to verify.
- [ ] `reflection_sessions.canvas_submission_id` populated. `state='submitted'`.
- [ ] `submission_attempts` row exists with `success=true`, `error=null`.
- [ ] Done-state UI shows "Submitted to Canvas".
- [ ] In the gradebook, the assignment column shows "Submitted" (body POST DOES change `workflow_state`).
- [ ] Super-grader's grading view does NOT surface the reflection HTML as the student's essay — `classifySubmission` detects the marker and returns `body_source='missing'`. Open super-grader's `/grade/<assignmentId>/<submissionId>` for this student → essay viewer should say "no submission" or render the underlying student-authored content if one exists.
- [ ] Super-grader webhook fired.

**Body-mode comment fallback — body-mode assignment, no `online_text_entry` allowed:**

- [ ] Same outcome as the default comment-only path, EXCEPT `submission_attempts` shows TWO rows: first `success=false` with `error` starting "Text-entry submit rejected — falling back to comment." plus Canvas's actual error body; second `success=true`.

### 3.5 Failure paths

- [ ] **Teacher Canvas token revoked**: revoke the Canvas token, run a fresh reflection through to completion → done-state shows "Canvas didn't accept the auto-submit" + 6-char completion code in monospace. `submission_attempts.success=false`, `last_error` set. `state='failed'`.
- [ ] **Student has no `canvas_user_id`**: clear it on a test `students` row → run a fresh reflection. Backfill via roster lookup runs; check `students.canvas_user_id` populated AND `anon_token` re-keyed to the canonical form. (The lookup now matches `login_id` against the email's local part as well as full-email exact-match, so EHS-style accounts where `login_id=cmathews29` for `cmathews29@episcopalhighschool.org` resolve.)
- [ ] **Both submission paths fail**: temporarily revoke `as_user_id` permission (or use a teacher who isn't a teacher of the test course) → both POST + PUT 401 → `submission_attempts` has two false rows ("Text-entry submit rejected…" then "Comment fallback also failed…") → done-state shows the completion code.

## 4. Teacher review surface (Phase D)

- [ ] `/dashboard/reviews` index: assignments grouped by course, counts (`N total`, `N submitted`, `N failed`, `N in progress`). Empty assignments hidden.
- [ ] Click an assignment row → lands on `/dashboard/reviews/<courseId>/<assignmentId>`.
- [ ] Each student card shows: real name (de-anonymized), state badge, time-spent, AI tools, first draft, objective summary, full Q/A in chat bubbles, "Open in Canvas ↗", and a collapsed `▸ AI transcript` expander.
- [ ] Click `▸ AI transcript` → expands inline (no modal, no new page) with share links + pasted transcript in monospace.
- [ ] Filter pills work: All / Submitted / Failed / In progress filter the list AND update counts.
- [ ] Search box filters by student name + email.
- [ ] Sticky `N of M · jump to ▼` picker selects a card and scrolls it into view.
- [ ] Press `j` / `k` while focused on the page (not in an input) → advances / steps back. Sticky header stays clear of the active card (`scroll-mt-20`).
- [ ] Open `<deploy>/dashboard/reviews/<courseId>/<assignmentId>#session-<id>` directly → scrolls to that card on load. (This is the deep-link super-grader uses in its envelope's `detail_url`.)
- [ ] For a session with `submission_attempts.success=false`: "Resend to Canvas" button visible. Click → "Resending…" → "Submitted to Canvas" or a clear error. `submission_attempts` gets a new row.
- [ ] "View N reflections →" link in the dashboard accordion only appears on installed rows with ≥1 reflection.

## 5. Admin surface

- [ ] Sign in as `INITIAL_ADMIN_EMAIL` for the very first time → `/admin` self-bootstraps an `admins` row.
- [ ] As a non-admin teacher, hitting `/admin/*` redirects to `/dashboard`. Teal "Admin →" badge in dashboard header is hidden.
- [ ] Grant a new admin at `/admin/admins` → row appears in DB; that user can now access `/admin`.
- [ ] Try to revoke yourself when you're the last admin → blocked with "Can't revoke the last active admin."
- [ ] `/admin/prompts`:
  - [ ] Create a new reflection prompt → appears in teacher prompt picker for that scope on `/dashboard/prompts`.
  - [ ] Edit the Objective Summary prompt → save → next student reflection uses the new body (test by inspecting `reflection_sessions.objective_summary` after a fresh run).
  - [ ] Delete a reflection prompt currently installed on a Canvas assignment → cross-teacher uninstall fires; `assignment_install_state` for that assignment goes to `uninstalled`; Canvas description card disappears.

## 6. Super-grader integration

This is the riskiest surface — two peers must agree on shape and auth. Validate against `super-grader/planning/integration-contract.md` if anything looks off.

### 6.1 Webhook push (POST → super-grader)

- [ ] Complete a fresh reflection (§3.4). Watch super-grader's `peer_results` table — a new row appears within ~3 sec, `peer='ai_documenter'`, payload JSON validates against `validatePeerEnvelope`.
- [ ] Payload contains: `schema_version: 1`, `peer: 'ai_documenter'`, `canvas_user_id` (string), `canvas_assignment_id` (string), `anon_token` starting with `Student_`, ISO `completed_at`, non-empty `summary` object, **non-empty `links.detail_url`** (this is the part that 422s if the env var is missing).
- [ ] `detail_url` points at `<NEXT_PUBLIC_STUDENT_FORM_URL>/dashboard/reviews/<courseId>/<assignmentId>#session-<id>`. Visit it → review card scrolls into view.
- [ ] Webhook is fire-and-forget: a slow super-grader doesn't block the student flow. Simulate by temporarily setting `SUPER_GRADER_API_URL=https://example.invalid` → student still sees "Submitted to Canvas," server log shows the webhook error.

### 6.2 Pull-on-view (GET `/api/super-grader/result`)

```
curl -H "Authorization: Bearer $AI_DOCUMENTER_API_TOKEN" \
  "https://<deploy>/api/super-grader/result?canvas_user_id=<id>&canvas_assignment_id=<id>"
```

- [ ] Returns the same envelope shape as the webhook (200 OK).
- [ ] Most-recent session wins when multiple exist (verify by creating two test sessions: one `completed` not submitted, one `submitted`; the GET should return the `submitted` one).
- [ ] Without `Authorization` header → 401 with `{ ok: false, error: "unauthorized" }`.
- [ ] Wrong bearer token → 401.
- [ ] Missing query params → 400.
- [ ] Unknown `canvas_user_id` → 404.
- [ ] Known student but no session on that assignment → 404.
- [ ] `Cache-Control: private, max-age=30` set on success.

### 6.3 Pull-on-view (GET `/api/super-grader/prompts/objective_summary`)

```
curl -H "Authorization: Bearer $AI_DOCUMENTER_API_TOKEN" \
  "https://<deploy>/api/super-grader/prompts/objective_summary"
```

- [x] **Static shape check (audit-verified)**: code returns flat `{ owner: 'ai_documenter', key: 'objective_summary', body, version, updated_at }` matching super-grader's `fetchLivePrompt` parser (`super-grader/apps/teacher/lib/peers/prompt-pull.ts` line 90+). The earlier `{ schema_version: 1, prompt: {...} }` nested shape would have silently returned null and used super-grader's seeded fallback forever — fixed before push.
- [x] `version` is `Date.parse(updated_at)` — integer millis-since-epoch. Strictly monotonic per save since `updated_at` advances on every edit (Postgres `updated_at` trigger).
- [ ] **Live behavioral check (human)**: hit the endpoint with a valid token → 200 with the body above. Edit the prompt in `/admin/prompts` → save → re-hit → `body` reflects edit, `version` is larger. Without bearer → 401. Without `AI_DOCUMENTER_API_TOKEN` configured → 500. `Cache-Control: public, max-age=600`.

### 6.4 Canvas submission dedup marker

- [ ] Pull a sample Canvas submission body created by AI Documenter. First line is `<!-- ai-documenter:reflection v=1 iframe-token=<token> -->`.
- [ ] On the super-grader side, scrape the same assignment for grading → the AI Documenter submission is skipped (not surfaced as student work); the underlying student-authored submission is the one super-grader grades. (Manual check; super-grader's scrape logic does this filtering.)

### 6.5 Anon token consistency

- [x] **Audit-verified**: our `anonToken()` is byte-identical to integration-contract §2 reference impl across plain pairs, case/whitespace variants, numeric ids, and the `Student_[0-9a-f]{6}` shape. Verified via a temporary `contract.test.ts` (removed after the run — formalizing it as a permanent test is a small follow-up).
- [ ] **Production check (human)**: with the actual deployed `SUPER_GRADER_SALT`, fetch a `peer_results` row on super-grader's side → token for a known student matches the formula:
  ```
  HMAC-SHA256(SUPER_GRADER_SALT, "ehs\0" + canvas_user_id + "\0" + email.lowercase()) | first 6 hex chars | prefix "Student_"
  ```
  If they differ, the salts are out of sync between the two Vercel projects.

## 7. Phase F — Hardening

### 7.1 Retention sweep + CSV export

- [ ] `/dashboard/retention` as a teacher:
  - [ ] Default scope "All of my courses" shows snapshot counts that match a manual SQL query.
  - [ ] "Just one course" → pick a course → "Download CSV" → file downloads, opens in Excel without import dialogs (UTF-8 BOM works), 1 row per session, every column populated.
  - [ ] CSV contains a session with multi-line conversation in the `reflection_conversation` column — verify quoting doesn't break the row.
  - [ ] Type `delete` (lowercase) → "Permanently delete" stays disabled.
  - [ ] Type `DELETE` → button enables. Click → "Permanently deleted N reflections." DB rows gone.
  - [ ] Optional `beforeDate` filter — pick yesterday → only sessions before yesterday delete. Today's sessions survive.
- [ ] `/admin/retention` as an admin:
  - [ ] Default scope "Everyone (admin)" works. Snapshot counts include sessions across teachers.
  - [ ] Per-course scope still works (course list is cross-teacher; deduped).
  - [ ] Hard-delete with "Everyone" + no `beforeDate` is the end-of-year nuclear option — test on a non-prod DB only.
- [ ] As a non-admin teacher trying to call `hardDeleteReflections({target: 'all'})` directly (via DevTools): rejected with "Admin only."

### 7.2 Sentry telemetry

- [ ] With `SENTRY_DSN` unset: nothing in `instrumentation.ts` initializes; no network calls to Sentry; no perf hit.
- [ ] With `SENTRY_DSN` set: deliberately throw from a server action (e.g., temporarily add `throw new Error("sentry-smoke")` in a test action) → event appears in Sentry within ~30 sec, tagged `runtime: node`, environment matches Vercel env.
- [ ] Browser-side error (`throw` from a useEffect in a test page) with `NEXT_PUBLIC_SENTRY_DSN` set → event appears tagged `runtime: browser`.
- [ ] `tracesSampleRate: 0` — no transactions appear in Sentry's Performance tab.
- [ ] No request bodies in the events (`sendDefaultPii: false`).

### 7.3 Per-teacher rate limits

- [ ] As a teacher, set `gemini_daily_cap = 3` directly on the `teachers` row (admin client / Supabase dashboard).
- [ ] As a student in that teacher's course, attempt to complete a reflection → first reflection consumes ~3 Gemini calls (summary + alignment + closing). Second attempt that day immediately rate-limits.
- [ ] Student sees: "Your teacher's class hit the daily Gemini-call limit (3 of 3). Try again tomorrow, or ask your teacher to extend the cap."
- [ ] `gemini_usage_daily` row for that (teacher, today) shows `calls=3`, `denials >= 1`.
- [ ] Concurrency: two students hitting Gemini at the same moment for the same teacher (manual race) → row lock holds, calls count cleanly, no double-count past the cap. (Hard to test deterministically; trust the `FOR UPDATE`.)
- [ ] DB outage: simulate by stopping the Supabase project briefly → student flow does NOT block; logs show `[rate-limit] check_and_increment_gemini_call failed`; rate limit fails open.
- [ ] Reset `gemini_daily_cap` to NULL on the test teacher when done. `GEMINI_DEFAULT_DAILY_CAP=500` (or whatever env says) takes over.

### 7.4 Canvas roster sync + free-text PII scrub

- [ ] Trigger nightly cron manually with the bearer (see §2.4). Response JSON shows `rosters.coursesSynced > 0`, `rosters.studentsCached > 0`.
- [ ] `course_rosters` row exists for each (teacher, course); `students` jsonb is an array of `{canvas_user_id, name, email}` objects with real student names.
- [ ] Run a reflection as a student in a roster-cached course. In the intake, paste an AI transcript that contains real student names from that course's roster (e.g., "Mary Jones asked the chatbot for help...").
- [ ] After the reflection, inspect what reached Gemini:
  - The objective_summary stored in `reflection_sessions.objective_summary` should describe the activity *without* containing real names. If the seed prompt is doing its job, the summary refers to "the student" rather than echoing the (tokenized) input names back.
- [ ] Storage check: `reflection_sessions.paste_fallback_text` is stored unscrubbed (matches §3 spirit since scrubbing happens at the Gemini boundary, but flagged as a tightening opportunity in the audit notes below).
- [ ] Roster-free course (`course_rosters` row absent): scrub is a no-op; student flow still completes normally.
- [ ] Missing `SUPER_GRADER_SALT`: scrub is a no-op; student flow still completes (anonymizer raises at token-derive time but the scrub bridge catches it).

## 8. Database & RLS verification

Run these as queries (or scripted with the Supabase CLI). Treat any "RLS allowed me to read someone else's data" as a CRITICAL bug.

**Static (audit-verified 2026-05-12):**

- [x] RLS enabled on all 13 public tables (`list_tables` output). New tables `gemini_usage_daily` and `course_rosters` included.
- [x] Policies enumerate as expected:
  - `gemini_usage_daily` / `course_rosters`: `SELECT` only, `using (is_teacher_owner(teacher_id) OR is_admin())`. No `INSERT/UPDATE/DELETE` policies — writes go through service-role.
  - `reflection_sessions`: separate student-self and teacher-via-assignment `SELECT` policies.
  - `students`: `auth_user_id = auth.uid()` self-only.
  - `submission_attempts`: `SELECT` via join through `reflection_sessions` → `teacher_assignments` → owning teacher.
- [x] Helper functions `is_admin`, `is_teacher_owner`, `is_student_self`, `check_and_increment_gemini_call` all have `EXECUTE` granted to `authenticated` + `service_role` (not `anon`). The original rate-limit migration accidentally left an anon grant; cleared by `20260512140000_revoke_anon_from_rate_limit_rpc.sql`.
- [x] Migration count (14) matches `supabase/migrations/` count exactly.

**Dynamic (still needs a signed-in test session):**

- [ ] As `authenticated` (signed-in teacher A, *not* admin), select `reflection_sessions` for teacher B's assignments → zero rows.
- [ ] As `authenticated` (signed-in student) selecting reflection_sessions → only own rows.
- [ ] As `authenticated` (signed-in teacher), select `gemini_usage_daily` → only own rows.
- [ ] As `authenticated` (signed-in admin), select `gemini_usage_daily` → all rows.
- [ ] As `authenticated` (signed-in teacher), select `course_rosters` for teacher B's course → zero rows.
- [ ] As `authenticated` (signed-in admin), select `course_rosters` cross-teacher → all rows.

## 9. Edge cases & regressions

**Static (audit-verified 2026-05-12):**

- [x] Oral mode is gone in code: `grep -rE "\boral\b|oral_mode_enabled|reflection_mode" src/` returns zero hits outside tests. Schema-level drop confirmed in §0.
- [x] No dangling TODOs / FIXMEs / XXXs / HACKs in `apps/teacher-admin/src/`.
- [x] Every `process.env.X` reference matches a documented env var (no typos like `SUPER_GRADER_SAL`).
- [x] Package-level secrets (`SUPER_GRADER_SALT`, `CANVAS_TOKEN_ENC_KEY`) live in the packages that read them; app code touches them only through `readSaltFromEnv()` / `readKeyFromEnv()`.

**Dynamic (still needs the running app):**

- [ ] Old reflection_sessions rows survive the column drop (we migrated when no production rows had `mode='oral'`).
- [ ] Auto-install respects uninstalled state: a teacher who explicitly uninstalled a previously-auto-installed assignment never gets it back. Verify by toggling off / on the policy and re-running cron.
- [ ] Resend-to-Canvas: only the owning teacher can call `resendToCanvas(sessionId)`. Try via DevTools as teacher B for teacher A's session → "You don't own that reflection."
- [ ] The `instrumentation-client.ts` doesn't ship a Sentry payload on prod builds when DSN is unset (open DevTools → Network → no requests to `*.ingest.sentry.io`).
- [ ] CSV export with zero matching rows → returns a CSV containing just the header row; no error.
- [ ] Retention page snapshot is loaded server-side; changing the scope picker on the page does NOT re-query the summary card (that's the "snapshot at load" UX choice).
- [ ] Gemini 3 Flash thinking tokens: all three reflection-flow calls cap at `maxOutputTokens: 4096`. A reply truncated mid-sentence means the model spent too many thinking tokens; check via Gemini API logs.

## 10. Failure modes (deliberately break things)

- [ ] Unset `GEMINI_API_KEY` → student reflection fails at Gemini boundary with a clear "Couldn't generate the objective summary" message. State stays `in_progress`; student can retry after teacher fixes config.
- [ ] Unset `SUPER_GRADER_INGEST_TOKEN` → webhook skips with `skipped: true`. Canvas auto-submit still happens; teacher review still works. Super-grader's pull-on-view picks up the result later.
- [ ] Unset `NEXT_PUBLIC_STUDENT_FORM_URL` → webhook is skipped (we refuse to emit an invalid envelope per the §6.1 fix). `/api/super-grader/result` returns 500 with a clear error. **Don't deploy without this set.**
- [ ] Unset `CRON_SECRET` → cron route returns 500 "CRON_SECRET not configured". Vercel cron headers still fail auth.
- [ ] Unset `AI_DOCUMENTER_API_TOKEN` → both super-grader GET routes return 500 with "AI_DOCUMENTER_API_TOKEN is not configured on this deploy." Super-grader sees this as a config error, surfaces it in its admin view.
- [ ] Drop the Supabase connection mid-flow → student-facing actions surface the error in the chatbot UI; finalize idempotently resumes on retry.

## Outstanding audit findings

Recorded here so the next pass doesn't have to re-derive them. ✅ items resolved 2026-05-12.

1. **Canvas write may contain anon tokens.** Per integration-contract §3, Canvas writes should be de-anonymized. We scrub before the Gemini call which means `reflection_sessions.objective_summary` *could* contain `Student_xxxxxx` tokens (theoretically — the seed prompt says "leave tokens as-is, never use real names" so in practice tokens don't appear because the input doesn't reference any). If they ever do, the Canvas submission body would show tokens to the teacher. Fix when it surfaces: de-anonymize the body at write time using the same `course_rosters` cache.
2. **`paste_fallback_text` stored unscrubbed.** §3 says all Gemini-related stored text should be anonymized at rest. Our practice scrubs at the Gemini boundary, which keeps PII out of Gemini, but the raw paste lives in the DB. Acceptable since the DB is private to EHS-on-Supabase, but tighter would be: scrub on insert + de-anonymize at render. Pairs with the Canvas write story above.
3. **GET vs webhook envelope drift.** The GET response includes `state` in `summary`; the webhook doesn't. Per §8 extra fields are non-breaking, but consistency would simplify debugging.
4. **Cron timing.** `vercel.json` schedules `0 8 * * *` (08:00 UTC = 04:00 EDT / 03:00 EST). Integration contract suggests 03:00 ET. Close enough; nudge if super-grader's 04:00 ET starts colliding with our roster sweep.
5. **"Not started" footer on review pages.** Now unblocked by Phase F's roster cache; not bundled in this push.
6. **AI Documenter not yet in super-grader's `PROMPT_PATH_BY_PEER` map.** Super-grader needs to add `ai_documenter: "/api/super-grader/prompts/objective_summary"` to `prompt-pull.ts`. Our endpoint is ready and contract-conforming; they just need to wire it up.
7. ✅ **`check_and_increment_gemini_call` had EXECUTE granted to anon.** Supabase auto-grants EXECUTE to `{anon, authenticated, postgres, service_role}` on every new public function; the migration's `revoke ... from public` doesn't clear role-specific grants. Risk: DoS — unauthenticated attacker who knew a teacher's UUID could pound the RPC to inflate that teacher's daily counter past the cap. Resolved by migration `20260512140000_revoke_anon_from_rate_limit_rpc.sql` (applied + verified 2026-05-12).
8. ✅ **Promote the temp anon-token contract test** (resolved 2026-05-13). Permanent test at `packages/anonymizer/src/contract.test.ts` — inlines the §2 reference impl verbatim (with the salt pulled out for testability) and runs a table of inputs (plain pair, case/whitespace variants, numeric id, long id, hyphens) through both that reference and our `anonToken`, asserting byte-equal output + the `Student_[0-9a-f]{6}` shape. Includes a random-salt sweep to catch salt-conditional drift, plus a golden assertion. 9 contract tests; anonymizer suite now 39 tests total.
9. ✅ **Canvas roster lookup matched `search_term=` against full email; failed at EHS where `login_id` is the local part only.** Symptom: real student "couldn't be found on the Canvas roster" even though enrolled. Fix: dropped `search_term=`, list whole roster, match against `primary_email` / `email` / `login_id`-as-full-email AND `login_id`-as-local-part. Cached on `students.canvas_user_id` after first resolve.
10. ✅ **Canvas 400'd `online_text_entry` POST on a file-upload-only assignment.** Symptom: "Canvas rejected the submission (HTTP 400). Body: submission_types does not include online_text_entry." Fix: added a comment-fallback path — on 400/422, retry as `PUT submissions/:user_id` with `comment[text_comment]=<plain-text>` via `as_user_id`. Canvas's `find_or_create_submission` seeds a shell; comments aren't gated on submission types. No sentinel marker on the comment (super-grader scrapes bodies only). Integration-contract §12 updated on super-grader's side too.
11. ✅ **`NEXT_PUBLIC_STUDENT_FORM_URL` was pointing at a dead Vercel project alias.** During the 2026-05-12 walkthrough the reflection card on an installed assignment showed Vercel's `DEPLOYMENT_NOT_FOUND` 404 — both the logo and the "Open reflection →" link. Root cause: env var was set to `https://ai-documenter-v2-student-form.vercel.app` (the legacy student-form project that was deleted post-M1 merge). Diagnostic: `curl -sI https://<host>/` for each candidate; the live hostname is `https://ai-documenter-v2-teacher-admin.vercel.app`. Fix: update the env var on Vercel + redeploy (`NEXT_PUBLIC_*` is build-time baked) + re-install on affected assignments. Resolved 2026-05-12 — added to operational guidance below.
12. ✅ **Auto-install fired on every existing assignment, not just new ones.** Symptom: flipping `auto_install_new_assignments=true` on a course (or hitting Refresh after enabling it) installed cards on every published assignment in the course, not just future ones. Root cause: skip-check was "row exists in `assignment_install_state`" — on a pristine course no rows existed, so every assignment looked new. Fix: added `course_install_policies.auto_install_enabled_at` (set on off→on flip) + `canvas_assignment_cache.first_seen_at` (set on initial INSERT, preserved across upserts). Auto-install now installs only when `first_seen_at > auto_install_enabled_at`. Migration `20260512150000_auto_install_baseline.sql`. Resolved 2026-05-12.

## Open questions / things to look at next round

Flagged during 2026-05-12 student testing — not blocking, not fully diagnosed. Pick up when convenient.

- ✅ **Funny stuff on Canvas submissions — separate submissions for links vs. transcripts in one case** (resolved 2026-05-13). Diagnosis: student manually pasted her ChatGPT link into Canvas's text-entry box and submitted, BEFORE running through AI Documenter; our auto-submit then appended the full reflection as a second entry in Canvas's `submission_history`. Single-POST audit confirmed our code POSTs exactly once per finalize. Becomes moot under the new comment-only default — we don't write to `submission_history` at all.
- ✅ **Super-grader-side behavior on AI Documenter submissions** (resolved 2026-05-13). Diagnosis: super-grader's contract claim about filtering marker-tagged bodies was aspirational — the code had no such filter. Bodies were stored as `body_source="canvas_text"` and rendered as the student's essay. Fix shipped in super-grader's `classifySubmission`: regex match on `<!--\s*ai-documenter:reflection\s+v=` returns `body_source="missing"`. Integration-contract §12 updated. The shell+comment scenario was handled correctly by accident (Canvas leaves `workflow_state="unsubmitted"` on comment-only PUTs, super-grader skips at `workflow_state` check).
- ✅ **Submission body formatting needs work** (resolved 2026-05-13). Default switched to comment-only with clean ALL-CAPS plain-text format. Body path remains as an opt-in for AI-literacy assignments; same HTML structure as before but its audience is narrower now.
- ✅ **Link goes first** (resolved 2026-05-13). Both `buildSubmissionBody` (HTML) and `buildSubmissionBodyText` (plain text) emit the AI chat link block right after the title, before first draft / objective summary / conversation.
- **Teacher onboarding copy for comment-only default.** The "Not Submitted" gradebook column under comment-only mode will surprise teachers who track completion via the column. The 1-pager + 3-min video onboarding (already a planned follow-up) should explicitly call this out: "the gradebook still shows Not Submitted until they turn in their actual work — use the View Reflections link on the dashboard to track completion."
- **Test Turnitin Plagiarism Framework + body mode in the wild.** If any EHS teacher opts into body-mode on a Turnitin-enabled assignment, Turnitin's similarity engine will scan our reflection HTML. Outcomes range from "weird similarity scores against our boilerplate" to "false-positive plagiarism flag." Decide whether to add an install-time warning when both conditions are detected (`use_submission_body=true` AND assignment has plagiarism review enabled). Needs a Canvas-API probe at install time to check `assignment.turnitin_enabled` or similar.

## Operational reminders

- **`NEXT_PUBLIC_STUDENT_FORM_URL` must equal the live serving hostname**, currently `https://ai-documenter-v2-teacher-admin.vercel.app` (no trailing slash). Both the reflection card's logo `src` and the "Open reflection →" `href` are built from this env at install time. Changing it requires a redeploy *and* a re-install on any pre-existing assignment whose card was built against the old value. If a card 404s with Vercel's `DEPLOYMENT_NOT_FOUND`, this is the first place to look.
- **`NEXT_PUBLIC_*` env vars are build-time, not runtime.** Editing them on the Vercel dashboard does NOT take effect until the next `vercel deploy --prod`. Easy to forget when you've changed everything else and the bug doesn't go away.
