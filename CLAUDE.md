# AI Documenter v2 — Planning Notes

Planning snapshot from 2026-04-23, with refinements logged below. This folder is a subrepo for v2; the Apps Script app in the parent directory is v1 and remains in production. Phases 1, 2, 2.2 (with auto-install policy + nightly sweep), the admin layer, all of Phase 3 (intake + Socratic conversation + closing pipeline), Phase 4 (teacher review surface — index, per-assignment scroll, filters, resend), the super-grader-facing GET endpoints, and Phase 6 hardening (retention with CSV export, Sentry, per-teacher rate limits, Canvas roster sync + PII scrub) are implemented end-to-end. The biggest shift since the original plan: **the iframe model is gone**. Student app is a standalone web surface at `/r/<token>` on the merged single Next.js app, linked into Canvas via a branded reflection card. Phase 5 (oral mode) was cut. Remaining: the roster-driven "not started" footer (now unblocked) and a teacher onboarding 1-pager. Live state + setup steps live in [`README.md`](./README.md); phase status, schema, and design specs live in [`BUILD_PLAN.md`](./BUILD_PLAN.md).

## Refinements since the 2026-04-23 snapshot

These decisions came out of building work and supersede / extend the original scope below where they conflict. Newest first.

### 2026-05-13 — Comment-as-submission is now the default; body path is opt-in

- **Why.** The first real student walkthrough (2026-05-12) surfaced two latent problems with our body-as-submission default: (a) on Turnitin Plagiarism Framework assignments, Canvas fed the reflection HTML to Turnitin's similarity engine as if it were the student's essay, producing nonsense scores; (b) super-grader's Canvas scrape claimed to filter marker-tagged AI Documenter bodies but didn't — the reflection HTML surfaced as the student's primary essay in super-grader's grading view. Hugh's audit of Canvas's API behavior also confirmed comments (`PUT /submissions/:user_id` with `comment[text_comment]`) work on every assignment type via `find_or_create_submission`, regardless of `submission_types[]`. So comment-first is both more correct AND more universal.
- **What ships.** `finalizeReflection → submitReflectionToCanvas` now branches on `teacher_assignments.use_submission_body`:
  - **false (new default)** → comment-only path. PUTs the plain-text reflection as a `comment[text_comment]` under `as_user_id` masquerade. No body-POST attempted, no fallback if comment fails (the teacher opted into comment; surfacing the completion code on failure preserves that contract).
  - **true (opt-in)** → legacy body path. POSTs `online_text_entry` HTML with the sentinel marker; on 400/422 falls back to comment exactly like before. For AI-literacy assignments where the reflection IS the deliverable.
