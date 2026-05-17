# AI Documenter v2

Successor to the v1 Apps Script tool. Planning + scope live in [`CLAUDE.md`](./CLAUDE.md). Phase status, schema, and design specs live in [`BUILD_PLAN.md`](./BUILD_PLAN.md).

## Status (2026-05-11)

**Single merged Next.js app, end-to-end live.** The original two-app split (`student-form` iframe + `teacher-admin` standalone) was retired on 2026-05-11; the student surface is now a standalone web app linked from a branded EHS reflection card in the Canvas assignment description. Phase C, Phase D, the super-grader-facing GET endpoints, the auto-install policy + nightly sweep, and Phase F hardening (retention with CSV export, Sentry, per-teacher Gemini rate limits, Canvas roster sync + free-text PII scrub) are all shipped. Phase E (oral mode) was cut.

Vercel deploys are still manual (`vercel deploy --prod` from `v2/`). Single project, single link — no more dual-deploy gymnastics.

| Surface | URL |
|---|---|
| Merged app | https://ai-documenter-v2-teacher-admin.vercel.app — serves `/` (sign-in), `/dashboard/*`, `/admin/*`, **and `/r/<token>` (standalone student reflection)** |
| Vercel project | `ai-documenter-v2` (id `prj_idk1viMrPc3If6EEzDRjROPkxD63`). Project renamed from `…-teacher-admin` 2026-05-11; default `.vercel.app` URL kept since the new one was claimed elsewhere on the platform. |
| Supabase project | `ai-documenter-v2` (id `exuqndgtwqwezbmfansr`, us-east-1) — RLS on every public table |
| Canvas test | install/uninstall + auto-submit verified end-to-end on real EHS assignments |

## What works end-to-end (in production, today)

**Teacher side:**
- **Auth** — Google SSO (Supabase Auth), `hd=episcopalhighschool.org` domain enforced server-side, teachers row auto-upserted on first login.
- **Canvas connect** — paste API token at `/dashboard/setup`, verified live against `/users/self`, encrypted at rest with AES-256-GCM.
- **Canvas data sync** — first-load sync into `canvas_course_cache` + `canvas_assignment_cache`. Active-term filter (current academic year only). Manual **Refresh** button in the header + nightly Vercel cron (`vercel.json` → `/api/cron/sync-all-teachers`, schedule `0 8 * * *`).
- **Dashboard accordion** — active-term courses in the main list (with assignments), older + empty courses in the "Other courses" expander. Search, multi-select, install / uninstall / reinstall via the bulk-action bar. Auto-install toggle UI present (persistence pending). Open-state persists in `sessionStorage` so revalidate-driven remounts don't collapse it.
- **Install action** — picks a prompt (system or per-teacher), splices the **branded EHS reflection card** (logo + maroon CTA, marker `v=2`) into the Canvas description, PUTs back, persists `assignment_install_state`. Reinstall handles Canvas's HTML-comment stripping via three fallback paths (marker comments → bare-card-by-token → legacy bare-iframe-by-token); strips ALL pre-existing blocks before appending fresh, so past duplicates and pre-M2 iframe installs self-clean.
- **Prompts library** —
  - Per-teacher personal prompts at `/dashboard/prompts` (create, edit, delete with auto-uninstall). Each prompt has a short `student_facing_question` (shown to students) plus a longer `body` (Gemini system prompt).
  - Read-only system prompts above on the same page; admins get an "Edit in admin →" link.
- **Admin layer** — `/admin` shell self-bootstraps from `INITIAL_ADMIN_EMAIL`; `/admin/prompts` (Reflection prompts CRUD + admin-only Objective Summary prompt — both with `student_facing_question` field); `/admin/admins` (grant/revoke with last-admin lockout).

