# AID — Auth + AuthZ + RLS + token security audit

**Scope:** unified OAuth callback, role inference via `next` prefix, session helpers
(`teacher.ts`/`student.ts`/`admin.ts`), Supabase server + proxy clients, admin grant/
revoke flow, `/r/<token>` token-gated student flow, iframe-token resolution, RLS
policies on every public-schema table, SECURITY DEFINER helper functions, service-role
usage at every call site, super-grader inbound API auth.

**Date:** 2026-05-21
**Branch:** main
**Auditor lens:** five suite-wide root causes (snapshot semantics, state fences,
transactional boundaries, fail-open, idempotency). For an auth/RLS audit, root cause
#4 (fail-open) dominates — most findings sit on that lens.

Severity scale: **critical** (authz bypass, privilege escalation across role boundary),
**high** (cross-tenant data exposure, role confusion in production paths), **medium**
(DoS / hardening / abuse avenues with limited blast radius), **low** (defense-in-depth /
nits / future-proofing).

---

## 1. Any EHS-domain user can self-elevate to "teacher" role — **high**

**Files:** `apps/teacher-admin/src/app/auth/callback/route.ts:50-79`,
`apps/teacher-admin/src/app/dashboard/layout.tsx:11`,
`apps/teacher-admin/src/lib/auth/teacher.ts:15-32`

The unified `/auth/callback` decides role membership purely from the `next` query
param: `next.startsWith("/r/")` → upsert into `students`; everything else →
service-role upsert into `teachers`. There is no check that the authenticated user
is actually a teacher at EHS (e.g., against a teacher allowlist or a Canvas-side role
attestation). The only filter is the `@episcopalhighschool.org` domain on the email,
which every EHS student also satisfies.

### Scenario

1. EHS student visits `/auth/login` directly (or any unauth-redirected route under
   `/dashboard/*` — proxy.ts:25-33 builds `?next=<path>` for the homepage's
   login link).
2. Default `next = "/dashboard"` — does NOT start with `/r/`.
3. Callback (line 50) takes the teacher branch: `createAdminDbClient().from("teachers").upsert(...)` inserts the student's auth_user_id into the `teachers` table.
4. `getCurrentTeacher()` in the dashboard layout finds the row → student is treated
   as a teacher everywhere in `/dashboard/*` and `/admin/*` (subject to admin
   gating).
5. The student now sees `/dashboard/setup` and can paste a Canvas API token
   (`apps/teacher-admin/src/lib/actions/canvas-token.ts:10-54`) — `connectCanvas`
   calls `getSelf()` to verify it but only against a "is this a valid token"
   constraint, not "is the token holder a teacher".

### Why this is "high" not "critical"

Canvas itself enforces RBAC on API tokens — a student's Canvas token can read their
own enrollments and submissions but typically cannot PUT `assignment.description`
(which is what install actually does), so the `canvas-install.ts` flow will fail at
the Canvas-API layer for a real student. The practical exposure surface is limited
to the AID dashboard itself: a self-promoted "teacher" can read/edit their own
(empty) prompts library, see card-text defaults, edit their own teachers row, etc.
They cannot read another teacher's data because every dashboard read path is
anchored on `teacher.id = self`.

### Larger downstream effect — both rows coexist

`teachers.auth_user_id` and `students.auth_user_id` are independent UNIQUE
constraints — both tables can carry a row for the same auth.users id. So a student
who walks through both paths (first the teacher path, then `/r/<token>`) ends up
with rows in BOTH tables. The teacher gating then sees them as a teacher; the
`/r/` page sees them as a student. This is the suite-wide auth-callback footgun
called out in the audit prompt.

### Fix direction

Two layers, both worthwhile:

1. **Add a teachers allowlist.** Either a `teachers_allowlist` table maintained by
   admins (parallel to `admins`), or a one-time invite flow (admin emails a magic
   link → the link is the only way to land in the teacher upsert path). Match the
   `admins` table shape: `email PRIMARY KEY, active BOOLEAN, granted_by_email`.
   In the callback, when `!isStudentFlow`, check the allowlist before the upsert;
   on miss, sign the user out and redirect to `/?auth_error=not_a_teacher`. This
   is also what HAH/OE/HH should do — the auth-callback fork is identical across
   the suite.
2. **Make the two upsert paths mutually exclusive.** When upserting as teacher,
   check `students.auth_user_id` first; if present, surface
   `auth_error=role_conflict` and refuse. Symmetrically on the student side.
   Choosing your role for life on first login is unusual but matches how the
   system is documented (CLAUDE.md line 28). Today both rows can coexist silently.

