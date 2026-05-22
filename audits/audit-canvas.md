# AI Documenter — Canvas integration audit

**Scope:** install / auto-submit / roster / token handling
**Date:** 2026-05-21
**Lens:** snapshot semantics, state fences, transactional boundaries,
fail-open vs fail-closed, idempotency, plus AID-specific (`as_user_id`
masquerade, marker robustness, body-mode fallback, card-text customization,
roster `/users` endpoint, active-term, auto-install baseline, destination
picker, Canvas error handling).

---

## Severity legend

- **CRITICAL** — silent data corruption, identity confusion, or wrong-student
  writes. User-visible misfires that violate the integration contract.
- **HIGH** — student gets told "done" while submission did not land, or
  state diverges across normal user paths.
- **MEDIUM** — degraded behavior under realistic timing/race conditions.
- **LOW** — defensive / housekeeping; no current symptom in production.

---

## 1. **[CRITICAL] Destination picker is half-wired — `post_to_canvas_comment=false` is silently ignored at submit time**

**File:** `apps/teacher-admin/src/lib/finalize/canvas-submit.ts:150-173`

The M6.18a destination picker exposes three independent booleans (drive,
comment, submission) and the install path correctly persists all three on
`teacher_assignments`. The dashboard UI reads the triple
(`apps/teacher-admin/src/app/dashboard/page.tsx:130-132`).

But the finalize submit path only branches on `post_to_canvas_submission`:

```ts
// canvas-submit.ts:156
if (!teacherAssignment.post_to_canvas_submission) {
  // ALWAYS posts a Canvas comment, regardless of post_to_canvas_comment
  await postSubmissionCommentAsStudent(...);
}
```

The doc comment at line 39-43 explicitly says "or no-op if
`post_to_canvas_comment` is also off, which only happens in 'Drive only' mode
— caller suppresses the Canvas call entirely in that case" — but **no
caller suppresses it**. `finalize.ts:120` calls `submitReflectionToCanvas`
unconditionally for every `teacher_assignment_id`, regardless of which
destinations are checked. The same is true for `reviews.ts:59`
(`resendToCanvas`).

**Scenario:** Teacher picks "Drive only" at install (drive=true,
comment=false, submission=false). Today: every student reflection still
posts a comment to Canvas authored by the student. The teacher who
deliberately opted **out** of Canvas writes gets Canvas writes anyway.

A milder version of the same bug exists for body-mode: when
`post_to_canvas_submission=true` AND `post_to_canvas_comment=false`, the
422 fallback at line 208 silently posts a comment that the teacher
explicitly turned off.

