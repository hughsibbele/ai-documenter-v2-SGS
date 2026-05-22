# AI Documenter — Remediation Plan

Strategic plan to address the structural bugs surfaced by the 2026-05-21 multi-agent code review. Audits covered six themes in parallel:

1. Reflection session state machine + RLS + finalize flow → `audits/audit-session-state.md`
2. PII scrubbing + Gemini boundary + transcript ingest → `audits/audit-pii-scrub.md`
3. Canvas integration (install + auto-submit + roster + tokens) → `audits/audit-canvas.md`
4. Auto-save + server-action error handling → `audits/audit-auto-save.md`
5. Cross-system seams (webhook, ingress, cron, retention, crypto) → `audits/audit-seams.md`
6. Auth + RLS + token security → `audits/audit-auth-rls.md`

The audits identified the same five recurring root causes as the OE M6.19 review one week prior. Almost every individual bug maps to one of them. Patching point-by-point would leave the patterns intact; the same shape of bug would re-appear in the next feature. This plan groups fixes by structural theme so each phase eliminates a *class* of bugs.

## Status (as of 2026-05-21)

All phases pending. The critical path is **0 → 1 → 2 → 3**, identical to OE's M6.19 cadence (which shipped in 4 sequential commits over a day). Phases 4–9 are independent and can run in any order once the critical path lands.

| Phase | State | Commit |
|---|---|---|
| 0 — Stop the PII bleed | Pending | — |
| 1 — Snapshot semantics on session start | Pending | — |
| 2 — State fences + idempotent intake / bootstrap / turn / finalize | Pending | — |
| 3 — Stale-session sweep + retention cron | Pending | — |
| 4 — Auto-save normalization (close CLAUDE.md regressions) | Pending | — |
| 5 — Canvas client robustness | Pending | — |
| 6 — Auth boundary + role separation | Pending | — |
| 7 — Polish + small risks | Pending | — |
| 8 — Infrastructure hardening | Pending | — |
| 9 — Verification + observability | Pending | — |

## Recurring root causes

Same five root causes as the OE remediation. Every finding in `audits/*.md` maps to one or more of these:

1. **No snapshot semantics.** `reflection_sessions` holds live FK references to `prompts`, `card_text_*`, `teacher_assignments.post_to_canvas_*`, and `course_rosters`. Editing any of those mid-reflection or after finalize changes what the past reflection meant retroactively. Auto-save makes mid-flight edits trivial. Spans session-state H2/H3 and canvas H5.
2. **No state fences on UPDATEs.** `submitIntake`, `nextSocraticTurn`, `finalizeReflection`, `persistSuccess`, every auto-save `.update()` — all write without `.eq("state", expected)` or `.eq("updated_at", staged)` guards. Concurrent calls and stale callers freely transition rows backward or clobber one another. Spans session C2/C3'/C4/H1, auto-save F3, canvas H4 (install fence).
3. **No transactional boundaries across subsystems.** Install = Canvas PUT + binding upsert (non-atomic). Finalize = Canvas submit + DB UPDATE + super-grader webhook (three independent writes; partial failure leaves divergent state). End-of-year sweep currently lives only in admin UI with no automation. Spans session C4/H5, canvas H4, seams #3/#4.
4. **Fail-open instead of fail-closed.** Empty `course_rosters` row → scrub becomes no-op, raw PII written to Gemini. Missing `SUPER_GRADER_SALT` → same. `deAnonymize` never called anywhere → if scrub WERE fixed, Canvas writes would render `Student_xxxxxx` literals. Auth callback defaults a logged-in EHS student into the `teachers` upsert path. The lens applies hardest to PII (scrub C1/H1) and auth (auth-RLS #1/#2).
5. **No retry / idempotency semantics.** Double-click on intake mints two `reflection_sessions` rows. Page refresh during finalize double-posts to Canvas. `resendToCanvas` has no state guard. Webhook has no retry, no idempotency key, no DLQ. Auto-save's blur + visibilitychange + debounce can fire three saves in the same tick. Spans session C1/C3'/C4, canvas C3, auto-save F4/F5, seams #4.

## Strategic shape

| Theme | Phase | Root cause it kills | Bug count addressed |
|---|---|---|---|
| Stop the PII bleed | **0** | Fail-open scrub | 1 critical |
| Snapshot semantics | **1** | FK-not-snapshot drift | ~4 high (H2/H3 + canvas H5) |
| State fences + idempotency | **2** | UPDATEs without state guards | ~7 critical/high (session C1–C4, H1; canvas C3) |
| Stale-session sweep + retention cron | **3** | No server-side cutoff + retention gap | 2 high + paper cuts |
| Auto-save normalization | **4** | Concurrent-save scramble + suite drift | 2 high regressions + 3 high races |
| Canvas client robustness | **5** | Atomicity + 429 + destination picker | ~6 critical/high/medium |
| Auth boundary + role separation | **6** | Fail-open role inference + cross-tenant | 2 high + 1 medium |
| Polish + small risks | **7** | Misc | ~10 medium/low |
| Infrastructure hardening | **8** | Crypto rotation + telemetry | ~3 medium/low |
| Verification + observability | **9** | Future regression | enabling |

**Sequencing principle:** anything FERPA-shaped first; then schema enablers (snapshot columns) so other phases have the data they need; then code that depends on schema; then parallel cleanup tracks. Phases 4–9 are independent of each other and of the shipped critical path — pick any order once 0–3 are in.

Recommended order if linear: **0 → 1 → 2 → 3 → 4 → 6 → 5 → 7 → 8 → 9**. The 4-before-5 swap from OE is because AID has concrete documented regressions on the auto-save layer (`/dashboard/prompts/PromptCard.tsx` and `/dashboard/setup/CardTextEditor.tsx` are NOT on auto-save despite CLAUDE.md claiming they are) that are silently losing teacher work today — higher priority than the canvas cleanup track.

---

## Phase 0 — Stop the PII bleed (fail-closed scrub)

**Audit refs:** `audit-pii-scrub.md` Bug 1 (critical), Bug 4 (high salt asymmetry); `audit-session-state.md` H4.

**One critical bug, FERPA-shaped. Ship first.**

`scrubSessionForGemini` (`apps/teacher-admin/src/lib/scrub/session.ts:30-54`) silently no-ops when:

- The `course_rosters` row is missing for the Canvas course (common on a brand-new course before nightly sync).
- `SUPER_GRADER_SALT` is unset (operator error during deploy).
- A student isn't yet in the cached roster (mid-term add).
- `canvasCourseId` is null / `""` / `"preview"`.

In all these cases the session goes to Gemini with raw `first_draft`, `paste_fallback_text`, and `ai_chats[].transcript_text` — student names, classmate names, possibly teacher names. The docstring claims "the structured anonymizer at the boundary still runs" but **`scrubStructured` is never called anywhere in the AID app** (verified by grep — only a comment referencing it).

**Worse asymmetry:** `roster-scrub.ts:66-80` catches a missing-salt throw and proceeds with empty roster (silent leak), but `anonToken`'s short-salt throw propagates as a 500 (fail-closed). Same operator-error class, opposite outcomes, and the wrong one is the silent-leak case.

### Deliverables

1. Make `scrubSessionForGemini` fail-closed: when the compiled roster is empty *because of missing dependencies* (no roster row, missing/short salt, empty `canvasCourseId`), return a structured error to the caller. Distinguish from "roster present, compiled to zero variants" (one-student short-name course — legitimately empty).
2. Drop the `try/catch` on `readSaltFromEnv()` in `roster-scrub.ts`. Let it throw. Make the whole reflection action surface "PII scrub unavailable — try again in a few minutes" with a teacher-visible telemetry event so it surfaces.
3. On `/r/<token>` first session bootstrap for a course we've never seen, kick a synchronous one-shot roster pull before allowing the conversation to begin. Same pattern other apps use for `students` rows.
4. Add a regression test that asserts `scrubSessionForGemini` REFUSES to call Gemini when the roster is missing (today there is no such test — the existing tests assert the no-op behavior, which would HIDE the bug if the fail-closed pivot regressed).

**Acceptance:** every codepath that produces a string destined for Gemini either runs through a non-empty compiled roster or refuses to call Gemini. Verified by grep + unit test. Mirror of OE Phase 0 (commit `9dc96db`).

---

## Phase 1 — Snapshot semantics on session start

**Audit refs:** session H2 (prompt body), H3 (card_text + destination flags); canvas H5 (card text drift).

`reflection_sessions` holds live FK references — at the moment of every Gemini call and every Canvas write, the code reads `prompts.body`, `card_text.*`, `teacher_assignments.post_to_canvas_*`, and `course_rosters.students` LIVE. Combined with auto-save (every keystroke commits 800ms later), a teacher editing during a reflection retroactively rewrites what their student's reflection meant.

Concrete failure cases from the audit:

- Teacher edits the alignment-Q prompt mid-conversation → student's Q1 is generated against prompt v1, closing is generated against prompt v2. Teacher review then renders against prompt v3 (whatever's live at view time).
- Teacher flips `post_to_canvas_submission` from `true` → `false` between intake and finalize → student starts thinking the reflection IS the submission, ends with a comment-only post (gradebook still says `unsubmitted`).
- Card text in the Canvas description is frozen at install time; prompt body the student sees is live. Two students opening the same assignment on the same day can see mismatched card + prompt.