**Student side (standalone web app at `/r/<token>`, no iframe):**
- **Entry** — `app/(student)/r/[token]/page.tsx` resolves the token → `teacher_assignment` + bound prompt + course/assignment names; renders BrokenLink view for invalid tokens.
- **Cookie-based SSO** — `/auth/login?next=/r/<token>` redirects to Google; unified `/auth/callback` exchanges the code, validates EHS domain, upserts as student or teacher depending on the `next` prefix. Standard `@supabase/ssr` cookie session throughout. No popup, no postMessage, no localStorage tokens.
- **Intake** — multi-chat URL list with allow-list URL validation per provider (Gemini/ChatGPT/Claude); always-visible paste-fallback (the reliable path); 6-band time-spent picker; **first-draft paragraph (≥50 chars, locked on submit)**.
- **Conversation (redesigned 2026-05-11)** — chatbot UI. Bootstrap fires two Gemini calls: objective summary (using the `objective_summary` system prompt) + alignment question (using the reflection prompt). Student answers; orchestrator hardcodes Q2 ("What have you learned… will you do differently next time?"); student answers; Gemini generates a warm closing. Two student turns total, three Gemini calls. Chat bubbles, `rows=6` Composer, "Reflection Partner" label on the first AI bubble, thinking dots, auto-scroll. First draft renders as the opening student bubble.
- **Closing pipeline** — on completion, `finalizeReflection` runs: Canvas auto-submit with `as_user_id` masquerade + sentinel marker (body = first draft + objective summary + Socratic Q&A + AI chat links); `canvas_user_id` backfill via roster lookup + `anon_token` re-key; fire-and-forget super-grader webhook (integration-contract §4 envelope). Done-state UI: "Submitted to Canvas" or completion-code fallback.

**Teacher review surface (Phase D, shipped 2026-05-12):**
- **Reviews index** at `/dashboard/reviews` — assignments-with-reflections grouped by course, with total / submitted / failed / in-progress counts. Linked from the dashboard header nav. Empty assignments are hidden until a student touches them.
- **Per-assignment page** at `/dashboard/reviews/[courseId]/[assignmentId]` — every student rendered top-to-bottom in a single scroll. Each card shows real name, state badge, time-spent, tools used, first draft, objective summary, full reflection Q&A, plus a collapsed `▸ AI transcript` expander with share links + pasted transcript inline. "Open in Canvas ↗" deep-links to the submission. "Resend to Canvas" button appears when the most recent submission attempt failed (wired to `resendToCanvas` server action, reusing `submitReflectionToCanvas`).
- **Page nav** — sticky filter bar (All / Submitted / Failed / In progress + name search), `N of M · jump to ▼` student picker, `j`/`k` keyboard shortcuts (suppressed while typing).
- **Entry from dashboard** — each installed assignment row with ≥1 reflection grows a "View N reflections →" link inline.

## Repo layout

```
v2/
  apps/
    teacher-admin/        Next.js 16 — merged app (directory name historical)
                          ├ /                                        teacher sign-in landing
                          ├ /auth/login | callback | logout          unified cookie-based OAuth
                          ├ /(student)/r/[token]                     standalone student reflection
                          ├ /dashboard                               accordion of active courses
                          ├ /dashboard/setup                         Canvas connect
                          ├ /dashboard/prompts                       personal + system prompts
                          ├ /dashboard/reviews                       index of assignments-with-reflections
                          ├ /dashboard/reviews/[c]/[a]               per-assignment scroll (Phase D)
                          ├ /dashboard/retention                     teacher CSV export + hard delete
                          ├ /admin/retention                         admin school-wide retention
                          ├ /admin                                   admin index (admins only)
                          ├ /admin/prompts                           system prompt CRUD
                          ├ /admin/admins                            grant/revoke admins
                          ├ /api/cron/sync-all-teachers              nightly Canvas sync + auto-install sweep
                          ├ /api/super-grader/prompts/objective_summary  GET — canonical prompt mirror
                          ├ /api/super-grader/result                 GET — keyed on canvas_user_id + canvas_assignment_id
                          ├ /brand/ehs-horizontal.webp               EHS logo asset (in /public)
                          └ src/lib/finalize/                        closing-pipeline helpers
  packages/
    anonymizer/           HMAC tokens + name-redaction scrubbers (30 tests)
    crypto/               AES-256-GCM at-rest secret encryption (10 tests)
    canvas/               REST client + reflection-card install marker (32 tests)
                          + submitTextEntryAsStudent + lookupCourseStudentByEmail
    prompts/              fetcher for super-grader's prompt registry (11 tests)
    gemini/               Gemini v1beta REST chat wrapper (URL-context, thinking config)
    db/                   typed Supabase clients + generated Database type
  supabase/
    migrations/           11 versioned SQL migrations
  CLAUDE.md               scope + decisions log
  BUILD_PLAN.md           phase status, schema, design specs
  .env.example            env template
```

Monorepo via pnpm workspaces. `apps/student-form/` was deleted 2026-05-11; everything merged into `apps/teacher-admin/`.

## What's pending

