# AID Audit — Reflection session state machine, RLS, finalize flow

**Date:** 2026-05-21
**Auditor:** Claude (Opus 4.7)
**Scope:** `apps/teacher-admin/src/app/(student)/r/[token]/`, `src/lib/actions/{intake,socratic,session,finalize}.ts`, `src/lib/socratic/*`, `src/lib/finalize/*`, `src/lib/scrub/*`, RLS on `reflection_sessions`/`students`/`prompts`/`course_rosters`.
**Reference:** Mirror of the OE M6.19 audit. Same five suite-wide root causes applied:
1. No snapshot semantics (mutable refs)
2. No state fences on UPDATEs
3. No transactional boundaries across subsystems (Canvas + super-grader + DB)
4. Fail-open instead of fail-closed
5. No retry/idempotency on user-visible mutations

The bug count below reflects all five root causes plus AID-specific concerns (token validation, dual-intake collision, hardcoded-Q server enforcement, objective-summary cache).

---

## CRITICAL

### C1 — No unique constraint on `(teacher_assignment_id, student_id)` → duplicate reflection_sessions on intake double-submit

**Files:**
- `supabase/migrations/20260506000001_initial_schema.sql:58-78` — `reflection_sessions` table definition. `unique` only on `id` and `completion_code`. No `unique (teacher_assignment_id, student_id)`.
- `apps/teacher-admin/src/lib/actions/intake.ts:104-138` — insert path. Never checks for an existing session; never uses `ON CONFLICT`. Just inserts a brand-new row each call.