### Deliverables

1. New migration: add snapshot columns to `reflection_sessions`:
   - `prompt_body_snapshot text NOT NULL DEFAULT ''`
   - `prompt_id_at_session uuid` (FK + version pin)
   - `student_facing_question_snapshot text`
   - `card_text_snapshot jsonb` (kicker, title, body, cta_text)
   - `post_to_canvas_comment_at_session bool NOT NULL DEFAULT true`
   - `post_to_canvas_submission_at_session bool NOT NULL DEFAULT false`
   - `post_to_drive_at_session bool NOT NULL DEFAULT false`
2. Populate at intake (`submitIntake`) inside the atomic claim of Phase 2.
3. Read from snapshots in:
   - `socratic.ts` (`generateObjectiveSummary` + `generateCoachTurn`)
   - `finalize.ts` (destination routing)
   - `canvas-submit.ts` (`teacherAssignment.post_to_canvas_*` references)
   - `reviews/[courseId]/[assignmentId]/page.tsx` (teacher review surface — surface the snapshot, not the live row)
4. Backfill is not required — existing sessions can leave snapshots null; new sessions get populated. Note the cutover date in the dashboard.

**Acceptance:** an in-flight reflection survives a mid-conversation prompt edit + destination flip with no visible change to the student. Teacher review shows the prompt and destination AS-OF session start, not live. Mirrors OE Phase 1 (`8828428` + migration `20260521120000`).

---

## Phase 2 — State fences + idempotent intake / bootstrap / turn / finalize

**Audit refs:** session C1 (no unique constraint), C2 (intake replay), C3' (bootstrap race), C4 (finalize race), H1 (Socratic turn race), H5 (Canvas accepted + local UPDATE failed); canvas C3 (resendToCanvas no fence); auto-save F3/F4/F5 (overlap — addressed in Phase 4).

Five distinct race conditions in the session pipeline, all the same shape: read-then-write with no atomic claim.

### 2a — Intake uniqueness + replay refuse

1. Migration: `UNIQUE (teacher_assignment_id, student_id)` on `reflection_sessions` (or a partial unique index on non-archived states if you want restart-after-finalize to be possible later).
2. `submitIntake` switches to `.upsert(..., { onConflict: "teacher_assignment_id,student_id", ignoreDuplicates: false })` paired with a state precondition: if the existing row's state is `in_progress`/`completed`/`submitted`, return `{ ok: true, sessionId: existing.id }` idempotently instead of inserting. If `failed`, allow recovery (UPDATE the existing row).
3. Closes C1 + C2 together. Also fixes the devtools-replay attack where a student could bury a finalized reflection under a fresh `in_progress` row.