**Fix direction:** In `submitReflectionToCanvas`, return early ("ok with no
Canvas write") when both Canvas flags are false. In the body-mode 422
fallback path, only fall through to comment if `post_to_canvas_comment` is
true; otherwise return a structured failure ("submission rejected; comment
fallback disabled by teacher choice"). Additionally: have
`finalize.ts`/`reviews.ts` short-circuit the Canvas call when both flags
are false to avoid an unnecessary `submission_attempts` row.

---

## 2. **[CRITICAL] `listCourseStudents` is missing `enrollment_state[]=active`**

**File:** `packages/canvas/src/submissions.ts:13-22`

```ts
const path =
  `/courses/${canvasCourseId}/users?` +
  `enrollment_type[]=student&` +
  `include[]=email&per_page=100`;
```

The CLAUDE.md / project context specifies
`/courses/:id/users?enrollment_type[]=student&enrollment_state[]=active&include[]=email&per_page=100`
as the canonical roster endpoint. AID is missing the `enrollment_state[]=active`
filter. Result: Canvas returns active, invited, completed, and rejected
enrollments for the course.

**Why this is dangerous:**

- **Roster sync** writes these into `course_rosters.students`. The PII scrubber
  (`lib/scrub/roster-scrub.ts`) then compiles a regex over that list and
  scrubs free-text AI transcripts. Including last-year alumni emails &
  names in the active-course roster doesn't poison scrubbing — but it does
  poison the anon-token map: if Canvas reuses a numeric user_id (it does
  not, but the email format is what's used for the token salt), or more
  realistically a past student whose enrollment was "completed" is still
  in the roster, the auto-submit `lookupCourseStudentByEmail` could match
  a graduated alum's email and **write the reflection under the wrong
  user_id** (mass-FERPA event).
- The body-mode submit then `POST /submissions?as_user_id=<wrong_id>` and
  Canvas attributes our reflection to the alumnus, who may not even be on
  the assignment's section.

Realistically EHS has unique year-over-year emails, so the practical risk
hinges on whether a student is enrolled in multiple sections of the same
course (some cross-listed advisory groups do this) with one section in
"completed" state. Still, leaving this off is reckless given the project
context explicitly calls it out as the 2026-05-20 fix.

**Fix direction:** Add `enrollment_state[]=active` to the path. Optionally
also add `&enrollment_state[]=invited` if first-day-of-term students should
be matchable.

---

## 3. **[CRITICAL] `resendToCanvas` has no `state==='submitted'` idempotency guard**

**File:** `apps/teacher-admin/src/lib/actions/reviews.ts:23-74`

`resendToCanvas` loads the session and immediately calls
`submitReflectionToCanvas` regardless of `session.state`. The student-side
`finalizeReflection` (finalize.ts:96-105) DOES short-circuit on
`session.state === 'submitted' && session.canvas_submission_id`, but
`resendToCanvas` does not.

**Scenario:**

1. Student finishes, finalize succeeds, `state='submitted'`,
   `canvas_submission_id=12345` recorded.
2. Teacher loads the reviews page, sees a stale "needs retry" UI for a
   moment before revalidate completes, hits **Resend**.
3. In body-mode (`post_to_canvas_submission=true`), Canvas
   `POST /submissions?as_user_id=...` is **not** idempotent — Canvas's
   `find_or_create_submission` will update the existing submission
   row, but each call increments the submission's `attempt` number and
   may regrade Turnitin if the assignment is plagiarism-enabled. More
   concerning: the new HTML body replaces the old one, so if the
   teacher had edited the reflection text in the gradebook UI, the
   resend silently overwrites it.
4. In comment-mode, a second PUT to
   `submissions/:user_id` with `comment[text_comment]=...` **adds a
   second identical comment** in the gradebook (Canvas comment endpoint
   is additive, not upsert) — gradebook noise.

**Fix direction:** Mirror the finalize idempotency check in
`resendToCanvas`: refuse to resend if `state==='submitted'` and
`canvas_submission_id` is set, returning the existing submissionId as a
success. Alternatively, expose a "force resend" mode that explicitly
acknowledges the duplication.

---

## 4. **[HIGH] Snapshot drift: card text & prompt body change after install with no re-PUT**

**Files:**
- `apps/teacher-admin/src/lib/actions/canvas-install.ts:202-227`
- `apps/teacher-admin/src/lib/card-text/resolve.ts`
- `apps/teacher-admin/src/app/(student)/r/[token]/StudentFlow.tsx`

Card-text customization (M6.15b) and reflection prompts are both edited via
the **auto-save pattern** (CLAUDE.md memory entry "Editable prompts
auto-save, no Save buttons"). Every keystroke commits 800ms later.

What happens on edit:

- **Card text** is stored in `teachers.card_*` / `card_text_defaults`.
  The marker block was written into Canvas at install time with the THEN-current
  text. Subsequent edits do NOT trigger a re-PUT. So the card the student
  sees in Canvas reflects whatever text was current **at install**, and the
  reinstall flow (manual or auto-install on a re-encountered assignment)
  ALSO uses the current text — but if the prompt edit triggers a sync without
  a re-install (very common — the nightly cron re-runs
  `syncTeacherCanvasData` but auto-install only runs on courses with
  `auto_install_new_assignments=true` AND only on assignments with
  `first_seen_at > policy.auto_install_enabled_at`), the visible card stays
  frozen.
- **Reflection prompt** is read live by the student app at session
  bootstrap via `teacher_assignments.prompt_id`. So the prompt the student
  sees IS current — even if the teacher edits the prompt body mid-session,
  the next Gemini call sees the new body. That's a real footgun: a student
  partway through a reflection can have the alignment question pulled from
  a prompt that's been edited since they started.

The mixed semantics are surprising:
- "Card text in Canvas" → snapshot at install
- "Prompt body the student sees" → live every turn

**Fix direction (defensive):**
- Persist a snapshot of the rendered card text + the prompt body into
  `teacher_assignments` (or a sibling `installs_snapshot` table) on every
  install. Student-side reads from the snapshot, not live. Edits become
  drafts; "Publish to installs" becomes an explicit teacher action that
  re-PUTs Canvas descriptions for every assignment that uses the affected
  prompt / card text.
- At minimum: when a teacher saves card text, enqueue a re-install sweep
  across all assignments they own that have `assignment_install_state.status='installed'`.

---

## 5. **[HIGH] Install actions have no state fence — concurrent install/uninstall races**

**Files:**
- `apps/teacher-admin/src/lib/actions/canvas-install.ts:75-164`
- `apps/teacher-admin/src/lib/sync/auto-install.ts:149-174`
- `apps/teacher-admin/src/app/api/cron/sync-all-teachers/route.ts`

Three independent paths can mutate `assignment_install_state` and Canvas
descriptions concurrently:
- Manual install button (`installOnAssignments`)
- Manual uninstall button (`uninstallFromAssignments`)
- Nightly cron + on-demand "Refresh" calling
  `autoInstallNewAssignmentsForTeacher`

None of them take any kind of lock. None check the current install state
before acting. The pattern is:

1. `getAssignment` (Canvas GET) → fetch current description
2. patch
3. `updateAssignmentDescription` (Canvas PUT)
4. upsert `assignment_install_state` with status

**Race scenarios:**

- **Install + uninstall colliding**: teacher double-taps install/uninstall.
  Both branches GET the same description; one strips, one inserts. The PUT
  ordering then determines whether the card is present or absent — and the
  `assignment_install_state` row reflects whichever transaction landed
  last, which may not match the actual Canvas description.
- **Cron auto-install + teacher manual uninstall**: nightly cron fires at
  08:00 UTC, teacher uninstalls at 08:00:01 from the dashboard. Cron read
  the description before the uninstall, PUTs the card back after. The
  `assignment_install_state` row goes uninstalled→installed but the
  teacher believes they uninstalled.
- **Two browser tabs**: the teacher opens the dashboard in two windows and
  hits install in both. Two `teacher_assignments` rows would conflict on
  the unique (teacher_id, canvas_assignment_id) constraint — the second
  insert errors. But for an existing row, both transactions race on the
  PUT.

OE's M6.19 work explicitly added state fences and atomic RPCs for
analogous problems (the current branch's commit history mentions snapshots
+ atomic start-exam RPC, M6.19 Phase 1).

**Fix direction:**
- Add a per-(teacher, canvas_assignment_id) advisory lock (Postgres
  `pg_advisory_xact_lock` keyed on `hashtext(teacher_id || aid)`) at the
  start of each `installOne` / `uninstallOne` / auto-install body, and
  release on commit.
- After the Canvas GET → PUT round-trip, re-fetch the Canvas description
  before declaring "installed" so a concurrent change doesn't leave us
  with a stale view of reality.
- For the cron, skip assignments that have been mutated in the last 60s
  (check `assignment_install_state.updated_at`).

---

## 6. **[HIGH] Install is non-transactional: Canvas PUT succeeds, local upsert can fail**

**File:** `apps/teacher-admin/src/lib/actions/canvas-install.ts:215-244`

The sequence in `installOne`:

1. `ensureTeacherAssignment` (DB insert/update)
2. `getAssignment` (Canvas GET)
3. `updateAssignmentDescription` (Canvas PUT) — irreversible side effect
4. `admin.from("assignment_install_state").upsert(...)`

If step 4 errors (Supabase transient, network blip), Canvas has the card
but our DB doesn't know. The next sync sees no `assignment_install_state`
row and auto-install (if enabled with a recent `enabled_at`) may treat
the assignment as never-installed and... actually try to install again,
which is idempotent on the description side but logs a spurious
"installed" event.

Conversely, if the `getAssignment` succeeds but Canvas's PUT 5xx's, we
record `assignment_install_state.status='installed'` because the catch
block on line 144-154 catches the CanvasError — but actually the catch is
inside `installOne`'s wrapper. Let me re-check: yes the wrapper at line
129-155 catches all errors and pushes a failed result. So PUT failure is
correctly NOT recorded as installed. Good.

The remaining gap is: step 4 fails → Canvas installed but DB says
"failed." The teacher sees red in the dashboard, hits install again,
the second pass succeeds, no data damage. **Severity HIGH not CRITICAL**
because re-install is safe. But the dashboard's truth-table is wrong for
that window.

`uninstallOne` has the symmetric issue: Canvas description is cleaned
(line 273-280), but the `assignment_install_state` upsert at line 282-294
could fail. The teacher then sees "uninstalled" in Canvas but
"installed" in the dashboard. Re-uninstall is also idempotent (line 272
returns a no-op clean), so the path to recovery exists; but the
state-truth gap is real.

**Fix direction:** Move the local DB writes into a single transaction
that includes the row-level lock, and only commit AFTER Canvas PUT
succeeds. Alternative: write a "pending-installed" state BEFORE the
PUT, finalize to "installed" after, recover from "pending-*" rows on
boot or via a sweep cron.

---

## 7. **[HIGH] Course-list state filter includes "completed" — past-year courses pollute the cache**

**Files:**
- `packages/canvas/src/courses.ts:36-41`
- `apps/teacher-admin/src/lib/sync/canvas-sync.ts:102`
- `apps/teacher-admin/src/lib/sync/active-term.ts`

```ts
// courses.ts:36
"/courses?enrollment_type=teacher&per_page=100" +
"&include[]=term&include[]=sections" +
"&state[]=available&state[]=completed&state[]=unpublished";
```

`canvas-sync.ts:102` then filters by `isActiveTerm(c.term?.name)`, which
greps the term name for a prefix like `"2025/2026"`. The filter relies
entirely on **term naming**. Two real-world concerns:

- **EHS uses term name prefixes like "2025/2026a" and "2025/2026 - High
  School - ..."**. `startsWith("2025/2026")` matches both. Good.
- **Cross-academic-year courses**: a "year-long" course in
  `2025/2026 - Full Yr` is correctly included. But a course in
  `2024/2025 - Spring` is excluded, even though Canvas's
  `state=completed` would include it. The filter is doing exactly what
  it's supposed to.
- **August 1 cutover**: `activeAcademicYearPrefix` flips on August 1
  (month >= 7). Between 2026-08-01 (cutover) and the first nightly cron
  on that date at 08:00 UTC, the dashboard shows last-year's term as
  active and the new-year courses as "Other terms". Likely fine for one
  day.
- **Term name typos / new term naming**: if EHS Canvas admins create a
  term named "AY 2026-27" instead of `2026/2027 - ...`, AID will
  silently treat the entire next year as "no active term" and refuse
  to sync assignments. There's no diagnostic. The teacher would see an
  empty dashboard.

**Fix direction (defensive):**
- Use Canvas's `term.start_at`/`term.end_at` if available (the API
  returns it; we just don't read it) as the source of truth, with the
  name-prefix as a fallback.
- Surface a "no active-term courses found" warning in the dashboard so
  a typo'd term name isn't silently absorbed.

---

## 8. **[HIGH] Roster sync stores `email`-with-fallback-to-`primary_email`, but mixed-source rows cause anon-token churn**

**File:** `apps/teacher-admin/src/lib/sync/roster-sync.ts:96-106`

```ts
const raw = (u.email ?? u.primary_email ?? "").trim().toLowerCase();
if (!raw || !raw.includes("@")) return [];
```

Good news: the rejection of non-email-shaped rows is correctly applied
(the 2026-05-20 fix is here). No `login_id` fallback poisons the roster.

**Subtle issue:** the anon_token is HMAC over
`(canvas_user_id, email_lowercased)`. If a particular student's email
field switches from being returned by `email` to being returned by
`primary_email` (or vice versa) on a future Canvas API rev, and the
case/whitespace differs by one character, the anon_token changes silently
across syncs. Existing `reflection_messages.anon_token` rows would no
longer match the roster regex.

`students.anon_token` is set at student-side login (via SSO email) AND
re-keyed in `canvas-submit.ts:111-119` to `(canvas_user_id, email)`. Two
write sites, two different precedences for what "email" means. If a
student's SSO email casing differs from their Canvas email casing
(rare but possible — corporate email aliases), the re-key changes the
anon_token after the first auto-submit, orphaning any
`reflection_messages` written before then under the old token. The
roster scrubber would also see a different anon_token from what's in
`reflection_messages` and silently fail to highlight that student's name
on re-render.

**Fix direction:** Canonicalize email aggressively — trim, lowercase,
NFKC-normalize — in **one** helper (`canonicalizeEmail`) and use it at
every site that derives an anon_token. Then it doesn't matter which
Canvas field the email came from.

---

## 9. **[MEDIUM] `findReflectionMarkerBlock` returns the FIRST block — duplicates only get cleaned on re-install, not on detection**

**File:** `packages/canvas/src/install.ts:140-158`

`hasReflectionMarkerBlock` is true iff the FIRST marker pair exists. If
Canvas's sanitizer or a teacher-side description edit duplicates the card
(easy to do: paste-from-clipboard, copy-and-paste-the-card-into-another-
assignment), the install-state-detection logic only finds one of them. The
`replaceOrAppendReflectionBlock` `stripAllBlocks` loop does correctly
remove all of them at re-install time, but the dashboard's "installed"
indicator (which is read from `assignment_install_state` plus an indirect
description-scan) would not flag the duplication.

In the canvas package this is invisible. But in
`apps/teacher-admin/src/lib/install-state/` if there's a description
parser there, it should at least count cards and warn the teacher about
duplication. (Did not find such a parser; the install-state truth comes
from the `assignment_install_state` table only.)

**Fix direction:** add an `iterReflectionBlocks` helper that yields all
matches; surface "N copies detected" in the dashboard so a teacher knows
to re-install to converge.

---

## 10. **[MEDIUM] No CanvasError 429 / 5xx differentiation; everything is failed-immediately**

**Files:**
- `packages/canvas/src/error.ts` (just stores status + body)
- `packages/canvas/src/fetch.ts:46-66` (no retry, no rate-limit awareness)
- `apps/teacher-admin/src/lib/finalize/canvas-submit.ts:193-205`

The body-mode submit only falls back to comment on 400/422. Every other
status (401 auth, 403 perm, 404 not found, 429 rate-limit, 500/502/503/504)
returns a hard failure to the student with `needsCompletionCode:true`.

In particular:

- **429** — Canvas rate-limits per token. The teacher's single token
  serves the cron sweep + every active student's auto-submit. During
  a class period where 25 students all hit "I'm done" at the end of
  15 minutes, the 26th may 429. No retry, no exponential backoff. The
  student sees the completion code path. The teacher gets to type the
  reflection in manually.
- **5xx** — Canvas's API has occasional flap; a retry once after 1s
  resolves most.

The `paginate` helper in `fetch.ts:46-66` also has no retry, so during
the cron pass a single transient 502 mid-pagination kills the entire
teacher's roster pull.

**Fix direction:** introduce a small retry helper around `canvasFetch`
that handles 429 (respect `Retry-After`) and 5xx (jittered exponential
backoff, max 3 retries). Treat 401 specially in submit: if the token is
revoked, flag `teachers.canvas_token_status='revoked'` so the dashboard
can prompt the teacher to reconnect — without that, every student
finalizes to a completion-code state, the teacher doesn't know why, and
support gets a flood of tickets.

---

## 11. **[MEDIUM] Auto-install bypass: `policy.auto_install_enabled_at IS NULL` silently skips, no diagnostic**

**File:** `apps/teacher-admin/src/lib/sync/auto-install.ts:106`

```ts
if (!policy.auto_install_enabled_at) continue;
```

The migration `20260512150000_auto_install_baseline.sql` backfills
`auto_install_enabled_at = now()` for any pre-existing policy with
`auto_install_new_assignments=true`. A future migration could regress this.

If a row ends up with `auto_install_new_assignments=true` but
`auto_install_enabled_at=null` (e.g. someone runs raw SQL, or a faulty
admin tool), the teacher sees auto-install **enabled** in the UI but no
assignments get installed. There's no log, no failure row.

`setCourseAutoInstall` always sets `enabled_at` on the off→on flip, so
this can't happen via the UI. But defense-in-depth matters.

**Fix direction:** in the sweep, when the bypass triggers, push a warning
row into a `sync_warnings` table (or `console.warn` at minimum) so this
silent skip is observable in the cron route's response payload.

---

## 12. **[MEDIUM] `getCurrentTeacher` is called inside install but the loaded `teacher` object is read once — token revocation mid-pass is invisible**

**File:** `apps/teacher-admin/src/lib/actions/canvas-install.ts:82-94`

The teacher's token is decrypted once at the start of `runForAssignments`.
For a 50-assignment bulk install, that's ~50 sequential Canvas PUTs. If
the teacher revokes the token in Canvas during the sweep, every PUT after
that point 401s. The current code catches the CanvasError per-assignment
(line 144-154), so the teacher gets per-assignment "Canvas rejected the
token" errors — but it keeps trying for all 50 assignments. Wastes time.

Same in `submitReflectionToCanvas` for a hypothetical batch resend path
that doesn't exist today.

**Fix direction:** treat 401 as a fatal-for-the-batch signal — fail-fast
on the first 401 of a sweep and mark remaining assignments as "skipped:
token revoked" rather than retrying each individually.

---

## 13. **[MEDIUM] `find_or_create_submission` semantics under `as_user_id` on body-mode resubmit**

**File:** `packages/canvas/src/submissions.ts:93-125`

Body-mode submit uses `POST /courses/:c/assignments/:a/submissions?as_user_id=:u`.
Canvas's controller calls `find_or_create_submission`, which **does**
upsert (one row per (assignment, user)). But the controller also
increments `attempt` on each call and re-queues plagiarism scoring if
configured.

For the AID use case, body-mode is opt-in for AI-literacy assignments,
which are typically NOT plagiarism-scored. So in practice this is
benign. But if a teacher opts in on a Turnitin-enabled assignment
(against the documentation in the 20260513120000 migration's preamble),
each resubmit re-runs Turnitin against the boilerplate AI Documenter
HTML, which would mark the assignment "similar to other submissions" in
a way that's hard to explain.

**Fix direction:** before allowing body-mode opt-in at the install UI,
check `assignment.turnitin_enabled` (if Canvas exposes it via
`include[]=turnitin_settings`) and refuse. At minimum, surface a warning
in the destination-picker UI when the teacher checks
`post_to_canvas_submission` on a Turnitin-enabled assignment.

---

## 14. **[MEDIUM] `lookupCourseStudentByEmail` matches `login_id` exact-equals the full email, then login_id == localPart — could double-match an admin user**

**File:** `packages/canvas/src/submissions.ts:48-76`

```ts
return localPart.length > 0 && loginId === localPart;
```

EHS's pattern is `login_id = local-part`. So a Canvas account with
`login_id = "jsmith42"` matches any roster member with email
`jsmith42@anything.com`. If EHS has admin / service accounts on a course
(unlikely but possible — a teacher's testing account, a Canvas Admin
auditor enrolled as a student), their `login_id` could collide with a
real student's email local part across domains.

This isn't a current EHS risk (single domain), but the check is the
weakest in the chain (`email exact match` is strong, `login_id ==
localPart` is fuzzy). If EHS ever ships students with email aliases on
different domains (rare but plausible for a transfer student), this
fuzziness could pick the wrong account.

**Fix direction:** make `login_id == localPart` a last-resort fallback
only after every other match has been tried, and emit a warning when
this branch fires (so support can audit).

---

## 15. **[LOW] Marker regex matches HTML comments only — but the `findCardBlockByToken` walks raw HTML across innermost `<div>`s**

**File:** `packages/canvas/src/install.ts:246-294`

`findCardBlockByToken` walks `<div>` opens/closes via regex. Canvas's RCE
output is generally well-formed, but if a teacher's description contains
a `<div>` with an attribute value containing the literal string `</div>`
(or, more realistically, a script tag with a `</div>` inside a comment),
the regex-based depth counter at line 298-315 could pick the wrong close
tag and over-strip. Not security-sensitive (it just removes more than
intended), but a teacher who has a complex description could lose
content on uninstall.

`install.test.ts` exercises the happy paths but no adversarial HTML.

**Fix direction:** for fully-correct handling, use a real HTML parser
(cheerio / parse5). For now, add a fuzz test against teacher
descriptions with `</div>` inside string literals + script tags.

---

## 16. **[LOW] `submission_attempts` log is written but never bounded — append-only forever**

**Files:**
- `apps/teacher-admin/src/lib/finalize/canvas-submit.ts:533-543`

Every submit attempt (including retries and idempotent fast-paths)
inserts a row. Over a school year × 25 students × 50 assignments × 1.x
average attempts per session = ~1.5k rows per teacher. Across 50
teachers, 75k rows. Not a crisis, but the cleanup story (M6.19 mentions
retention) should include this table.

---

## 17. **[LOW] `connectCanvas` doesn't validate that `canvasUser.id` matches `teacher.canvas_user_id` on reconnect**

**File:** `apps/teacher-admin/src/lib/actions/canvas-token.ts:32-49`

A teacher reconnects with a token belonging to a DIFFERENT Canvas
account (say, they got a fresh dev token from a colleague's account).
The connect succeeds; everything downstream uses that token's identity.
Auto-submits to `as_user_id=<student>` then attempt masquerade across
the wrong teacher's permission scope and 403 (since the alien token
isn't enrolled as teacher in the right courses). Symptom: the teacher's
existing assignments suddenly start failing all submits with no
obvious explanation.

**Fix direction:** on reconnect, persist `teachers.canvas_user_id` if
not set; reject a reconnect that brings a different canvas_user_id with
a clear "this token belongs to another account."

---

# Summary

Top issues by severity, ranked:

1. **CRITICAL (#1)** — Destination picker is half-wired: `post_to_canvas_comment=false` is silently ignored.
2. **CRITICAL (#2)** — `listCourseStudents` missing `enrollment_state[]=active`.
3. **CRITICAL (#3)** — `resendToCanvas` has no idempotency guard; double-resend duplicates / overwrites.
4. **HIGH (#5)** — Concurrent install / uninstall / cron operations have no state fence.
5. **HIGH (#4)** — Card text and prompt body snapshot semantics are mixed (install-time for card, live for prompt).

The recurring pattern: **AID has the M6.18a wiring on the install side but
the finalize side wasn't updated in lockstep**, and the suite-wide
M6.19 lessons (fences, snapshots, idempotency) haven't been applied to
AID yet. The Canvas package itself is reasonably tight (clean error types,
defensive token escaping, idempotent marker strip-and-replace); most of
the bugs live in the teacher-admin layer that orchestrates it.