- **Per-assignment toggle on the install picker.** New `teacher_assignments.use_submission_body boolean default false` column. Migration `20260513120000_use_submission_body.sql`. The dashboard install picker grows a small "Reflection IS the submission" checkbox next to the prompt selector — off by default, with a one-line hint that updates based on toggle state. `installOnAssignments` takes the flag as a 4th arg; `ensureTeacherAssignment` updates the column on reinstall so teachers can flip modes without uninstalling. Auto-install (cron sweep) doesn't expose a toggle and relies on the DB default — every auto-installed assignment lands as comment-only, which is the safe bulk default.
- **Authorship via masquerade.** `as_user_id=<student>` means Canvas attributes the comment to the student (student avatar + display name in SpeedGrader's comment panel), even though the teacher's API token authenticates the request. Documented behavior per Canvas's masquerade docs: "behaves as if the target user had made the API call with their own access token." Audit log captures both the calling teacher and the target student.
- **"Not Submitted" badge tradeoff (accepted).** Comment-only PUTs don't mutate `submission.workflow_state`, so the shell submission stays `"unsubmitted"`. Result: the gradebook column shows "Not Submitted" for every student who completed only the reflection (until they submit their actual essay/file). Teachers tracking completion via the gradebook column lose that signal; they use AI Documenter's own "View N reflections →" link on the dashboard instead. Real submissions (essay, file upload) flip the column to "submitted" as normal.
- **Super-grader update shipped in lockstep.** Super-grader's `classifySubmission` (`apps/teacher/app/dashboard/actions.ts`) now actually filters marker-tagged AI Documenter bodies — regex match on `<!--\s*ai-documenter:reflection\s+v=` (case-insensitive), returns `body_source = "missing"`, body dropped. Closes a long-standing contract drift where the integration contract claimed filtering happened but the code didn't. Important for the minority of teachers who opt into body-mode going forward (most teachers will hit the comment path, which super-grader never scrapes anyway). Integration-contract §12 updated to describe what the code actually does.
- **Turnitin compatibility.** Plagiarism Framework path (newer, recommended by Turnitin, likely EHS's actual setup): comment-only is structurally clean — Turnitin scans only submission bodies, never comments, so our reflection content stays out of the similarity engine. Body-mode opt-in remains the pre-existing trap; teachers who pick body-mode on a Plagiarism Framework assignment will see weird similarity scores. Worth a teacher-facing warning at install time if EHS hits this, tracked as a follow-up rather than a blocker. Legacy External Tool LTI path (`submission_type=external_tool`): SpeedGrader is disabled by Turnitin's design, so neither comments nor bodies surface well there — comment-only doesn't make it worse, but doesn't fix it either.
- **What this resolves.** TESTING.md open question #3 ("submission body formatting needs work"). The plain-text comment format with ALL-CAPS section headings + Q1/Q2/Q3 anchors lands directly without Canvas-RCE-mangling. Open question #1 (split submissions from manual student paste + our auto-submit colliding in submission_history) becomes moot under comment mode — we don't post to `submission_history` at all, so the student's manual paste stays the canonical submission.

### 2026-05-12 — Canvas comment fallback for non-text-entry assignments

- **Problem.** If the assignment's `submission_types[]` doesn't include `online_text_entry` (e.g., file-upload-only assignments), Canvas 400s our regular submission POST. The student finishes the reflection but the teacher gets "Canvas rejected the submission" + a 6-char completion code they have to paste manually. Bad UX; many of the assignments teachers actually want to use this on are file uploads (final papers, project files).
- **Fix.** Two-tier submit path. Try `POST submissions` with `submission_type=online_text_entry` first (HTML body, current behavior). On a 4xx that indicates a submission-type mismatch (400 or 422), fall through to `PUT submissions/:user_id` with `comment[text_comment]=<plain-text reflection>`. Canvas's source (`submissions_api_controller.rb#update`) processes the comment params independently of `submission[]` and calls `@assignment.find_or_create_submission(@user)` to seed a shell submission, so the comment works regardless of what submission types the assignment allows.
- **Plain-text body**: mirrors the HTML body section-for-section. ALL-CAPS headings ("FIRST-DRAFT REFLECTION", "OBJECTIVE SUMMARY OF AI USE", "REFLECTION CONVERSATION"), Q1./Q2./Q3. labelled turns. Canvas renders comments as plain text, so HTML tags would show literally — we ship clean plain text. **No sentinel marker on the comment path** — super-grader scrapes submission *bodies* for the marker, not comments, so there's nothing to dedupe and the literal `<!--` text would just clutter SpeedGrader.
- **Author identity.** Comment is posted via `as_user_id` so it shows in SpeedGrader as authored by the student — same masquerade we already use for the regular submission path. Permission model: Canvas only requires manage-grades for `submission[]`/`rubric_assessment[]` params; comment-only PUTs use the student's own permission scope.
- **Super-grader integration unchanged.** The webhook still fires after either Canvas path with the full envelope. Super-grader's AI Use card renders from `peer_results`, which means the reflection appears in super-grader regardless of whether the Canvas write landed as a submission or a comment. Integration contract §12 updated with a "Comment-only fallback path" paragraph clarifying that comments do NOT carry a sentinel marker (none needed).
- **Telemetry.** Two `submission_attempts` rows on the fallback path: one false row ("Text-entry submit rejected — falling back to comment.") with the full Canvas error body, then either a true row ("Submitted via comment fallback.") or a second false row ("Comment fallback also failed."). The teacher's review surface shows the most-recent attempt's status; the audit trail is in the table.

### 2026-05-12 — Phase 6 shipped (retention, Sentry, rate limits, roster sync)

- **Retention sweep with CSV export + hard delete.** Two pages: `/dashboard/retention` (teacher: own data, per-course or "all of mine") and `/admin/retention` (admin: per-course or school-wide). Both flow through the same `RetentionPanel` client component. CSV export packages first draft, objective summary, full Socratic Q/A as a single multi-line cell, AI chat URLs, and paste-fallback. UTF-8 BOM prepended so Excel-on-Windows imports cleanly. Hard delete uses a "type DELETE to confirm" guard plus an optional `created_at < beforeDate` filter; chunks IN-list deletes at 200/batch.
- **Rate limits per teacher.** New `gemini_usage_daily(teacher_id, date, calls, denials)` table. Atomic check + increment via SECURITY DEFINER `check_and_increment_gemini_call(p_teacher_id, p_default_cap)` — `FOR UPDATE` row lock so concurrent students of the same teacher can't both squeak in past the cap. Per-teacher override on `teachers.gemini_daily_cap`, env default via `GEMINI_DEFAULT_DAILY_CAP` (fallback 500). Wired into both Socratic coach turns and the objective-summary call. Fails open on DB hiccup — we'd rather over-serve a student than block them on a rate-limiter glitch. `EXECUTE` granted to `authenticated` (and to `service_role`) per the function-grant memory note.
- **Sentry.** `@sentry/nextjs` ^10.53. Wired via `instrumentation.ts` (Node + Edge, branched on `process.env.NEXT_RUNTIME`) and `instrumentation-client.ts` (browser). Init gated by `SENTRY_DSN` (server) / `NEXT_PUBLIC_SENTRY_DSN` (client) — missing DSN = no init, no events, no perf overhead. `onRequestError` funnels server-action / route-handler errors. `sendDefaultPii: false` because the teacher's Canvas token is in scope state during install. `tracesSampleRate: 0` until we have a baseline cost shape for performance events.
- **Canvas roster sync.** New `course_rosters(teacher_id, canvas_course_id, students jsonb, last_synced_at)` table. Nightly cron pulls `/api/v1/courses/{id}/users?enrollment_type[]=student&include[]=email&per_page=100` and upserts the jsonb. Run order in the cron: cache refresh → roster sync → auto-install sweep (only when sync succeeded — running against a stale cache risks installing on assignments that no longer exist). `compiledRosterForCourse(canvasCourseId)` compiles a roster into the existing anonymizer regex and caches the compiled pattern in-process for 5 minutes. `scrubSessionForGemini(session, canvasCourseId)` is the boundary helper — scrubs `first_draft`, `paste_fallback_text`, `ai_chats[].transcript_text` before either Gemini call. Empty roster or missing salt = no-op (defense-in-depth, not a hard gate).
- **The "Not started" footer on review pages is now unblocked.** The roster source it was waiting on exists. Filed as a follow-up rather than shipping in this batch since the rest of the surface is fine without it.

### 2026-05-12 — Oral mode cut; Phase 6 started

- **Oral mode is out.** No Gemini Live, no mic capture, no STT-review surface. Written-mode covers the goal — students reflecting on their AI use — and the audio path added too much complexity (WebSocket relay to keep the key server-side, audio retention story, mic permissions UX, end-of-turn detection) for a real but marginal upside over a typed paragraph. Migration `20260512100000_drop_oral_mode.sql` drops `teacher_assignments.oral_mode_enabled`, `reflection_sessions.mode`, and the `reflection_mode` enum. `teacher_assignments.written_mode_enabled` stays for now (vestigial; can clean up if it never sees a non-default use).
- **Cost monitoring is also out.** Centralized Gemini key is observable in AI Studio; no reason to re-implement counters and dashboards in this app.
- **Phase 6 kicked off.** Order: retention sweep with CSV export → Sentry telemetry → per-teacher rate limits → Canvas roster sync for free-text PII scrub. Each is gated behind an env var or feature flag where appropriate so missing config = graceful no-op rather than a hard error.

### 2026-05-12 — SG endpoints, auto-install sweep, anchor deep-links

- **`GET /api/super-grader/prompts/objective_summary`** and **`GET /api/super-grader/result?canvas_user_id=…&canvas_assignment_id=…`**. Both bearer-auth via `AI_DOCUMENTER_API_TOKEN` (distinct from the `SUPER_GRADER_INGEST_TOKEN` AI Documenter presents on its outbound webhook). The `/result` envelope mirrors super-grader integration-contract §4 exactly — same shape as the webhook POST — so super-grader uses one deserializer for both paths. Lookup: `students` by `canvas_user_id`, `teacher_assignments` by `canvas_assignment_id` (accept any co-taught install), most-recent `reflection_sessions` ordered by `submitted_at DESC NULLS LAST`. 404s when no session exists. Cache-Control is short — pull-on-view is per-teacher-load, the state can change between loads.
- **Auto-install policy persistence + nightly sweep.** `setCourseAutoInstall(courseId, enabled)` upserts `course_install_policies.auto_install_new_assignments`; first-time enable seeds the policy with the system Default reflection prompt. The nightly cron now (a) refreshes the cache, (b) for each teacher with policy-enabled courses, installs the reflection card on any newly-encountered published assignment. Sticky on uninstalls — an assignment a teacher explicitly removed never reappears. Service-role install path (`installReflectionCardServiceRole`) is a deliberate fork of the public action's `installOne`: the cron has no user session, and the writes are intentionally service-role in this codebase.
- **Session anchor IDs on review cards.** Each card wrapper now carries `id={`session-${sessionId}`}` so the `#session-<id>` fragment in the webhook envelope's `detail_url` lands on the right card. `scroll-mt-20` keeps it clear of the sticky filter bar.
- **AI_DOCUMENTER_API_TOKEN env var** added to the Vercel set. Same shape as `CRON_SECRET` — bearer on `GET /api/super-grader/*`. If the var is missing the route returns 500 (not 401) so the failure mode is loud during initial setup rather than silently rejecting super-grader's perfectly valid requests.

### 2026-05-12 — Phase 4 (teacher review surface) shipped

- **`/dashboard/reviews` index** lists every installed assignment with at least one reflection, grouped by course, with total / submitted / failed / in-progress counts. Empty assignments are intentionally hidden from the index — the dashboard accordion already covers "what's installed where," and showing zero-touch assignments here would just bury the actionable ones. They reappear automatically once a student touches them.
- **`/dashboard/reviews/[courseId]/[assignmentId]`** renders every student in a single scroll (no pagination, no modals). Each card carries the real student name (de-anonymized at render time since `students` already stores the real `display_name`/`email` server-side), state badge, time-spent band, AI tools used, first draft, objective summary, the full Socratic conversation in chat bubbles, and a collapsed `<details>` AI transcript section. "Open in Canvas ↗" deep-links to the submission using the teacher's `canvas_host`.
- **Resend-to-Canvas** is a one-button retry surfaced when the most recent `submission_attempts.success = false`. The `resendToCanvas(reflectionSessionId)` server action reuses `submitReflectionToCanvas` from the closing pipeline — same masquerade, same submission body, same anon-token re-key. Auth check: load session → teacher_assignment → verify `teacher_id` matches caller (via `getCurrentTeacher`).
- **Ownership boundary, data path.** RLS scopes `reflection_sessions` to student-self (the student writes them via the cookie client during the conversation). Teachers can't read directly via RLS, so the review loader takes a two-step route: (1) read `teacher_assignments` via the cookie client — if the row comes back, RLS has already confirmed teacher ownership; (2) admin client for everything downstream (sessions, students, submission_attempts). That's the same pattern the install/sync surfaces use, so no new RLS gymnastics.
- **Keyboard navigation pattern.** `j`/`k` step through the visible (post-filter) cards, suppressed while typing in inputs/textareas. The active index is clamped at *read time* via a derived `effectiveIndex`, never written back via an effect — eslint's `react-hooks/set-state-in-effect` is on, and the clamp-via-effect pattern trips it.
- **Dashboard accordion entry.** Each installed `AssignmentRow` grows a `View N reflections →` link inline once `reflectionCount > 0`. Counts come from a single grouped query (`loadReflectionCountsByAssignment`) on dashboard load, not a per-row query.
- **"Not started" footer deferred.** Phase 4's design called for a roster-driven footer listing students who haven't completed yet. That needs the same Canvas-roster-sync mechanism that the free-text-PII regex needs — tracked under Phase 6. The card surface ships without it.

### 2026-05-11 — Iframe → standalone; brand + UX redesign; Phase 3.3 shipped; conversation flow rewritten

This is the biggest single-day shift since the original plan. Most earlier "iframe" entries are now historical.

- **Iframe model dropped.** The student app is no longer embedded in Canvas. It's a standalone first-party web surface at `/r/<token>` on the merged single Next.js app. Canvas assignments now carry a branded **reflection card** (EHS logo, maroon CTA, "Open reflection →" link) that opens the standalone app in a new tab. The "mandatory feeling" stays via auto-submit on completion + a prominent visually-anchored card; the iframe contortions (popup OAuth, `postMessage` token handoff, `localStorage` token storage, accessToken-as-explicit-server-action-arg, Storage Access API) are all gone. *Supersedes 2026-05-08 "Iframe SSO is token-based".*
- **Apps merged.** `apps/student-form` was folded into `apps/teacher-admin` as a `(student)` route group. Single Vercel project; single origin; single auth surface. Auth is cookie-based via `@supabase/ssr` everywhere now. Unified `/auth/callback` routes by `next` prefix: `next.startsWith('/r/')` → upsert as student; else upsert as teacher. `apps/student-form` directory deleted. Old `ai-documenter-v2-student-form` Vercel project marked for deletion.
- **Canvas install: iframe → branded card.** `packages/canvas/install.ts` `buildIframeBlock` → `buildReflectionBlock`, emits the EHS card HTML (logo from `/brand/ehs-horizontal.webp` on the merged app, maroon button, Required-for-credit subhead). Marker bumped `v=1 → v=2`. Helper renames: `replaceOrAppendReflectionBlock`, `removeReflectionBlock`, `findReflectionBlock`. Two fallback paths added for comment-stripped Canvas descriptions: bare-card-by-token (anchor-href walk-out to enclosing `<div>`) AND legacy-iframe-by-token (so reinstalls clean up pre-M2 iframe blocks). 32 install tests (was 23).
- **EHS brand layer.** `apps/teacher-admin/src/app/globals.css` defines the palette as Tailwind v4 `@theme` tokens — `maroon #7a1e46`, `cool-gray #54565b`, `light-blue #c4dceb`, `dark-blue #006890`, `paper #fafaf7`, `ink #1a1a1a`, plus `maroon-dark` / `dark-blue-dark` for hovers. Lora loads via `next/font/google`; Georgia is the web-safe fallback and the explicit font for "official document" surfaces (static prompt block, intake textarea). `<BrandHeader>` (logo + eyebrow + title + nav + customizable rule) is shared across student / dashboard / admin route groups. The EHS style guide lives at https://www.episcopalhighschool.org/ehs-style-guide and is mirrored in memory.
- **Conversation flow rewritten (no longer 3 Socratic questions).** Today's shape:
  1. Student submits intake including a **first draft** of their reflection (paragraph, ≥50 chars, locked on submit).
  2. On conversation page mount, server emits **two AI messages back-to-back**: the objective summary (Gemini call using the `purpose='objective_summary'` prompt) + an alignment question (Gemini call using the reflection prompt).
  3. Student answers.
  4. Server **hardcodes** the next AI message: *"What have you learned about working with AI from this assignment? What, if anything, will you do differently next time?"* (No Gemini call.)
  5. Student answers.
  6. Gemini generates a warm closing summary (reflection prompt body + closing-phase instruction); state → `completed`.
  Total: 3 Gemini calls per conversation (summary, alignment Q, closing), 2 student answers. *Supersedes the 3-Socratic-questions shape from slice 2.*
- **Schema additions** (`prompts.student_facing_question`, `reflection_sessions.first_draft`, `reflection_sessions.objective_summary`).
  - `prompts.student_facing_question text` — short student-facing question shown on intake + as the static prompt block on the conversation page. Distinct from `prompts.body` (the Gemini system prompt). Admin-editable on `/admin/prompts`; teacher-editable on `/dashboard/prompts`. Falls back to a sensible default if blank.
  - `reflection_sessions.first_draft text` — the locked first draft. Becomes part of the Canvas submission body.
  - `reflection_sessions.objective_summary text` — server-generated during conversation bootstrap (not at finalize). Renders to the student inside the conversation AND ships in the Canvas submission body and the super-grader webhook envelope.
- **Objective summary placement reversed.** Earlier (2026-05-07) decision said the summary goes in the Canvas submission body. Then (mid-redesign on 2026-05-11) said it goes only to teachers + super-grader. **Final position:** it goes everywhere — Canvas body, super-grader webhook, and student view inside the conversation. Both prompts (objective_summary + reflection) were rewritten on 2026-05-11 to match this and the new flow.
- **Chatbot UX for the conversation page.** Replaced the editorial-stacked-Q&A layout with real chat bubbles (left=AI, right=student). The locked first draft renders as the opening student bubble — chat-native, no separate "your reflection" top zone. Bigger Composer (rows=6, paragraph-shaped). AI label "Reflection Partner" on the first bubble; subsequent bubbles rely on alignment. Editorial restraint preserved (Lora/Georgia, maroon accents, no playful animations).
- **maxOutputTokens bumped to 4096 across all three Gemini calls.** Gemini 3 Flash thinking tokens count against the same budget — at lower caps (256/512/1024) the visible reply lands mid-sentence. Confirmed via a live test where both summary and alignment Q truncated.
- **Supabase auth redirect allowlist needs `http://localhost:3001/**`** (and any other dev origin you use). Without it, the OAuth round-trip falls back to Site URL on completion and `next` is dropped — student-flow sign-ins get routed to the teacher path. Diagnosed via auth-log `referer` field showing the production URL even when the user started on localhost.
- **Vercel project renamed `ai-documenter-v2-teacher-admin` → `ai-documenter-v2`** to reflect the merge. The `.vercel.app` URL did NOT auto-issue (`ai-documenter-v2.vercel.app` is claimed elsewhere on the platform) — the original `ai-documenter-v2-teacher-admin.vercel.app` URL remains the serving domain. `NEXT_PUBLIC_STUDENT_FORM_URL` keeps that value. Custom domain (`reflect.episcopalhighschool.org` or similar) is the long-term clean URL.
- **iframe_token kept as the DB column name.** It's an opaque entry token now, not pointing to an iframe. Renaming would touch every server action, type, and migration with no functional benefit. The route segment is `/r/<token>` — the historical name only surfaces internally.
- **Super-grader integration contract envelope.** Webhook to `<SUPER_GRADER_API_URL>/api/ingest/ai_documenter` per super-grader's integration contract §4: `{schema_version: 1, peer: 'ai_documenter', canvas_user_id, canvas_assignment_id, anon_token, completed_at, summary: {...}, links: {detail_url}}`. Fire-and-forget; skips with `skipped: true` if env vars are absent. Auth via `SUPER_GRADER_INGEST_TOKEN` (our side) matched by `AI_DOCUMENTER_INGEST_TOKEN` (super-grader's side) — same value, set on both Vercel projects.

### 2026-05-08 — Phase 3 slices 1 + 2 shipped; iframe SSO settled on token handoff

*Largely superseded by the 2026-05-11 iframe-removal entry above. Kept for historical context — the iframe SSO design described here is the one we ripped out.*

- **Iframe SSO is token-based, not cookie-based.** Original plan was popup-OAuth + cookie session via `@supabase/ssr`. Real testing in Canvas surfaced the predictable third-party-cookie failure: the popup successfully sets cookies on `student-form.vercel.app` (top-level, no restriction), but the iframe (third-party context inside Canvas) can't *send* those cookies on subsequent requests. Storage Access API didn't reliably bridge it either. Final design: `auth/callback` extracts the Supabase session and `postMessage`s `{access_token, refresh_token}` back to the iframe; iframe stores them in `localStorage` via `getIframeSupabaseClient` (legacy `@supabase/supabase-js`, NOT `@supabase/ssr`'s cookie-based browser client). Server actions take the access token as an explicit arg and verify via `admin.auth.getUser(token)`. Works regardless of cookie policy. Docs in `apps/student-form/src/lib/supabase/iframe-client.ts`.
- **Gemini calls go through raw v1beta REST, not the SDK.** Matches v1's pattern in `Gemini.gs` and keeps the dep surface small. Lives in `packages/gemini/src/chat.ts`. **Gotcha to record:** the URL-context tool key is snake_case (`url_context`) — camelCase is silently ignored, no error, the tool just doesn't run. Diagnosed once, locked in via comment.
- **URL-context grounding is best-effort, not the primary transcript-ingest path.** Gemini's URL-context tool can't reach Gemini's own share pages (and is hit-or-miss for ChatGPT/Claude — many shares are JS-rendered SPAs). Paste-fallback is now the prominent always-visible option in the intake form (was hidden behind a small link); URL-context still runs as best-effort backup. System prompt instructs Gemini to NEVER apologize about transcript-fetch failures and to lead with "tell me what you used the AI for" when it can't see content. Per-provider scrapers tracked as a Phase 6-ish follow-up.
- **`canvas_user_id` lookup deferred to slice 3.** Slice 1 creates `students` rows at SSO without resolving `canvas_user_id` — `anon_token` is computed from email-only (passing `""` for canvas_user_id to `anonToken()`). When slice 3 wires Canvas auto-submit (which needs `as_user_id=<canvas_user_id>`), we look up via the teacher's Canvas token and re-key the token to the canonical `(canvas_user_id, email)` form. No data migration cost — zero production data exists yet.
- **Reinstall handles Canvas comment-stripping.** Canvas's HTML sanitizer strips `<!-- ehs-ai-reflect:* -->` comments on some paths, so the next install couldn't find its own block via marker comments and appended a duplicate. Fix: `findIframeBlockByToken` fallback (matches `<iframe>` elements whose `src` carries the iframe_token), used by `replaceOrAppendIframeBlock` and `removeIframeMarkerBlock` when given a token. Install path now strips ALL pre-existing blocks (marker-wrapped or token-bare) before appending one fresh — cleans up past damage automatically. Iframe `allow` attribute now also includes `storage-access` (for the Storage Access API path we tried; harmless to keep even though we don't rely on it anymore).
- **Dashboard accordion `open` state persists across server-action revalidates.** `revalidatePath("/dashboard")` re-suspends the parent `<Suspense>`, which was remounting `CourseAccordion` and resetting its `open` state — making Reinstall feel like it threw the user back to the dashboard. Fixed via a tiny `useSessionFlag` hook that mirrors `open` to `sessionStorage`.
- **Two follow-ups added to `BUILD_PLAN.md`:** per-provider transcript scrapers; conversation-textarea sizing (currently feels like a one-line input).

### 2026-05-07 — Admin layer, prompt model, objective summary

- **Admin layer (HAH-style).** Added an admin role modeled on Handwritten-Assignment-Helper's `021_add_admin_layer` migration: `admins` table (email-keyed), `is_admin()` SECURITY DEFINER helper, separate `/admin` shell with its own layout, self-bootstrap from `INITIAL_ADMIN_EMAIL` env var on first visit, last-admin-lockout protection on revoke. Admins manage school-wide settings; teachers manage their own courses + personal prompts.
- **Prompt model rewrite: `scope` + `purpose`.** The earlier "each teacher has their own copy of the Default prompt" model was replaced. The `prompts` table now has two orthogonal axes:
  - **`scope`**: `'system'` (admin-edited, shared across all teachers, `teacher_id IS NULL`) or `'teacher'` (the teacher's own personal prompt).
  - **`purpose`**: `'reflection'` (visible to teachers in the install picker) or `'objective_summary'` (admin infrastructure, never shown to teachers).
  - **RLS**: scope-aware. Teachers see system prompts + their own teacher prompts. Edits are admin-only for system, owner-only for teacher.
  - **Migration rolled the prior per-teacher Defaults into one shared system Default.** `teacher_assignments.prompt_id` and `course_install_policies.default_prompt_id` rebound during the migration.
- **Posture shift on prompt control.** Original 2026-04-23 scope said "per-teacher prompts; adoption is grassroots." Refined: there's a **shared system Default** the school controls (admin-edited), plus a **per-teacher personal prompts library** anyone can build on top of. Grassroots adoption still works (teachers don't need admin help), but the school speaks with one voice on the Default.
- **Objective summary** of student AI use. New deliverable, generated server-side after each reflection completes via a separate Gemini call. Prompt is admin-edited (`scope='system' AND purpose='objective_summary'`); teachers can't write or edit it. Output is ~100 words of descriptive prose ("the student asked for three thesis options on Anna Karenina's moral arc; used the second with light edits"), explicitly not evaluative ("the student's use was inappropriate"). Both teacher and student see it on the Canvas submission.
- **Canvas submission body now contains three artifacts** (was: reflection transcript only):
  1. The reflection transcript (Socratic conversation)
  2. A link to the full AI transcript(s)
  3. The objective summary
  Same payload also goes to AI Documenter's DB and to super-grader via the existing `/api/ingest/ai_documenter` webhook.
- **Active-term sync filter.** Canvas sync only fetches assignments for courses in the current academic year (term-name prefix derived from today's date — e.g., `2025/2026` from May 2026). Older courses remain in the cache as listings only; their assignments aren't refreshed. Cut typical sync time roughly 10x.
- **Cached-by-default Canvas data.** Two new tables: `canvas_course_cache` and `canvas_assignment_cache`, populated by a sync utility called from a manual "Refresh now" button + a nightly Vercel cron at `/api/cron/sync-all-teachers`. The dashboard reads from cache; live Canvas calls happen only during install/uninstall and on Refresh.
- **Phase 4 design locked** (not yet built). One page per assignment at `/dashboard/reviews/[course-id]/[assignment-id]`. All students rendered top-to-bottom in a single scroll. Each student card shows the objective summary + the full reflection conversation, both always visible (no toggling); the AI transcript stays collapsed (click `▸` to expand inline — no modals, no new pages). Page-level navigation: `j` / `k` keyboard shortcuts, sticky `12 of 24 · jump to ▼` student picker, filter by status, search by name. "Not started" footer pulls Canvas roster to flag who hasn't completed.
- **Prompt registry ownership flipped: AI Documenter canonical, super-grader mirrors.** The earlier integration contract had super-grader as the cross-tool prompt-management hub (one row per peer prompt; admins edit in super-grader, peers fetch via `GET /api/prompts?owner=...`). After today's admin-layer build, that's inverted for the objective-summary prompt: it now lives canonically in AI Documenter's `prompts` table (admin-edited via `/admin/prompts`). AI-Documenter-side work (see BUILD_PLAN follow-ups): expose a GET endpoint super-grader can pull from. Super-grader-side work tracked in super-grader's repo. AI Documenter's `packages/prompts/` (super-grader registry fetcher) stays around for any future cross-tool prompts where super-grader is canonical.
- **Canvas submission dedup via sentinel marker.** When AI Documenter auto-submits a reflection to Canvas (Phase 3 step 7), the submission body has both the student's reflection content AND looks identical to "a Canvas submission" from super-grader's perspective when it scrapes Canvas for grading. To prevent super-grader from treating AI Documenter's auto-submissions as student work, the submission body will be prepended with a sentinel HTML comment: `<!-- ai-documenter:reflection v=1 iframe-token=... -->`. Same shape as the iframe install marker. Super-grader's Canvas-scrape pipeline filters these out and uses the webhook envelope as the canonical source instead. AI-Documenter-side work: emit the marker (Phase 3). Super-grader-side filter logic tracked in super-grader's repo.

### 2026-05-06

- **"Install for you" via teacher's Canvas API token.** Replaces the original "copy this iframe snippet into your assignment description" UX with a one-click flow: teacher picks an assignment in our dashboard, our backend uses their stored Canvas API token to PUT the iframe directly into the assignment's description. The copy-paste path is kept as a hidden fallback for when the API write fails. Same token covers student auto-submit (the original use), so no extra friction.
- **Bulk install + auto-install policy** (spec'd in BUILD_PLAN §2.2). Teacher can multi-select assignments to install on, plus toggle "auto-install on every new assignment in this course." A nightly reconciliation cron walks policy-enabled courses and installs the iframe on newly-created published assignments. Idempotency via HTML marker comments around the iframe (`<!-- ehs-ai-reflect:begin ... --> ... <!-- ehs-ai-reflect:end -->`) so re-running replaces in place.
- **Multi-chat / multi-tool intake.** Single share-link replaced by a list of `(tool, url)` rows so a student who used Gemini once and ChatGPT three times can record all four. Schema reflects this — `reflection_sessions.ai_chats jsonb` replaces the old `ai_transcript_url` + `ai_transcript_text` columns.
- **Time-spent estimate.** New required field on the intake screen — six bands: `lt15`, `15_30`, `30_45`, `45_60`, `1_2h`, `gt2h`. Stored as `reflection_sessions.time_spent_estimate text` with a CHECK constraint.
- **Paste-fallback retained** (decided 2026-04-27, design refined 2026-05-06). Coexists with the URL list rather than replacing it; expandable section below the list. Stored separately in `reflection_sessions.paste_fallback_text` so we can tell which chats had link extraction vs. raw paste.
- **Per-tool prompt registry alignment.** *Superseded 2026-05-07.* The earlier note said the objective summary prompt lived in super-grader's `prompts` table; it now lives in our own `prompts` table with `purpose='objective_summary'`, edited by admins.

## Scope & constraints

- **Scale target:** whole-of-EHS (every teacher, every assignment). Ceiling, not current load — must be robust enough to reach it.
- **School:** EHS only.
- **Canvas integration:** mandatory-feeling to the maximum extent possible. **LTI is out of scope** (too much work). Pattern is **branded reflection card in the assignment description** linking to a standalone web app + Canvas API auto-submit on the student's behalf. *Original 2026-04-23 plan said iframe-in-assignment; that approach was retired on 2026-05-11 — see Refinements.*
- **Reflection style:** Socratic coaching. Goal is to get the student thinking more deeply about their AI use — not interrogation, not grading.
- **Prompt control:** mixed. School-wide **system prompts** are admin-edited and shared across teachers (the seeded **Default** lives here, plus the **Objective Summary** generator). On top of that, every teacher has a **personal prompts library** they manage themselves. Teachers pick which prompt to apply at install time. Adoption is still grassroots — teachers can use the system Default with zero admin involvement.
- **Transcript ingest:** link-based (Gemini / ChatGPT / Claude share links), replacing paste-in.
- **Billing:** centralized — EHS pays for the Gemini key behind our backend.
- **Student auth:** Google SSO via EHS Workspace accounts.
- **Reflection mode:** written only. ~~Oral mode was originally in scope~~ — cut 2026-05-12. The Gemini Live audio path didn't add enough over a typed paragraph to justify the WebSocket relay + mic/audio handling + STT-review UX complexity.
- **PII / FERPA:** student names, emails, and any other identifiers must **never** reach Gemini. An anonymization layer sits at the boundary — `Student_xxxxxx` tokens go out, real names come back to the teacher view. Pattern adapted from Canvas-Agent + Students of Concern Dashboard (HMAC-derived stable tokens, server-side reverse mapping). See `BUILD_PLAN.md` for the design.
- **Retention:** one academic year. End-of-year sweep clears reflection data.
- **Multi-tool per assignment:** yes — one assignment can cover Gemini + ChatGPT + Claude use in the same reflection.
- **Teacher review:** full visibility — teachers see the student's original AI transcript, the full Socratic reflection, and the final submission.
- **Canvas submission body:** three artifacts inline — reflection transcript, link to the student's full AI transcript(s), and the objective summary. Posted as an *additional* submission alongside the student's actual work, not as a replacement. Long transcripts are fine — they won't hit Canvas size limits in practice.

## Architecture decision

**Next.js + Supabase on Vercel.** Rationale:

- Apps Script doesn't fit the shape anymore: multi-tenant storage, conversation history too big for Sheets cells (50k limit), Canvas API calls and background work.
- Supabase → Postgres + auth + row-level security for per-teacher data isolation.
- Vercel → one deployment serves both the teacher dashboard and the standalone student reflection surface (single merged Next.js app, as of 2026-05-11).
- Incremental cost at our scale: ~$20–40/mo beyond the centralized Gemini key.

Alternative considered: Cloud Run + Firestore (stays in Google's ecosystem). Similar capability, slightly more setup.

## Canvas integration pattern (the "mandatory without LTI" trick)

*Updated 2026-05-11: this is now card-based, not iframe-based.*

1. Teacher creates a Canvas assignment, submission type **"Online — Text Entry"**.
2. Teacher hits **Install** in our dashboard; backend PUTs a branded **reflection card** (EHS logo + maroon CTA) into the assignment's description via Canvas API. Idempotent via marker comments (`<!-- ehs-ai-reflect:begin v=2 iframe-token=... -->`) with bare-card-by-token fallback for Canvas's comment-stripping paths.
3. Student in Canvas clicks **Open reflection →**; the standalone reflection app opens at `https://<host>/r/<token>` (new tab).
4. Student signs in with Google (EHS Workspace), completes intake (chat URLs + time + first draft) + Socratic conversation (objective summary + alignment Q + hardcoded final Q + closing).
5. **On completion, backend auto-submits to Canvas on the student's behalf** via Canvas's `as_user_id` masquerade with the teacher's stored API token. Submission body: first draft + objective summary + Socratic Q&A + AI chat links. Prepended sentinel marker so super-grader's Canvas-scrape pipeline skips it (canonical content arrives via the webhook).
6. Fallback when API post fails: a 6-character completion code the student pastes into Canvas manually.

To the student, the loop feels mandatory because the card visually anchors the reflection inside the assignment and the auto-submit lands without their action. The iframe contortions (popup OAuth, postMessage token handoff, localStorage tokens) are gone.

## Teacher install flow

1. Teacher signs in with Google (EHS Workspace).
2. Pastes their Canvas API token once at `/dashboard/setup`.
3. Picks Canvas course → assignments (via cached Canvas data; live API only on Refresh).
4. Picks a reflection prompt (system Default, or a personal teacher prompt). Each prompt carries a short `student_facing_question` (shown to the student) plus a longer `body` (Gemini system prompt).
5. Backend PUTs the EHS reflection card into the assignment description; idempotent on reinstall.

## Reflection conversation design (open questions)

These were flagged but not decided:

- Who starts — does Gemini open with a Socratic question, or does the student type first?
- Turn limit vs. dynamic end condition. Probably 3–5 exchanges with a "dig deeper" escalation for shallow responses.
- What Gemini sees each turn: transcript, assignment context, possibly the submitted work itself (pulled from Canvas submission API), conversation history, teacher's system prompt.
- Who can revisit the conversation after the fact — teacher only, or student too?
- **Prompt UI: raw editor with a single prefilled default template** (decided 2026-04-27). Hugh will write the default. No template library / picker.

Worth mocking 2–3 example "good" reflection transcripts before building the prompt system.

## Transcript ingest — open questions

- Robust extraction: hand the URL to Gemini with URL context grounding (works across providers, costs an extra call) vs. per-provider HTML scrapers (cheaper, more brittle).
- Validate URL is public + non-empty at submit time — big quality win over v1's paste-in.
- **Paste-in fallback: yes** (decided 2026-04-27). Kept as a backup path for unsupported tools / private links.

## Subrepo layout (current)

```
/v2/
  /apps/
    teacher-admin/       # merged Next.js 16 app — serves /dashboard, /admin,
                         # AND /r/<token> (student-side). Directory name is
                         # historical; renaming flagged but deferred.
                         #   /(student)/r/[token]    — standalone reflection
                         #   /dashboard/*            — teacher
                         #   /admin/*                — admin
                         #   /auth/login | callback  — unified, cookie-based
  /packages/
    db/                  # Supabase schema, migrations, generated types
    canvas/              # Canvas API client + reflection-card install marker
                         # + submitTextEntryAsStudent + roster lookup
    crypto/              # AES-256-GCM at-rest secret encryption
    anonymizer/          # Student_xxxxxx tokens + name-redaction scrubbers
    prompts/             # super-grader prompt-registry fetcher (legacy)
    gemini/              # Gemini v1beta REST chat wrapper
  /supabase/migrations/  # versioned SQL (11 migrations as of 2026-05-11)
```

`packages/transcript-ingest/` is still planned (per-provider share-link scrapers, Phase 6 follow-up). The pre-2026-05-11 `apps/student-form/` is deleted.

## Next session starting points

Phases 1, 2, 2.2 are all live (see [`BUILD_PLAN.md`](./BUILD_PLAN.md) status snapshot). Phase 4 is designed (see Refinements above) but not yet built. Phase 3 is the biggest unbuilt chunk.

1. **Phase 3 — real student form.** Gemini-backed Socratic conversation, anonymizer at every Gemini boundary, multi-chat intake, persist to `reflection_sessions`, on-completion Canvas auto-submit + super-grader webhook + objective-summary generation. Roughly 3–5x the scope of what's been built so far.
2. **Phase 4 — teacher review surface.** Per-assignment reading view at `/dashboard/reviews/[course-id]/[assignment-id]`. Design is locked (see Refinements 2026-05-07); needs Phase 3 populating real data before it's useful.
3. **Production deploy of today's work.** Set Vercel env vars (`NEXT_PUBLIC_STUDENT_FORM_URL`, `INITIAL_ADMIN_EMAIL`, `ADMIN_EMAIL_DOMAIN`, `CRON_SECRET`) on the teacher-admin project, then `vercel deploy --prod` to flip the deployed app from "mock dashboard" to all of today's real flows.