**Root cause:** No retry/idempotency (#5) + missing schema invariant.

**Failure scenario.** Student fills out intake, hits "Submit & continue →". Network blip stalls the response. They click again (or browser auto-retries the server action, or React strict-mode double-fires in dev → carries over to "what if it happens once in prod"). Two concurrent `submitIntake` calls reach the server; both pass the same `resolveIframeToken` + `students` lookup; both run `.insert(...)`. The DB has no constraint to deduplicate — both inserts succeed. The student now has **two `reflection_sessions` rows** for the same `(assignment, student)`, each with a different `id`, `completion_code`, possibly different `first_draft` if they edited between clicks.

`nextSocraticTurn` at line 73-83 then picks "the latest by created_at" and runs the Socratic conversation on **only one** of the two sessions. The other becomes an orphan row that:
- Still has `state='in_progress'` (never advances).
- Counts against the eventual finalize state lookup: `finalize.ts:78-86` also uses `.order("created_at", desc).limit(1)` filtered to `['completed','submitted','failed']` — so the orphan with `state='in_progress'` is silently ignored at finalize time, but lives forever in the DB (until end-of-year sweep).
- Pollutes teacher review surfaces that iterate over the table.
- Shows up in super-grader pull-on-view as a stale `session_id`.

Worse, this is exploitable: a student who wants to **abandon a finalized reflection and start over** could potentially trigger a second intake from a fresh tab → new `in_progress` session that masks the original — `nextSocraticTurn` picks it up because `.in("state", ["in_progress","completed","submitted"])` returns BOTH and `.limit(1)` picks the newer one. Then they finalize the second one, and the super-grader webhook reflects the second submission while Canvas already has the first's comment. Inconsistent state visible to the teacher.

**Suggested fix.**
1. Add `UNIQUE (teacher_assignment_id, student_id)` to `reflection_sessions`. (Or a partial index restricted to non-archived states, if you want to allow legitimate restart-after-finalize down the road.)
2. In `submitIntake`, switch the insert to `.upsert(..., { onConflict: "teacher_assignment_id,student_id", ignoreDuplicates: false })` OR do an explicit existence-check + return-existing path before insert.
3. Combine with C2 (state fence) so a finalized session can't be silently overwritten by a fresh intake.

---

### C2 — Intake re-submission silently mutates `first_draft` / wipes `reflection_messages` on a returning student

**Files:**
- `apps/teacher-admin/src/lib/actions/session.ts:62-82` — `getStudentSession` returns `hasActiveReflection=true` for `['in_progress','completed','submitted']`, so the client routes to `ConversationScreen` and skips intake. Good.
- `apps/teacher-admin/src/lib/actions/intake.ts:42-138` — but the server action `submitIntake` itself does **no precondition check**. Any direct call (via stale tab, replay, browser back+resubmit, devtools) inserts a fresh row regardless of existing state.

**Root cause:** No state fence on intake → conversation transition (#2).

**Failure scenario.**
- Student has finished the conversation; session is `state='submitted'`, Canvas already has the reflection.
- They navigate Back twice → land on IntakeScreen (React state restored from a stale render OR they have an old tab open).
- They tap the submit button. `submitIntake` runs, inserts a NEW session (C1). Now there are TWO sessions: the original `submitted` one (with the real reflection) + a new `in_progress` one (with whatever junk they typed).
- Next call to `nextSocraticTurn` picks the new one (created_at desc), and **runs Gemini against the junk intake**, charging the teacher's daily-cap quota for no reason. The Socratic UI re-engages.
- Worse, the **teacher review surface** for that student now shows two distinct session ids — and depending on which it joins on, may show the abandoned conversation in place of the real submitted one.

A more targeted attack: from devtools, a student could replay the server action with a new `first_draft` value to **rewrite their already-submitted reflection** by burying the original under a fresh session. Canvas wouldn't pick up the change (already submitted there), but super-grader's webhook on the new finalize would overwrite the previously-stored envelope (`peer_results` upsert by `(peer, canvas_user_id, canvas_assignment_id)` — confirmed in `super-grader.ts:21-22`).

**Suggested fix.** In `submitIntake`, before inserting, look up any existing session for `(ta.id, student.id)` and:
- If none → insert (normal first-time path).
- If `state IN ('in_progress','completed','submitted')` → return `{ ok: false, error: "You've already started this reflection." }` (or transparently `{ ok: true, sessionId: existing.id }` if you want it idempotent).
- If `state = 'failed'` → reset path: allow but maybe `UPDATE` the existing row instead of inserting a new one.

This same check should also fence against C1's double-click race once the unique index lands.

---

### C3 — Server does not enforce the "second question is hardcoded" invariant — student can substitute any AI question text

**Files:**
- `apps/teacher-admin/src/lib/actions/socratic.ts:175-187` — Q2-append path. Trusts that whatever the next AI message is, it's the hardcoded one. Inserts `HARDCODED_FINAL_QUESTION` as the AI text, which is correct on the server.
- BUT: the client (`StudentFlow.tsx:594-608`) does `nextSocraticTurn({iframeToken, studentMessage: text})` then `setMessages(res.messages)` — the AI's question is taken from `res.messages`. The server defines the text. ✓

Wait — re-reading: the server **does** hardcode the text at `socratic.ts:180`. That part is fine.

However: the `priorTurns` array passed to `generateCoachTurn` for the **closing call** (line 200-210) reads `withStudent = [...prior, {role:"student", text:studentMsg, ts:now}]`. The `prior` here comes from the DB row, not the client. So the closing Gemini call sees the trusted hardcoded Q. ✓

**This subsection is clean; downgrading from a finding to a verification note.** Moving the real issue to C3' below.

---

### C3' — Bootstrap turn (`prior.length === 0`) has no concurrency fence → two summaries + alignment Qs generated, double-charge to Gemini

**Files:**
- `apps/teacher-admin/src/lib/actions/socratic.ts:102-172` — Bootstrap path. Read-then-write with no version guard.

**Root cause:** No state fence (#2) + no idempotency (#5).

**Failure scenario.**
- Student lands on `/r/<token>` after intake. `ConversationScreen` mounts. `useEffect` at `StudentFlow.tsx:531-546` fires once (`initialFetched.current` guards client-side single-fire).
- Student refreshes the page during the ~5-10s objective-summary Gemini call. New page load, new `initialFetched` ref → fires bootstrap again.
- Both calls reach the server. Both see `prior.length === 0`. Both call `generateObjectiveSummary` (Gemini call #1 × 2) and `generateCoachTurn` (Gemini call #2 × 2). Total: 4 Gemini calls instead of 2. Teacher's daily cap is double-charged.
- Both then UPDATE the row to `reflection_messages = newMessages, objective_summary = summaryRes.summary`. Whichever wins overwrites the other. The `objective_summary` on the row may not match the AI bubble in `reflection_messages[0]` (text was generated twice with `temperature=0.3` — different outputs).
- `ObjectiveSummaryCard` filters `reflection_messages` by `m.text === objectiveSummary` (`StudentFlow.tsx:616-620`) — if they don't match, the objective summary bubble is rendered TWICE in the chat (once as the labeled card, once as a non-filtered ai bubble).

**Suggested fix.**
- Reservation pattern at the boundary: do an UPDATE with `.eq("id", session.id).eq("reflection_messages", "[]"::jsonb)` or `.is("objective_summary", null)` BEFORE the Gemini calls — set a sentinel state like `bootstrap_started_at = now()`. Reject the second call with "already bootstrapping" if the fence fails.
- Or: introduce a `reflection_sessions.bootstrap_attempt_id` column, generate a UUID per call, attempt to write it with `WHERE bootstrap_attempt_id IS NULL`. The losing call backs off and re-reads.
- Or: stronger — promote the read-write pair into an `RPC` that runs in a single statement (`UPDATE ... WHERE state = 'in_progress' AND reflection_messages = '[]'::jsonb RETURNING id`) and only the winning call proceeds to Gemini.

The same fence applies to the Q1→Q2 append (`prior.length === 2`) and Q2→closing append (`prior.length === 4`) paths: a fast double-tap of the "Send" button (the React `disabled={pending}` only guards within a single ConversationScreen mount — different tabs / refresh trick) doubles up the student turn AND fires a duplicate closing Gemini call.

---

### C4 — Finalize: Canvas-submit + webhook + state UPDATE are not atomic, no `state='completed'→'submitted'` fence

**Files:**
- `apps/teacher-admin/src/lib/actions/finalize.ts:49-183`
- `apps/teacher-admin/src/lib/finalize/canvas-submit.ts:226-258` — `persistSuccess` updates `state='submitted'` with `.eq("id", sessionId)` only. No `.eq("state","completed")` precondition.

**Root cause:** No transactional boundary (#3) + no state fence (#2).

**Failure scenarios.**

**(a) Double-finalize race.**
- Student finishes Q2. `socratic.ts` writes `state='completed'` (line 227 / 243).
- `StudentFlow.tsx:552-572` `useEffect` fires `finalizeReflection` once (guarded by `finalizeStarted` ref).
- But: page refresh during the 10-15s Canvas POST → new mount, new `finalizeStarted=false`, fires again.
- Both `finalizeReflection` calls run concurrently. Both see `session.state='completed'` (fast-path check at line 96 requires `state='submitted'` AND `canvas_submission_id`; not yet true).
- Both call `submitReflectionToCanvas`. Both POST to Canvas — **Canvas gets two submission comments / two body POSTs**. The comment-only path is especially bad: `postSubmissionCommentAsStudent` creates a new comment on each call (Canvas comments are append-only; idempotency is up to caller). The teacher sees two duplicate reflection comments in SpeedGrader.
- Both call `notifySuperGrader` → super-grader's `peer_results` upserts by `(peer, canvas_user_id, canvas_assignment_id)` so the duplicate webhook is mostly harmless there, but it does fire two API calls and logs two ingest events.
- Both UPDATE the row to `state='submitted'` with the most-recent `canvas_submission_id`. Last writer wins — the local `canvas_submission_id` reflects only one of the two Canvas writes (the other's submission_id is orphaned in Canvas with no DB pointer).

**(b) Webhook fired but Canvas write succeeded only locally.**
- Less likely now (Canvas-first ordering), but: Canvas POST succeeds → `persistSuccess` runs the UPDATE → DB write fails (Supabase transient error). `canvas-submit.ts:241-249` does NOT propagate the DB failure; it logs and returns ok:true. So the caller thinks Canvas+DB are in sync, fires the webhook, returns success to the student — but `state` is still `'completed'`, not `'submitted'`. A subsequent finalize-retry on the same session **double-posts to Canvas** because the fast-path idempotency check on line 96 requires `state='submitted' AND canvas_submission_id` — neither is true.

**(c) Canvas write fails AFTER super-grader webhook fires.**
- Pathway impossible in current code (Canvas first, then webhook). ✓ Order is correct.
- But: when Canvas fails, line 168-173 sets `state='failed'`. This UPDATE has **no state fence** either — it overwrites whatever `state` happens to be. If a concurrent finalize call somehow wrote `state='submitted'` between the failed canvas leg and this line, this UPDATE clobbers it back to `failed`. Mitigation: the `.eq("state","completed")` guard.

**Suggested fix.**
1. Add a "claim" UPDATE at the start of `finalizeReflection`: `UPDATE reflection_sessions SET state='submitting', submit_attempt_at=now() WHERE id=? AND state='completed'` — branch on whether the UPDATE affected 1 row. If 0, another worker beat us; load the latest state and return its result.
2. Add `state='submitting'` to the enum (or use a separate `canvas_submit_lock_at timestamptz` column with a "claim within last N seconds" semantic). Same fence at the `state='submitted'` write: `WHERE state IN ('submitting','completed')`.
3. Make `submitReflectionToCanvas` return both the Canvas result AND a flag for whether the local UPDATE succeeded; bubble DB failure up to `finalizeReflection` so it doesn't fire the webhook on a torn state.
4. The webhook itself should be idempotent in flight too — pass a stable `idempotency_key` (e.g., `session.id`) so super-grader can dedupe on its side if we double-fire.

---

## HIGH

### H1 — `nextSocraticTurn`'s `prior.length` switch is a write fence on stale data

**Files:** `apps/teacher-admin/src/lib/actions/socratic.ts:91-247`.

**Root cause:** State fence (#2) — the read of `reflection_messages` and the subsequent UPDATE that appends to it are not atomic.

**Failure scenario.** Two concurrent `nextSocraticTurn` calls (refresh-mid-call, double-click, tab+tab):

- Both read `reflection_messages.length === 2` (after Q1 student turn).
- Both go to the `prior.length === 2` branch.
- Both append `{student turn, hardcoded Q}` and UPDATE the row, overwriting `reflection_messages` to the same 4-message array.
- The student's Q1 answer is duplicated (or one is lost depending on which body of `studentMsg` makes it in last).
- The two-turn flow drifts: subsequent `prior.length === 4` branches both append on a 4-array → end up with 6 messages, which is the "closing" path. Functionally OK by luck, but the second call also fires a closing Gemini call → see C3'.

Same issue at `prior.length === 4` → closing path: TWO closing Gemini calls, last-writer-wins on `reflection_messages` and `state='completed'`.

**Suggested fix.**
- Combine reads + writes into a Postgres function: `advance_socratic_turn(session_id, expected_length, student_msg)` that does `UPDATE reflection_sessions SET reflection_messages = reflection_messages || ... WHERE id=? AND jsonb_array_length(reflection_messages) = expected_length`. Bail with "stale state" if the affected-row count is 0.
- Run the Gemini call AFTER the claim succeeds (slightly trickier — you need a placeholder row state during the call, e.g., a separate `gemini_call_in_flight` flag with timeout).

---

### H2 — Prompts are referenced live, not snapshotted → teacher edits during a reflection retroactively rewrite the conversation context

**Files:**
- `apps/teacher-admin/src/lib/iframe/resolve.ts:33-50` — pulls `prompts.*` row fresh on every page render and every server action call.
- `apps/teacher-admin/src/lib/actions/socratic.ts:139-144, 200-210` — `promptBody: ctx.prompt.body` passed live into Gemini system prompt.
- `supabase/migrations/20260507150000_prompts_library.sql:1-5` — explicit design note: "Editing a prompt body propagates instantly to every assignment installed against that prompt — the student-form joins teacher_assignments → prompts to read the body live, so no Canvas re-write is needed on prompt edits."

**Root cause:** No snapshot semantics (#1).

**Failure scenario.**
- Teacher A sets prompt body to "Focus on what they learned about thesis development."
- Student starts reflection. Q1 generated using that prompt body.
- Mid-reflection: Teacher A is on the `/admin/prompts` or `/dashboard/prompts` editor and adjusts the wording. Auto-save fires (`useAutoSaveForm` — see CLAUDE memory "Editable prompts auto-save"). DB now has new body.
- Student answers Q1 and hits Send. Q2 (hardcoded — fine) appears. Student answers Q2.
- Server runs the closing Gemini call with the **new** prompt body → closing is in a different tone/style than the alignment Q.
- Worse: if the teacher edits the prompt **between two students' bootstraps**, the same assignment ends up with two different conversation styles. Teacher review of the transcript is misleading because `ctx.prompt.body` at view time is *yet another* version.
- Teacher review (`/dashboard/reviews/<course>/<assignment>`) likely shows the current `prompts.body`, not what the model actually saw — auditing this case would require a snapshot column.

Same applies to `student_facing_question` (less severe — just the displayed intake question — but a student could see Question A at intake, finish, refresh, and see Question B).

**Suggested fix.**
- Add `reflection_sessions.prompt_body_snapshot text`, `prompt_id_at_session uuid`, `prompt_version_at_session int`, populated at intake (or at first Gemini call). Read from the snapshot in `socratic.ts` and `objective-summary.ts`.
- Or snapshot at finalize for compliance/audit purposes, and call out in the dashboard that the displayed prompt is "as of finalize" vs "live."
- Suite-wide: this mirrors the OE "agent_config snapshot" issue exactly.

---

### H3 — `card_text`, `teacher_assignments.post_to_*`, `iframe_token` are also mutable refs → policy change mid-session changes destination after-the-fact

**Files:**
- `supabase/migrations/20260520120000_card_text_customization.sql` — card_text editable by teacher at any time.
- `supabase/migrations/20260520140000_destination_picker.sql:14-17` — `post_to_canvas_comment`, `post_to_canvas_submission` mutable.
- `apps/teacher-admin/src/lib/finalize/canvas-submit.ts:156` — reads `teacherAssignment.post_to_canvas_submission` live at finalize.

**Root cause:** No snapshot semantics (#1).

**Failure scenario.** Student starts a reflection at 9am with `post_to_canvas_submission=true` (so the student presumes the reflection is their submission). Teacher flips to comment-only at 11am to consolidate gradebook. Student finalizes at 2pm → reflection goes to comment, not submission body. Student thinks they've turned in the assignment; gradebook still shows `unsubmitted`. (This case is more student-trust than data-corruption, but it's real.)

**Suggested fix.** Snapshot the destination booleans on the `reflection_sessions` row at intake time, OR explicitly version `teacher_assignments` and reference the version on the session. Mirrors OE's `agent_config_version_id` pattern.

---

### H4 — Roster scrub is fail-open: missing salt / empty roster → free-text PII flows through to Gemini

**Files:**
- `apps/teacher-admin/src/lib/scrub/roster-scrub.ts:43-94`
- `apps/teacher-admin/src/lib/scrub/session.ts:30-54`

Code path:
- `compiledRosterForCourse` swallows missing-salt with `try { readSaltFromEnv() } catch { return null }` → empty CompiledRoster.
- `compiledRosterForCourse` swallows missing-roster (empty `course_rosters` row) → empty CompiledRoster.
- `scrubSessionForGemini` checks `compiled.variants.length === 0` and returns the session **unscrubbed**.

**Root cause:** Fail-open instead of fail-closed (#4).

**Failure scenarios.**
- Salt env var rotated/missing in a deploy → every reflection's pasted transcript (which may contain "Tell me about Jane Doe, who's in my class…") flows through to Gemini with real names. CLAUDE.md explicitly states this is FERPA-prohibited.
- Course roster sync hasn't run yet (or last sync errored) → same effect. CLAUDE.md also notes the roster sync used to silently store login_id as email (fixed 2026-05-20) — if that bug recurred, this scrub would still no-op because the underlying roster row is present but unusable.
- A teacher whose Canvas-side roster is small (e.g., the first student to enroll) → the scrub roster won't match other class members' names because they're not yet in the cache.

The CLAUDE.md design comment justifies this as "defense-in-depth, not a hard gate." That's a reasonable stance for transient roster-sync hiccups, but the missing-salt case in particular is more catastrophic than a roster gap — it indicates a configuration regression and should *halt* the Gemini pipeline, not silently leak PII.

**Suggested fix.**
- Hard-fail on missing salt: `readSaltFromEnv()` throws → bubble up to the action → return a user-facing "configuration error, contact your teacher" rather than silently proceeding.
- Soft-fail (current behavior) on empty roster, but **log a telemetry warning** so it surfaces in dashboards. Currently the empty-roster cache entry is silent.
- Even better: track per-session whether the scrub ran successfully on a non-empty roster, store as `reflection_sessions.scrub_status text`, and surface in the teacher review.

---

### H5 — Canvas submit double-call when Canvas accepts but local UPDATE fails

**File:** `apps/teacher-admin/src/lib/finalize/canvas-submit.ts:226-258` (`persistSuccess`).

**Root cause:** No transactional boundary (#3).

```ts
async function persistSuccess(admin, sessionId, submissionId, via) {
  const { error: updateError } = await admin
    .from("reflection_sessions")
    .update({ canvas_submission_id, state: "submitted", submitted_at: now })
    .eq("id", sessionId);

  if (updateError) {
    // Canvas accepted but we couldn't record it. Don't fail the student —
    // they still got credit. Log the discrepancy.
    await logAttempt(admin, sessionId, true, `Canvas accepted (via ${via}) but local update failed: ${updateError.message}`);
  } else {
    await logAttempt(admin, sessionId, true, ...);
  }
}
```

The `submitReflectionToCanvas` function returns `{ ok: true, submissionId, canvasUserId }` regardless of whether the local UPDATE succeeded. The session row's `state` is still `'completed'`, `canvas_submission_id` is null.

Next `finalizeReflection` call (page refresh, retry) — the idempotent fast-path at `finalize.ts:96` is `if (session.state === "submitted" && session.canvas_submission_id)`. **Neither** is true → it runs Canvas submit AGAIN. Canvas has two submissions/comments for the same student.

**Suggested fix.** If the local UPDATE fails, return `{ ok: false, error: "Canvas accepted but local state diverged; manual reconciliation needed.", needsCompletionCode: false }` and surface this loudly. Or: retry the UPDATE with backoff; if it really won't go through, mark the session in a `state='reconciliation_needed'` and queue a background reconciler.

---

### H6 — RLS on `reflection_sessions` has no INSERT/UPDATE/DELETE policies; all writes go through service-role admin client, so RLS bypass is by design but worth documenting

**Files:** `supabase/migrations/20260506000001_initial_schema.sql:162-209`.

The table has:
- `reflection_sessions_teacher_select` (teacher reads sessions on their assignments).
- `reflection_sessions_student_select` (student reads their own).
- No INSERT / UPDATE / DELETE policies.

Every write in the codebase (`intake.ts:106`, `socratic.ts:158`, `socratic.ts:182`, `socratic.ts:222/239`, `finalize.ts:169`, `canvas-submit.ts:117/232`) uses `createAdminDbClient()` which is service-role and bypasses RLS.

**Risk.** This works correctly today because every server action authenticates the user via `getServerDbClient().auth.getUser()` BEFORE switching to the admin client, then scopes the admin client's query to the auth'd user's `student.id`. **But that authorization check is hand-rolled in each server action**, not enforced by the DB.

If a future developer adds a new server action that forgets the `.eq("student_id", student.id)` filter, RLS won't catch the leak. There's no policy-level "a student can only mutate their own session" backstop.

**Suggested fix.**
- Either add explicit "no INSERT/UPDATE/DELETE from authenticated" comments + a `REVOKE ALL ON reflection_sessions FROM authenticated` so accidentally-using-the-non-admin-client at a callsite errors loudly.
- Or add a `reflection_sessions_student_modify` policy that enforces `is_student_self(student_id)` for student-initiated writes, and migrate server actions to use the regular client where appropriate. This is more work but provides real defense in depth.

Same concern applies to `students` (no INSERT/UPDATE/DELETE policies — `upsertStudentFromAuth` uses admin client) and `prompts` (per-teacher policy exists, but `system`-scope rows are admin-managed via service role).

---

## MEDIUM

### M1 — `iframe_token` validation has no length-exact check, only `< 16`

**File:** `apps/teacher-admin/src/lib/iframe/resolve.ts:21` — `if (!iframeToken || iframeToken.length < 16) return null;`.

Real tokens are 32 hex chars (`randomUUID().replaceAll("-", "")` → 32). The check accepts anything ≥ 16 chars; the DB unique-index does the actual lookup. Not a bug per se, but the check should be tighter (`!== 32 || !/^[0-9a-f]{32}$/.test(token)`) so malformed tokens fail fast without a DB round-trip. Also serves as defense against accidental log-formats that include trailing whitespace or URL params.

### M2 — No anti-enumeration / rate limiting on `/r/<token>`

**Files:** `apps/teacher-admin/src/app/(student)/r/[token]/page.tsx` + `resolve.ts`.

`resolveIframeToken` does a unique-index lookup per request. A bad actor can brute-force 32-hex-char tokens at the rate the Next.js layer accepts requests. 16^32 = 2^128 — practically unbreakable — but rate-limiting these endpoints would defend against accidental crawler waves (e.g., a teacher pastes the URL into a public document → crawlers hit it constantly).

Also: the `BrokenLink` UI message reveals "this URL doesn't match an active assignment" which is fine (it's the same response shape as a valid-but-archived assignment), but consider not even revealing whether a token is valid until the user is signed in.

### M3 — Completion code is reusable; no rotation on `submitted` → leak risk

**File:** `apps/teacher-admin/src/lib/actions/intake.ts:104-138` + `migrations/20260506000001_initial_schema.sql:69`.

The 6-char `completion_code` is generated once at intake and surfaces only on the failure path (`StudentFlow.tsx:766-779`). It lives in `reflection_sessions.completion_code` forever (no expiry beyond the 1-year session expiry).

If a teacher uses this code as "proof of completion" and accepts it manually in Canvas, a malicious student could share the code with a classmate — there's no rotation, no per-use invalidation. 32^6 ≈ 1B; brute-forceable in seconds at 10k/sec if the teacher allows free entry.

**Suggested fix.** Either (a) tie the code to a specific Canvas submission attempt (rotate on each `needsCode` surface), (b) make the teacher review surface display the same code so they can verify it matches before accepting, (c) hash the code at rest. (Low priority — the failure path is rare.)

### M4 — `objective_summary` cache invalidation is implicit on session state, not explicit

**Files:** `socratic.ts:158-164` (writes `objective_summary` on bootstrap), `finalize.ts:117` (reads it later).

If the bootstrap path fails partway (Gemini call 1 succeeds, call 2 fails), the row has `objective_summary` set but `reflection_messages` not updated (the update at line 158-164 includes both fields atomically — wait, it does both in one UPDATE. Actually fine then). 

But re-bootstrap (C3') would regenerate the summary with a different value and overwrite `objective_summary` on the row, while the AI bubble in `reflection_messages[0]` may not match → the `ObjectiveSummaryCard.filter` mentioned in C3' double-renders. Same root cause as C3'; fix the bootstrap fence and this resolves.

### M5 — Browser back-navigation during conversation can desync `step` state from server truth

**File:** `apps/teacher-admin/src/app/(student)/r/[token]/StudentFlow.tsx:259-301`.

`SignedInFlow` decides `step` from `hasActiveReflection` on mount only. If the student starts intake, navigates back, then resubmits intake (C2 scenario) — `setStep("conversation")` fires locally, but the server may not have transitioned. A reload then re-reads `hasActiveReflection` from the server, which is now true → conversation. But during the window between the click and the response, the client moves to conversation while the server hasn't yet inserted. The `nextSocraticTurn` bootstrap call then races with the intake insert — `nextSocraticTurn` may see "no session" and error out (line 84-89), forcing the student back to a confusing state.

**Suggested fix.** `onSubmitted` callback in IntakeScreen should chain `await onIntakeSubmitted()` → ONLY THEN setStep. Currently it does this correctly (line 286-289). The race is between concurrent tabs, not within one tab. Low priority.

### M6 — `finalizeReflection` "idempotent fast path" assumes webhook delivery on second call

**File:** `apps/teacher-admin/src/lib/actions/finalize.ts:96-104`.

```ts
if (session.state === "submitted" && session.canvas_submission_id) {
  return {
    ok: true, canvasSubmitted: true, completionCode: session.completion_code,
    canvasError: null, summaryGenerated: session.objective_summary !== null,
    webhookDelivered: true, // assume previously delivered; not retrying
  };
}
```

The comment "assume previously delivered" is a lie if the first attempt's webhook failed. Super-grader has its own pull-on-view recovery, so this isn't catastrophic, but if the webhook genuinely never delivered (and super-grader's pull-on-view doesn't recover because it needs the local AID record), the student sees `webhookDelivered:true` and the teacher waits forever.

**Suggested fix.** Track webhook delivery on the row (`super_grader_notified_at timestamptz`). Fast-path retries the webhook if `null`, regardless of session state.

---

## LOW

### L1 — `submitIntake`: domain-allowlist on chat URLs uses `(?:gemini|g\.co)` for both hosts in one alt
**File:** `apps/teacher-admin/src/lib/actions/intake.ts:26` — the regex `^https:\/\/(?:gemini|g\.co)\.google\.com\/(?:share|app\/.*?\/share)\/` matches `g.co.google.com` (not a real hostname) and `gemini.google.com`. Cosmetic — `g.co/share/foo` would actually match `g.co.google.com/share/foo`. Move the `g.co` alternation: `^https:\/\/(gemini\.google\.com|g\.co)\/(share|app\/.*?\/share)\/`.

### L2 — `MIN_FIRST_DRAFT_LENGTH = 50` chars is character-count, not word-count
**File:** `apps/teacher-admin/src/lib/actions/intake.ts:40`. Student can type "aaaaa..." x 50 to pass. Trivial bypass; nothing to do unless you want a smarter heuristic.

### L3 — Bootstrap context-section type padding is a code smell
**File:** `apps/teacher-admin/src/lib/actions/socratic.ts:110-129` — manually padding `ReflectionSession` shape with empty strings/null to satisfy the `generateObjectiveSummary` type signature. If a new column is added to `ReflectionSession`, this won't error at compile time only because `Tables<"reflection_sessions">` is the type and the spread+overwrite drops anything not listed. Brittle. Make `generateObjectiveSummary` accept a Pick<> type explicitly.

### L4 — `time_spent_estimate` band string is duplicated in three places
- Migration check constraint (`migrations/20260506000003`).
- Intake action allowlist (`actions/intake.ts:31-38`).
- Client constant (`StudentFlow.tsx:29-36`).

Drift risk; centralize.

### L5 — `getStudentSession.hasActiveReflection` includes `state='submitted'` → finished students see `ConversationScreen` instead of "Already submitted" UX
**File:** `apps/teacher-admin/src/lib/actions/session.ts:73`. A returning student who already finished sees the conversation thread + finalize status, which renders correctly because `nextSocraticTurn` short-circuits on `isDone`. But there's no explicit "you finished this reflection on <date>" UX. Minor product issue.

### L6 — `reflection_sessions.expires_at` defaults to `now() + 1 year`, never refreshed; sweep job not in this repo

CLAUDE.md mentions "Retention: one academic year. End-of-year sweep clears reflection data." The sweep job code wasn't found in this audit's scope. Verify it exists; verify it doesn't break the unique constraint (C1's fix) by leaving zombie rows.

---

## Cross-cutting recommendation

The five root causes the OE audit identified all apply here, in nearly identical form:

| Root cause | OE finding | AID finding |
|------------|------------|-------------|
| #1 Snapshot semantics | Agent config / prompt drift mid-session | H2 (prompts), H3 (destination + card text) |
| #2 State fences | Stale "start-exam" reservation races | C2 (intake replay), C3' (bootstrap race), C4 (finalize race), H1 (Socratic turn race) |
| #3 Transactional boundaries | Canvas + DB + webhook partial-failure | C4, H5 |
| #4 Fail-open | Salt/anonymizer silent fallback | H4 (roster scrub) |
| #5 Retry/idempotency | Double-submit on final answer | C1 (intake), C3' (bootstrap), C4 (finalize), H1 (Socratic) |

The same remediation pattern that worked for OE (M6.19) should apply here:
1. **Phase 0:** Fail-closed scrub — drop the silent fallback in `roster-scrub.ts` when salt is missing.
2. **Phase 1:** Snapshot prompts + destination flags onto `reflection_sessions` at intake. Add `prompt_body_snapshot`, `card_text_snapshot`, `post_to_canvas_*_snapshot`. Migration + read-from-snapshot in socratic.ts/finalize.ts/canvas-submit.ts.
3. **Phase 2:** Atomic "claim" RPCs for bootstrap, Q1→Q2 advance, Q2→close, and finalize. Convert read-then-write to single-statement UPDATE WHERE state=expected.
4. **Phase 3:** Stale-session sweep cron + auto-archive (mirror OE M6.19 Phase 3). Tie into C1/C2's unique-constraint fix and the M5/M6 idempotency keys.

Estimated 4-phase plan ≈ 1 week of focused work, mirrors OE M6.19 cadence (which shipped in 4 sequential commits per the recent git log).