### 2b — Atomic claim for bootstrap / Q1→Q2 / Q2→close

Convert every read-then-write in `socratic.ts:102-247` into a single-statement claim:

```sql
CREATE OR REPLACE FUNCTION advance_socratic_turn(
  p_session_id uuid,
  p_expected_length int,
  p_new_messages jsonb,
  p_new_state text
) RETURNS uuid AS $$
  UPDATE reflection_sessions
     SET reflection_messages = p_new_messages,
         state = p_new_state,
         updated_at = now()
   WHERE id = p_session_id
     AND jsonb_array_length(reflection_messages) = p_expected_length
  RETURNING id;
$$ LANGUAGE sql;
```

Gemini call happens AFTER the claim row is reserved (with a sentinel state like `bootstrap_in_flight` and an `expires_at`-style timeout for crash recovery). Losing call gets `null` from the RPC and returns the row's current state to the client. Closes C3' + H1. Same pattern as OE Phase 2 (commit `d37bd8d`).

### 2c — Finalize claim + Canvas-DB transactional boundary

1. Add `state='submitting'` to the session enum (or use a `canvas_submit_lock_at timestamptz` column with a 60s claim window).
2. `finalizeReflection` opens with: `UPDATE reflection_sessions SET state='submitting', submit_attempt_at=now() WHERE id=? AND state='completed' RETURNING ...`. Branch on whether 1 row was affected. If 0, another worker beat us — re-read and return whatever the winning call's outcome was.
3. `persistSuccess` becomes the only path that writes `state='submitted'`, gated on `state='submitting'`. Add `.eq("state", "submitting")` to that UPDATE.
4. If the local UPDATE fails after Canvas accepted, return `{ ok: false, error: "Canvas accepted but local state diverged; manual reconciliation needed." }` instead of silently returning `ok: true` (current behavior is what causes the H5 double-post).
5. Webhook fires only on successful local UPDATE. Pass a stable idempotency key (`session.id`) so super-grader can dedupe.
6. `resendToCanvas` gets the same fence — refuse to resubmit if `state='submitted' AND canvas_submission_id IS NOT NULL`.

Closes C4, H5, canvas C3.

**Acceptance:** every state transition in the pipeline is gated on the expected source state. Double-clicks, page refreshes, and concurrent tabs cannot produce duplicate Gemini calls, duplicate Canvas writes, or duplicate webhook fires. Mirror of OE Phase 2.

---

## Phase 3 — Stale-session sweep + retention cron

**Audit refs:** session L6 (expires_at unused); seams #3 (no retention cron — policy gap).

CLAUDE.md commits to "one academic year, end-of-year sweep" but the only registered cron is `/api/cron/sync-all-teachers`. `reflection_sessions.expires_at` defaults to `now() + 1 year` and nothing consumes it. Sessions accumulate forever unless an admin clicks the manual button.

Additionally: stale `state='in_progress'` sessions (student opened reflection, walked away) live forever and pollute the teacher review surface + the `/api/super-grader/result` endpoint (which returns them as half-complete envelopes — see Phase 7).

### Deliverables

1. New cron route `/api/cron/sweep-sessions` (Vercel daily at 03:00, `CRON_SECRET` gate):
   - Auto-archive sessions where `state IN ('in_progress','completed')` AND `created_at < now() - interval '14 days'` → set `state='archived'` (or `failed`, depending on whether you want them retryable).
   - Hard-delete sessions where `expires_at < now() AND state IN ('submitted','failed','archived')`. State fence is critical here — don't nuke an in-progress reflection because someone left a tab open across the 1-year boundary.
2. Idempotent (re-running the year-end sweep on already-empty state is a no-op).
3. Telemetry: count of swept-vs-deleted per run, surfaced to admin retention page.

**Acceptance:** sessions don't pile up indefinitely. The `/api/super-grader/result` endpoint never returns an envelope from a session older than 14 days unless it was actually finalized. Mirror of OE Phase 3 (commit `24eb257`).