---

## 2. `/r/<token>` does not check that the auth'd student is on the assignment's roster — **medium**

**Files:** `apps/teacher-admin/src/app/(student)/r/[token]/page.tsx:18-44`,
`apps/teacher-admin/src/lib/iframe/resolve.ts:18-58`,
`apps/teacher-admin/src/lib/actions/session.ts:25-91`,
`apps/teacher-admin/src/lib/actions/intake.ts:79-100`,
`apps/teacher-admin/src/lib/actions/socratic.ts:50-72`

Anyone signed in with an EHS Google account who knows or guesses a valid 32-char
`iframe_token` can:
- Resolve the assignment context (course name, assignment name, the full prompt
  body — including any system or teacher prompt content).
- Create a `reflection_sessions` row tied to themselves on that
  teacher_assignment_id (intake.ts line 102-127).
- Drive the full Socratic conversation, which costs three Gemini calls billed to
  the centralized EHS-paid key (socratic.ts) and counts against the OWNER teacher's
  per-teacher `gemini_usage_daily` cap (migration 20260512110000).
- Finalize only fails at `lookupCourseStudentByEmail` (canvas-submit.ts line 98-107)
  — Canvas itself rejects the as_user_id POST because the student isn't on that
  course's roster.

`teacher_assignments.iframe_token = randomUUID().replaceAll("-", "")` (canvas-install.ts:409)
gives ~122 bits of entropy. Not brute-forceable, but tokens leak via Canvas
description copy/paste, shared screenshots, leaked browser history. The CLAUDE.md
design accepts "the URL is in Canvas, the URL is public-ish" — but the design
predates the per-teacher Gemini cap and assumes only valid roster members would
ever encounter the URL.

### What this enables

1. **Quota exhaustion DoS** — a malicious EHS student in course A who happens to
   see a teacher's `/r/<token>` URL for course B can drive the full reflection
   loop. Each completed reflection consumes 3 Gemini calls. The default cap is
   500/day per teacher. ~167 hostile reflections exhaust the victim teacher's day
   and block all that teacher's real students from completing reflections.
2. **Information disclosure** — the `prompt.body` (full Gemini system prompt) is
   returned to the browser via `resolveIframeToken`. For teachers who write
   custom reflection prompts containing course-specific context, that content
   leaks to any EHS student with the URL. For system prompts this is a
   non-issue.
3. **Cross-class pollution of teacher review surface** — a non-rostered "student"
   reflection lands in `reflection_sessions` and appears in the teacher's
   `/dashboard/reviews/<course>/<assignment>` view (load.ts:74-78). The
   teacher sees an extra row with a stranger's display_name + email; the
   finalize did fail so `canvas_submission_id` is null, but the row is there.

### Fix direction

In `resolveIframeToken` (or as a separate gate at session.ts/intake.ts/socratic.ts
entry), look up the auth'd student against `course_rosters`:

```
const { data: roster } = await admin
  .from("course_rosters")
  .select("students")
  .eq("teacher_id", ta.teacher_id)
  .eq("canvas_course_id", ta.canvas_course_id)
  .maybeSingle();
const onRoster = (roster?.students ?? []).some(s => s.email === user.email);
if (!onRoster) return { kind: "not_on_roster" };
```

Render a "this reflection isn't assigned to you" screen in `StudentFlow.tsx` for
the off-roster case. The roster cache is refreshed nightly; for new-student
edge cases, offer a "ask your teacher to refresh their roster" message.

The cap-DoS subset can also be mitigated by adding a per-auth-user.id Gemini
rate limit alongside the per-teacher one. Same RPC pattern as
`check_and_increment_gemini_call`, keyed on the student instead.

---

## 3. `next` param classifies role for life on first login (suite-wide footgun) — **medium**

**File:** `apps/teacher-admin/src/app/auth/callback/route.ts:50`

The whole role-routing hangs off a single string-prefix check:
`isStudentFlow = next.startsWith("/r/")`. The prompt frames this as a known
suite-wide footgun and asks specifically about adversarial `next` values.

### What's actually unreachable from `next` manipulation

- **Open redirect to another origin:** the destination URL is built via
  `request.nextUrl.clone(); dest.pathname = next` (line 84-85). Setting
  `URL.pathname = "//evil.com"` does NOT change `host`; it lands as a path on the
  current origin. Setting `pathname = "/foo?bar"` URL-encodes the `?`.
  Protocol/host can't be set via the `pathname` setter. So `next` cannot escape
  origin. Confirmed by a manual node REPL: `dest.pathname = "//evil.com"` gives
  `https://currenthost//evil.com`. Safe.