| Item | Where | Notes |
|---|---|---|
| **"Not started" footer on review pages** | `/dashboard/reviews/[courseId]/[assignmentId]/page.tsx` | Roster source (`course_rosters`) now exists from Phase F — surfacing the not-started list is a 30-min job that wasn't bundled in. |
| **Teacher onboarding** | 1-pager + 3-min video | Non-code. Out of repo. |
| **Per-provider transcript scrapers** | `packages/transcript-ingest` (planned) | Paste-fallback is the reliable path; URL-context grounding is best-effort. |
| **Delete legacy Vercel projects** | dashboard | `ai-documenter-v2-student-form` + `student-form` orphan. MCP doesn't expose project deletion. |
| **Custom domain** | dashboard | `reflect.episcopalhighschool.org` or similar — long-term clean URL. |

## Secrets

> **Policy: `.env.example` is the canonical source of truth.** If you add a
> new env var in code, add it to `.env.example` in the same PR. If you rename
> one on Vercel, rename it in `.env.example` too. When the two disagree,
> `.env.example` wins — Vercel and code should be brought in line, not the
> other way around.

### Shared-ecosystem secrets

AI Documenter is one of several "satellite" tools that integrate with the
Super Grader project. Some secret *values* are **shared** across projects,
but each project names them after who it's talking to.

| Value | Where it lives | What it does |
|---|---|---|
| **Anonymization salt** | `SUPER_GRADER_SALT` in **AI Documenter**, **Super Grader**, **Handwritten Helper** | HMAC salt for the `anon_token`s that cross between tools. Same name everywhere. Never regenerate — invalidates every stored token. |
| **AI Doc inbound bearer** | `AI_DOCUMENTER_API_TOKEN` in both **AI Documenter** and **Super Grader** | Same name on both sides. AI Doc accepts requests carrying this bearer; Super Grader presents it on outbound GETs to `/api/super-grader/*`. |
| **AI Doc outbound bearer** | `SUPER_GRADER_INGEST_TOKEN` in **AI Documenter**, but `AI_DOCUMENTER_INGEST_TOKEN` in **Super Grader** | Asymmetric: we name after the partner we're authing TO; SG names after the peer authing IN. Same value, two perspectives. |
| **Gemini API key** | `GEMINI_API_KEY` everywhere | One key, central billing, same name in every project. |

**Mental model.** The name on **your side** describes who **you** are talking
to. The name on **the other side** describes who **they** are listening to.
That's why the same bearer is `SUPER_GRADER_INGEST_TOKEN` in AI Doc (the
token I present to Super Grader) and `AI_DOCUMENTER_INGEST_TOKEN` in Super
Grader (the token I expect from AI Documenter).

### Cross-project setup order

When provisioning a fresh deployment, set secrets in this order to avoid
"why is the other tool 401-ing me?" debugging:

1. `SUPER_GRADER_SALT` — generate once (the project deployed first owns it);
   copy verbatim to every other project. Never regenerate.
2. Inbound bearer (`AI_DOCUMENTER_API_TOKEN`) — generate fresh, set on both
   this project and Super Grader.
3. Outbound bearer (`SUPER_GRADER_INGEST_TOKEN` here = Super Grader's
   `AI_DOCUMENTER_INGEST_TOKEN`) — generate fresh, set on both sides.
4. `SUPER_GRADER_API_URL` — set once super-grader has a URL.

### Deployed var reference

Set on the Vercel `ai-documenter-v2` project (Production + Preview):

| Var | Notes |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Supabase anon key |
| `SUPABASE_SERVICE_ROLE_KEY` | service-role; admin client only |
| `CANVAS_TOKEN_ENC_KEY` | AES-256-GCM key for teacher Canvas tokens |
| `SUPER_GRADER_SALT` | shared anon-token salt across the EHS ecosystem |
| `INITIAL_ADMIN_EMAIL` + `ADMIN_EMAIL_DOMAIN` | admin self-bootstrap on first visit |
| `CRON_SECRET` | bearer auth for `/api/cron/*` |
| `NEXT_PUBLIC_APP_URL` | `https://ai-documenter-v2-teacher-admin.vercel.app` — used by the install action to build the card's `href` + logo `src`, and by the outbound super-grader webhook for `links.detail_url`. |
| `NEXT_PUBLIC_STUDENT_FORM_URL` | Legacy name for the same value (predates the merge with student-form). Code reads `NEXT_PUBLIC_APP_URL` first and falls back to this for one cycle (M4.3 transition). Drop once every deploy environment has been migrated. |
| `GEMINI_API_KEY` | Sensitive. Locally, Hugh's `~/.zshrc` exports it; Vercel needs it explicitly. |
| `GEMINI_MODEL` | optional; defaults to `gemini-3-flash-preview` |
| `SUPER_GRADER_API_URL` | `https://super-grader.vercel.app` — webhook target |
| `SUPER_GRADER_INGEST_TOKEN` | Sensitive. Must equal super-grader's `AI_DOCUMENTER_INGEST_TOKEN`. |
| `AI_DOCUMENTER_API_TOKEN` | Sensitive. Bearer presented by super-grader on `GET /api/super-grader/*` calls. Same value, same name on super-grader's side. |
| `GEMINI_DEFAULT_DAILY_CAP` | Optional integer. Per-teacher daily Gemini-call cap; falls back to 500 if unset. Per-teacher override via `teachers.gemini_daily_cap`. |
| `SENTRY_DSN` | Optional. Server-side Sentry DSN. Missing = no events, no perf overhead. |
| `NEXT_PUBLIC_SENTRY_DSN` | Optional. Browser-side Sentry DSN. Usually the same project, separate DSN. |