---

## Phase 4 — Auto-save normalization (close CLAUDE.md regressions)

**Audit refs:** `audit-auto-save.md` Findings 1, 2, 3, 4, 5 (all HIGH); plus Finding 6 (aggregator pill loses errors).

Two screens silently violate the suite-wide auto-save contract documented in CLAUDE.md and in global memory `feedback_editable-prompt-auto-save.md`:

- `apps/teacher-admin/src/app/dashboard/prompts/PromptCard.tsx` — controlled inputs + explicit Save button + "Discard changes" button. Page does not wrap children in `AutoSaveProvider` at all. A save failure silently evaporates typed text on reload.
- `apps/teacher-admin/src/app/dashboard/setup/CardTextEditor.tsx` — same shape. Worse: the per-field `handleReset` writes to DB immediately without flushing other in-memory edits, silently dropping them. Status state machine overloads error strings with state tokens.

Three additional races in the auto-save layer affect every screen that IS on auto-save:

- **No `updated_at`/`version` fence on any auto-save action.** Two tabs each typing produces last-write-wins. OE found the same shape.
- **`revalidatePath` after every save cancels in-flight debounce.** The parent re-renders with new `updated_at`, the `freshnessKey` changes, the `setTimeout` is cleared mid-debounce, and up to 800ms of just-typed text never saves.
- **`save()` is not single-flighted.** Blur + visibilitychange + debounced typing can fire three concurrent saves; the latest baseline-reset can land on a stale value, leaving the genuinely-latest edit unsaved.

### Deliverables

1. Port `PromptCard.tsx` to the auto-save pattern used by `SystemPromptCard.tsx` in the same repo — uncontrolled inputs + refs + `useAutoSaveForm` + `useAutoSaveDispatch`. Wrap `dashboard/prompts/page.tsx` in `<AutoSaveProvider>`. Drop the Discard button (suite policy).
2. Port `CardTextEditor.tsx` to match `CardTextDefaultsEditor.tsx` (admin-side sibling, which auto-saves correctly). Disambiguate the status state machine into the typed `AutoSaveStatus` union.
3. Add `version int NOT NULL DEFAULT 1` to `prompts`, `system_prompts`, `card_text_defaults`, `teacher_card_overrides`. Every auto-save action becomes `.update(...).eq("id", ?).eq("version", expected).select()` — branch on affected-row count. On stale-version, re-read and merge.
4. Replace blanket `revalidatePath` calls with targeted `revalidateTag` keyed off the row id, OR move the freshness signal out of `props.row.updated_at` and into a separate "saved-at" surface that doesn't trigger `useAutoSaveForm`'s teardown.
5. Single-flight `save()` in `useAutoSaveForm.ts`: short-circuit re-entry while a save is in flight; queue at most one trailing save.

**Acceptance:** every prompt + card-text editor in the suite passes the same auto-save test: typing → 800ms → save lands; blur → save lands; visibilitychange → save lands; concurrent tab edits don't clobber; save failure keeps the typed text visible with a clear pill. AID's `/dashboard/prompts` + `/dashboard/setup` now match `/admin/prompts` + `/admin/card-text` byte-for-byte.

---

## Phase 5 — Canvas client robustness

**Audit refs:** canvas C1 (destination picker half-wired), C2 (missing `enrollment_state[]=active`), C3 (already addressed in Phase 2), H4 (install fence), H5 (already addressed in Phase 1), plus several mediums (429 handling, login_id fallback, auto-install bypass).

### Deliverables