- **Path traversal across the `/r/` prefix in a way that fools the role check:**
  `next = "/r/../dashboard"` — `startsWith("/r/")` is true so student upsert
  runs, then `URL.pathname` normalizes to `/dashboard`. So the user is upserted
  as a student then sent to `/dashboard`. That page calls `getCurrentTeacher()`
  which (correctly) redirects to `/` because there's no teachers row. So no
  damage, but the student row was created.

### What IS reachable — student-side data-pollution via redirect-bait

A malicious link `/auth/login?next=/r/<some-known-token>` will route any EHS
user (teacher or student) through the student upsert path. For a TEACHER who
clicks it (e.g., from a forum post claiming "test out the AID flow"), this:

- Creates a `students` row keyed on their auth_user_id (without disturbing
  their existing `teachers` row — both can coexist, see finding #1).
- Lets them complete a reflection on someone else's assignment as a "student",
  consuming Gemini quota on the OWNER teacher's cap.
- Pollutes the owner's review surface with a row showing the wrong-user's name.

Inverse via `next=/dashboard` (or anything not starting with `/r/`) is
finding #1.

### Why "medium" not "high"

In both directions the attacker needs to convince an EHS user to click a link
their email/SSO would normally accept anyway — there's no remote-attack path
that doesn't require user interaction with a malicious URL. And in both
directions the consequences are mostly "row got created in a table" rather than
"data was exfiltrated".

### Fix direction

Drop the `next`-prefix-based role detection entirely. Two clean options:

1. **Two separate callback URLs:** `/auth/callback/teacher` and
   `/auth/callback/student`. `/auth/login` decides which to use based on its
   own `next` param (still inspectable by URL crafting, but at least the
   callback can be hardcoded per route — and the OAuth `redirectTo` allowlist
   in Supabase can enforce that students never land at the teacher endpoint).
2. **Single callback that doesn't infer role from `next`:** look up an
   explicit role-cookie set by `/auth/login` before the redirect, signed/hmac'd
   so it can't be forged. The role cookie expires after the OAuth round-trip.

Either fix is also the right move for finding #1 — both reduce to "stop using
`next` as a role oracle."

---

## 4. Bearer-token compare on super-grader endpoints is non-constant-time — **low**

**File:** `apps/teacher-admin/src/lib/super-grader/auth.ts:28`

`if (!presented || presented !== expected)` uses lexicographic `!==` on the
two strings. In principle this leaks timing information about the prefix
match. In practice:

- The endpoint is on Vercel, which adds tens-of-ms of variable network jitter
  per request — the JS string-compare differences are buried under variance.
- The token is a single shared secret; once an attacker has any leg-up on it,
  it's already game over (they just steal the env var).
- Both authed endpoints (`/api/super-grader/result`,
  `/api/super-grader/prompts/objective_summary`) only return non-secret data
  (envelope shape, prompt body that admins can edit in plaintext anyway).

### Fix direction

`crypto.timingSafeEqual(Buffer.from(presented), Buffer.from(expected))`
(needs equal-length buffers — pad both to a fixed length first, or compare
length explicitly + short-circuit safely). Low priority. Mark as defense-in-
depth.

---

## 5. Self-revoke is UI-gated, not server-gated — **low**

**Files:** `apps/teacher-admin/src/app/admin/admins/page.tsx:69-75`,
`apps/teacher-admin/src/lib/actions/admins.ts:45-89`

The page hides the Revoke button when `r.email === me` (line 69) and shows
"(revoke yourself elsewhere)" as the placeholder. The server action
`revokeAdmin()` has no self-check; it only blocks revoking the LAST active
admin (line 73). So an admin can call `revokeAdmin(theirOwnEmail)` from
devtools / curl as long as ≥2 admins exist, and lock themselves out.

### Why "low"

Admins are trusted by definition. Self-revoke is an obvious foot-gun, not
a privilege escalation. The last-admin-lockout protection already exists for
the more dangerous scenario.

### Fix direction

Add the same `granter === email` check in `revokeAdmin`:
```ts
if (granter === email) {
  return { ok: false, message: "Revoke yourself from another admin's account." };
}
```

---

## 6. `getCurrentAdminEmail` bootstrap race is benign but unguarded — **low**

**File:** `apps/teacher-admin/src/lib/auth/admin.ts:36-50`

When the admins table is empty and the calling user's email matches
`INITIAL_ADMIN_EMAIL`, the function inserts a row to bootstrap the first
admin. Two concurrent first-load requests by the same email will both pass
the `count === 0` check and both try to insert; the second hits the email
primary-key uniqueness constraint and the insert errors silently (no
error-handling on the `.insert` call — line 44-48). The first one wins;
the second sees the now-non-empty table and... actually no, the `cache()`
on line 14 means a given request only checks once. Two CONCURRENT requests
might both see count=0 and both attempt insert. The second's insert errors
are swallowed (no `await` on the error path, no `if (error)` check).

The user-facing outcome is correct (one admin row exists, both requests
return `email`), but the swallowed error is hygiene-level worth fixing.

A worse case to think about: what if `INITIAL_ADMIN_EMAIL` is unset or
stale when bootstrap is needed? Line 36-37 short-circuits: returns null.
That's correct — fail-closed.

What if `INITIAL_ADMIN_EMAIL = "Foo@Bar.Com"` (mixed case)? Line 36 does
`.trim().toLowerCase()` so the comparison is case-normalized. Good.

### Fix direction

Wrap the insert in a try/catch and explicitly handle the 23505 duplicate-
key case as "already bootstrapped by a concurrent request — re-read and
return". Don't surface as an error.

---

## 7. SECURITY DEFINER helpers + RLS policies — verified correct

**Files:** `supabase/migrations/20260506000001_initial_schema.sql:144-218`,
`supabase/migrations/20260506000002_secure_helper_functions.sql`,
`supabase/migrations/20260507130000_restore_teacher_owner_grant.sql`,
`supabase/migrations/20260507160000_admins_and_system_prompts.sql:25-44`

Spot-checked all three helpers + every CREATE POLICY across migrations. No
findings.

- `is_teacher_owner(uuid)` — SECURITY DEFINER, `set search_path = public`,
  body is a single SELECT EXISTS on teachers, EXECUTE granted to `authenticated`
  (per the restore migration; without that, RLS evaluation silently fails the
  way it did on super-grader's earlier suite). The restore is the right call.
- `is_student_self(uuid)` — same shape, same grant. Correct.
- `is_admin()` — SECURITY DEFINER, `set search_path = public, auth`, body
  compares `lower(auth.jwt() ->> 'email')` against `admins.email` where
  `active = true`. Edge cases all handled:
  - JWT missing email → `lower(null) = null` → no match → false (fail-closed).
  - Mixed-case JWT email → `lower()` normalizes; `admins.email` column has
    `check (email = lower(email))` so stored values are already lowercase.
  - Inactive admin row → predicate filters on `active = true`. Good.
  - EXECUTE: revoked from public + anon, granted to authenticated. Anon
    cannot read `is_admin()` via REST.

- Tables with RLS enabled and policies present: `teachers`, `students`,
  `teacher_assignments`, `reflection_sessions`, `submission_attempts`,
  `course_install_policies`, `assignment_install_state`, `prompts`,
  `admins`, `canvas_course_cache`, `canvas_assignment_cache`,
  `gemini_usage_daily`, `course_rosters`, `card_text_defaults`. That's the
  full set of public-schema tables created by every migration scanned. No
  table is missing RLS enable + policies.

- Write paths via the user-context cookie client (a few teacher dashboard
  actions: `connectCanvas`, `disconnectCanvas`, `createPrompt`, `savePrompt`)
  rely on RLS to enforce ownership. Reads via the same client (e.g.
  `loadAssignmentReview` first query) gate on `is_teacher_owner(teacher_id)`.
  Verified: all such call sites correctly anchor on `auth.uid()`-resolvable
  identity.

- Service-role usage is widespread (every action involving cross-student
  reads or service-side writes). Each call site I checked re-verifies auth
  in code before doing scoped DB work — `getCurrentTeacher()` /
  `getCurrentAdminEmail()` at entry, then filter by the auth'd id. See
  `lib/actions/prompts.ts`, `lib/actions/system-prompts.ts`,
  `lib/actions/admins.ts`, `lib/actions/canvas-install.ts`,
  `lib/actions/retention.ts`, `lib/reviews/load.ts`. No service-role call
  site lacks an auth check before scoping. Cron endpoint
  (`api/cron/sync-all-teachers/route.ts:27-30`) gates on `CRON_SECRET`
  Bearer match, then does its work — no user identity required, but the
  endpoint is not user-callable. Super-grader endpoints gate on
  `AI_DOCUMENTER_API_TOKEN`. Good.

---

## 8. Token entropy on `/r/<token>` — verified sufficient

**File:** `apps/teacher-admin/src/lib/actions/canvas-install.ts:409`

`iframe_token = randomUUID().replaceAll("-", "")` is a v4 UUID hex-encoded
without dashes — 32 chars, ~122 bits of entropy. `resolveIframeToken`
rejects tokens shorter than 16 chars (resolve.ts:21). Brute-force is
impossible within the universe's lifetime.

Sharing/screenshot/Canvas-description-leak is the realistic threat (see
finding #2), not enumeration.

---

## 9. Domain enforcement on the callback — verified safe

**File:** `apps/teacher-admin/src/app/auth/callback/route.ts:34-38`

`email.endsWith(\`@${ALLOWED_DOMAIN}\`)` with `ALLOWED_DOMAIN =
"episcopalhighschool.org"`. The leading `@` in the comparison prevents
the `attacker@xepiscopalhighschool.org` style bypass — the last 24
characters of any such email lack the `@` prefix at the right offset.

Email comes from `user.email` (line 30) which is Google-OAuth-verified
via Supabase. Google enforces RFC-5321 email formatting, so multiple-@
exploits aren't reachable from the trust boundary.

Domain check happens AFTER `exchangeCodeForSession` (line 19-21). If
domain check fails, `supabase.auth.signOut()` (line 36) cleans up — but
the row in `auth.users` does remain (Supabase doesn't delete on signOut).
A persistent attacker hitting the callback with a non-@episcopalhighschool.org
Google account would create an `auth.users` row each time. This is
inert (no row in `teachers` or `students`, no auth cookies after the
signOut), but it does grow `auth.users` unboundedly. Not exploitable;
just noise. Low/no severity.

---

## 10. CRON_SECRET and AI_DOCUMENTER_API_TOKEN guard the right scope — verified

**Files:** `apps/teacher-admin/src/app/api/cron/sync-all-teachers/route.ts:18-30`,
`apps/teacher-admin/src/lib/super-grader/auth.ts`

Cron endpoint requires `Authorization: Bearer ${CRON_SECRET}` (with explicit
500 if env var unset — fail-closed). Vercel attaches this header
automatically to scheduled invocations. A leaked URL alone cannot trigger
the loop. Good.

Super-grader's two endpoints require `Authorization: Bearer
${AI_DOCUMENTER_API_TOKEN}` (auth.ts:24-33). Distinct from
`SUPER_GRADER_INGEST_TOKEN` (outbound). Both endpoints return service-role
data — `/result` returns the reflection envelope (including
`socratic_messages`, `first_draft`, `objective_summary` — PII-adjacent
once de-anonymized), `/prompts/objective_summary` returns the admin-edited
system prompt body (not secret per se but admin-owned content). Bearer
gate is the right shape. See finding #4 for the timing-compare nit.

---

# Summary of findings (severity-ranked)

| # | Severity | Title | File |
|---|----------|-------|------|
| 1 | high     | Any EHS user can self-elevate to teacher via the unified callback | auth/callback/route.ts:50-79 |
| 2 | medium   | `/r/<token>` skips roster check → DoS + cross-class pollution    | iframe/resolve.ts:18-58 |
| 3 | medium   | `next`-prefix role detection mis-classifies on adversarial link  | auth/callback/route.ts:50 |
| 4 | low      | Bearer compare is non-constant-time                              | super-grader/auth.ts:28 |
| 5 | low      | Admin self-revoke is UI-gated only                                | actions/admins.ts:45-89 |
| 6 | low      | Bootstrap-admin insert race swallows duplicate-key error          | lib/auth/admin.ts:36-50 |

Verified-correct (no findings):
- SECURITY DEFINER helpers (`is_teacher_owner`, `is_student_self`, `is_admin`) —
  search_path pinned, grants correct, predicates fail-closed.
- All 14 public-schema tables have RLS enabled with policies.
- Every service-role call site re-verifies auth in code before scoping.
- `iframe_token` entropy is 122 bits — not brute-forceable.
- Domain enforcement on email is correctly anchored on `@<domain>`.
- Cron + super-grader endpoint Bearer auth is fail-closed.

The dominant root-cause across the findings is **fail-open** — specifically,
fail-open by default-permissive role assignment in `/auth/callback`. The same
shape lives in HAH/OE/HH and is the documented suite-wide auth footgun.
Findings #1 and #3 are two faces of the same underlying bug; fix one and the
other goes away.