### When you add a new secret

1. Add the var to `.env.example` with a comment explaining what it is,
   where the value comes from, and what happens if it's missing
2. Read it via `process.env.VAR_NAME`; fail loudly when required and unset
3. Run `vercel env add VAR_NAME production` (and `preview`, `development`
   if the value differs across environments)
4. If shared with another project in this ecosystem, update the
   cross-project mapping above and the partner project's `.env.example`

## Run locally

```sh
cd v2
```

```sh
pnpm install
```

```sh
pnpm dev
```

```sh
pnpm test
```

```sh
pnpm --filter @ai-documenter/db typecheck
```

The merged app runs on `:3001`. `.env.local` lives at `v2/.env.local`. `GEMINI_API_KEY` can also come from a shell `export` (Hugh's is in `~/.zshrc`); Next.js inherits the shell env so either source works.

**Supabase auth redirect allowlist:** for local OAuth to round-trip back to localhost, `http://localhost:3001/**` must be in Supabase project → Authentication → URL Configuration → Redirect URLs. Without it, `/auth/callback` lands on production instead, drops the `next` param, and student-flow sign-ins get routed to the teacher path.

## Deploying to production

Single Vercel project (`ai-documenter-v2`), single link. The dual-deploy ergonomics gripe is gone post-merge.

1. Set any new env vars on the Vercel project via the dashboard (bulk paste is fastest; secrets get marked **Sensitive** — note this excludes them from Vercel's Development scope, but that's fine since local dev reads from `v2/.env.local`).

2. Confirm the link, then deploy from the monorepo root:

   ```sh
   cd v2 && vercel link --project ai-documenter-v2 --yes
   ```

   ```sh
   cd v2 && vercel deploy --prod
   ```

   **Don't deploy from the app dir** (`apps/teacher-admin/`) — only the subdir gets uploaded, which misses `pnpm-lock.yaml` and the workspace deps fail to install.

3. On first deploy, the `admins` table self-bootstraps from `INITIAL_ADMIN_EMAIL` on the first visit to `/admin`. Subsequent admins are granted via `/admin/admins`.

## Notes worth keeping in mind

- **Schema regen:** when applying a Supabase migration, also save the SQL to `supabase/migrations/<timestamp>_<name>.sql` and regenerate `packages/db/src/database.types.ts` via the Supabase MCP. They get out of sync silently otherwise.
- **Cross-tool join key:** the `Student_xxxxxx` token shared with super-grader depends on `SUPER_GRADER_SALT` matching exactly. Generating a new salt for v2 silently breaks the join — always pull super-grader's value, never generate.
- **Reflection card format:** the `<!-- ehs-ai-reflect:begin v=2 iframe-token=... prompt-version=N -->` marker shape is the source of truth for idempotency. Don't change without a versioned migration. The submission-side sentinel `<!-- ai-documenter:reflection v=1 iframe-token=... -->` is a separate marker that super-grader's Canvas scrape uses to skip our auto-submissions.
- **Gemini 3 Flash thinking tokens:** count against the same `maxOutputTokens` budget as output text. All three reflection-flow calls cap at 4096 — anything below ~2k can truncate visible replies mid-sentence.
- **Two Supabase memory gotchas worth knowing** (saved in user-level memory but worth surfacing here too):
  - RLS policies that call helper functions need EXECUTE granted to `authenticated` — revoking it silently empties query results without an error from supabase-js.
  - Next 16 `"use server"` files can only export async functions; non-function exports invalidate every export silently.
- **Vercel "Sensitive" + Development scope are incompatible.** A var can be Sensitive (Production + Preview, can't be pulled back) OR exposed in Development scope (pullable via `vercel env pull`), not both. Local dev should use `v2/.env.local` directly instead of relying on `vercel env pull` for sensitive vars.