1. **Destination picker** (`canvas-submit.ts:150-173`): branch on BOTH `post_to_canvas_comment` AND `post_to_canvas_submission`. Return early ("ok with no Canvas write") when both are false. In the body-mode 422 fallback, only fall through to comment if `post_to_canvas_comment` is true. Add a `finalize.ts` short-circuit to avoid an unnecessary `submission_attempts` row when both Canvas flags are false. — Closes the "teacher picked Drive only, still got Canvas comments" bug.
2. **Roster endpoint** (`packages/canvas/src/submissions.ts:13-22`): add `enrollment_state[]=active` to match the canonical 2026-05-20 fix that's already applied to the other 4 apps. Closes the "wrong-student write via stale alum email" risk.
3. **Install/uninstall/cron fence**: wrap each `canvas-install.ts` GET-patch-PUT cycle in a per-`(teacher_id, canvas_assignment_id)` advisory lock (`pg_advisory_xact_lock`). Cron auto-install should re-check `assignment_install_state` immediately before re-installing — if the teacher uninstalled in the last minute, back off.
4. **429 / Retry-After / 5xx**: `packages/canvas/src/fetch.ts` currently treats them all identically. Split into:
   - 429 → exponential backoff respecting `Retry-After` header, max 3 retries
   - 5xx → exponential backoff, max 2 retries
   - 4xx → no retry, structured error
5. **`login_id == localPart` weak match** in `lookupCourseStudentByEmail`: drop it. Match on full email only. Reject otherwise. The OE/AID 2026-05-20 lesson is that `login_id` is not an email.
6. **`auto_install_enabled_at IS NULL` bypass**: surface the install-disabled state more loudly (today the cron silently skips).

**Acceptance:** every Canvas write respects the destination picker; roster never contains inactive enrollments; install races don't drift state; transient Canvas errors retry safely; identity matches are strict.

---

## Phase 6 — Auth boundary + role separation

**Audit refs:** auth-RLS #1 (self-elevation to teacher), #2 (/r/<token> roster gate), #3 (next-prefix role oracle).

The unified `/auth/callback` decides role purely from `next.startsWith("/r/")` — any EHS-domain user who lands on a `/dashboard/*` URL with default `next=/dashboard` gets upserted into `teachers`. `teachers` and `students` tables both allow the same `auth_user_id` to live in both, so a student can become both with two visits.

Canvas API RBAC limits practical damage (a student's Canvas token can't install a card), but the AID-internal teacher dashboard surface is fully exposed, and the role confusion gets harder to clean up the longer it's in production.

Separately: `/r/<token>` requires only a valid 32-char token and an EHS Google account — no check that the auth'd user is actually on the assignment's roster. This enables (a) quota-exhaustion DoS against the owner teacher's daily Gemini cap, (b) information disclosure of custom prompt bodies, (c) pollution of the teacher review surface with stranger rows.

### Deliverables

1. **Teachers allowlist** (mirror the `admins` table shape — `email PRIMARY KEY, active BOOLEAN, granted_by_email, granted_at`). In `/auth/callback`, when `!isStudentFlow`, check the allowlist. On miss → sign out + redirect to `/?auth_error=not_a_teacher`.
2. **Mutually exclusive roles**: when upserting as teacher, check for an existing `students.auth_user_id` and refuse with `auth_error=role_conflict`. Symmetrically on the student side. (The "decide your role at first login" UX is unusual but matches how the system is documented.)
3. **`/r/<token>` roster gate**: in `resolveIframeToken` (or as a separate gate at the session/intake/socratic entry points), look up the auth'd user against `course_rosters.students`. If not on the roster for this assignment's course → `kind: "not_on_roster"`, surface a clear error. (Falls back gracefully when the roster is empty — see Phase 0's "kick a one-shot roster sync" interaction.)
4. **Open-redirect hardening on `next`**: today `URL.pathname` blocks origin escape (verified), but tighten the allowlist explicitly (only relative paths starting with `/`, no `//`, no `\\`).
5. **`timingSafeEqual` for cron + ingress bearer compares**: `sync-all-teachers/route.ts` and `super-grader/auth.ts` both use `===`. Switch to `crypto.timingSafeEqual` with length pre-check. (Defense in depth; low practical exploitability.)

**Acceptance:** no EHS student can become a teacher. No EHS student can drive a reflection on a course they're not enrolled in. Both roles cannot coexist for the same `auth_user_id`. The cron and ingress endpoints reject mismatched bearers in constant time.

---

## Phase 7 — Polish + small risks

Grouped low/medium findings that don't fit the structural phases. Cherry-pick by appetite.

**Session-state polish (audit-session-state.md):**
- M1: tighten `iframe_token` validation to `length === 32 && /^[0-9a-f]{32}$/`.
- M2: rate-limit `/r/<token>` resolution.
- M3: completion-code rotation / per-use invalidation if you ever expose it as a teacher-side "accept manual completion" path.
- L1: fix the `g.co` regex in `intake.ts:26`.
- L2: word-count first-draft floor instead of character-count.
- L4: centralize the `time_spent_estimate` band string (duplicated in 3 places).
- L5: "you already submitted this reflection on <date>" UX for returning students.

**Scrub polish (audit-pii-scrub.md):**
- Bug 3 (high): `deAnonymize` is exported but never called anywhere. Once Phase 0 lands, Canvas submission bodies + webhook envelopes + teacher review will start emitting `Student_xxxxxx` literals. Wire `deAnonymize` into `canvas-submit.ts` (Canvas is on EHS's side of the privacy boundary), `super-grader.ts` (envelope), and the teacher review surface (`reviews/page.tsx`). Bug 1 and Bug 3 must ship together — fixing 1 without 3 produces user-visible regressions.
- Bug 5 (high): `course_rosters` lookup uses `.eq("canvas_course_id").limit(1)` with no `teacher_id` filter. Two teachers on the same course can produce non-deterministic roster selection. Pin the lookup to the session's teacher.
- Token-generation drift: `student.ts:48` uses `canvas_user_id=""` at signup time (pre-Canvas-link). Either delay token generation until Canvas-linked or document the divergent token shape.
- `urlContext: true` lets Gemini fetch share-link HTML server-side, unscrubbed. Accepted risk per CLAUDE.md, but worth surfacing in a comment + a teacher-visible disclosure.

**Canvas polish (audit-canvas.md):**
- Body-mode `use_submission_body=true` should refuse to opt in on Turnitin-enabled assignments (Canvas double-submits behavior).
- `connectCanvas` accepts a foreign teacher's token without identity validation. Verify the token's owner matches the calling teacher's email.

**Seams polish (audit-seams.md):**
- `Cache-Control: public` → `private` on `/api/super-grader/prompts/objective_summary`.
- `/api/super-grader/result` state fence: `.in("state", ["completed","submitted"])` so SG doesn't render half-completed envelopes.
- `hardDeleteReflections` ownership check: in `resolveScope`, verify the calling teacher actually owns `canvasCourseId` before scoping. Defense in depth; the downstream query filter saves us today.
- Webhook idempotency / retry: track delivery on `reflection_sessions.super_grader_notified_at`. The Phase 2 finalize claim already passes an idempotency key; this just records the success.

**Auth polish (audit-auth-rls.md):**
- Admin self-revoke: today server action allows `revokeAdmin(self.email)` when ≥2 admins exist; only the UI hides the button. Move the gate server-side.
- `iframe_token` expiry / revocation / rate-limit (medium; today: 122-bit random, no expiry).

**Auto-save polish (audit-auto-save.md):**
- Finding 6: `AutoSaveProvider` aggregator pill "green-washes" errors when one editor errors and another succeeds. Surface the most severe state, not the most recent.
- Finding 11: `getCurrentTeacher` calls `redirect()` from inside server actions, navigating away mid-typing with zero pill feedback. Refactor to return a structured error instead.

---

## Phase 8 — Infrastructure hardening

**Audit refs:** seams #5 (timingSafeEqual already in Phase 6), AES rotation, Sentry beforeSend, Supabase proxy review.

1. **AES-256-GCM key rotation tooling**: `packages/crypto/` is correctly built (no IV reuse, correct key derivation) but has no rotation story. Add a rotation script that re-encrypts all `encrypted_canvas_token` rows under a new key, with a dual-read window. Document in `scripts/README.md` (the suite already has `rotate-salt.sh`; add a sibling for the encryption key).
2. **Sentry `beforeSend` scrubber**: `sendDefaultPii: false` is set, but request bodies attached to errors (server-action arguments) can still contain PII. Add a `beforeSend` that walks the event body and replaces any anonymized-or-not student text with `[redacted]`.
3. **Supabase proxy** (`lib/supabase/proxy.ts`): verify what it's actually proxying. If it's an anonymous-read path, ensure RLS policies hold. If it's a service-role bypass, audit every call site for hand-rolled auth.
4. **Anonymizer-package drift**: the existing `scripts/verify-anonymizer-drift.sh` covers AID — wire it into CI on every PR that touches `packages/anonymizer/` in any sub-repo.

---

## Phase 9 — Verification + observability

Establish the post-remediation regression net. Pick from this list based on appetite.

1. **Integration tests for the five root causes.** Each test asserts a specific structural property:
   - Snapshot: mid-session prompt edit doesn't change the session's stored prompt body.
   - State fence: concurrent `submitIntake` calls only produce one `reflection_sessions` row.
   - Transactional: Canvas POST failure doesn't leave a session in `submitting` state past the lock window.
   - Fail-closed: empty `course_rosters` → `scrubSessionForGemini` refuses to call Gemini.
   - Idempotency: page refresh during finalize doesn't double-post to Canvas.
2. **Telemetry**: emit structured logs for every state transition + every Gemini call + every Canvas write. Wire into the existing Sentry config. Establish a dashboard showing daily counts of each.
3. **Synthetic monitoring**: a daily cron that runs a synthetic reflection end-to-end against a test course in Canvas (with a flag to skip the actual submission). Surfaces stale Inngest registration would catch — though per CLAUDE.md AID doesn't use Inngest.
4. **Anonymizer contract test in CI**: assert that a representative fixture goes from raw → tokens via every codepath that touches Gemini.

---

## Cross-cutting notes

**Mapping to OE M6.19:** the OE remediation (`oral-examiner-v2-SGS/REMEDIATION_PLAN.md`) shipped Phases 0–3 on 2026-05-21 in commits `9dc96db`, `8828428`, `d37bd8d`, `24eb257`. Each AID phase has a direct OE analog and the same code patterns transfer one-to-one. Where OE's audit found 6 high/critical issues in the session layer, AID has 5 (C1–C4 + H1) — the count is similar and the shapes are identical. The same is true for the scrub layer (1 critical in both), the auth layer (OE had `/api/inngest` drift, AID doesn't use Inngest but has the parallel role-confusion bug), and the canvas layer (both have destination/install/idempotency issues).

**What changed since OE:** AID's bug list has two additions that OE didn't have:
- The auto-save regressions on `/dashboard/prompts/PromptCard.tsx` and `/dashboard/setup/CardTextEditor.tsx` are concrete (OE's auto-save layer was the pilot for the suite-wide pattern and is consistent throughout). This pushes Phase 4 ahead of Phase 5 in the recommended order.
- The role-confusion bug (`next.startsWith("/r/")` as role oracle) is suite-wide but more impactful in AID because the student-side route (`/r/<token>`) is more openly accessible than OE's exam routes. Phase 6 specifically.

**Open questions for the relevant phases** (capture before starting work):
- Phase 1 snapshot columns: snapshot at intake or at finalize? Intake gives clearer student-side semantics; finalize is simpler. Recommend intake.
- Phase 2 `state='submitting'`: extend the enum or use a separate lock column? Recommend enum extension for consistency with OE.
- Phase 3 retention sweep: hard-delete or soft-archive at the 1-year mark? CLAUDE.md says "clears reflection data" which is ambiguous. Recommend hard-delete with the state fence.
- Phase 4: how aggressive on the version-fence rollout? Every prompt + card-text table, or only the highest-collision ones? Recommend all four.
- Phase 6: teachers allowlist managed via existing `/admin/admins/` UI or a new `/admin/teachers/` route? Recommend extending the existing route.

