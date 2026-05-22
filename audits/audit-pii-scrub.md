# AID PII Scrubbing + Gemini Boundary Audit

Audit scope: PII anonymization and the Gemini-call boundary in the AI Documenter
(AID) app. Same audit lens as the OE review: emphasis on fail-closed semantics,
roster snapshots, and transcript-ingest coverage.

Files reviewed:

- `packages/anonymizer/src/{scrub,token,deanonymize,index,types}.ts`
- `packages/anonymizer/src/{scrub,token,contract}.test.ts`
- `apps/teacher-admin/src/lib/scrub/{session,roster-scrub}.ts`
- `apps/teacher-admin/src/lib/gemini/rate-limit.ts`
- `packages/gemini/src/chat.ts`
- `apps/teacher-admin/src/lib/finalize/objective-summary.ts`
- `apps/teacher-admin/src/lib/finalize/canvas-submit.ts`
- `apps/teacher-admin/src/lib/finalize/super-grader.ts`
- `apps/teacher-admin/src/lib/actions/{socratic,intake,preview,session}.ts`
- `apps/teacher-admin/src/lib/socratic/turns.ts`
- `apps/teacher-admin/src/lib/retention/csv.ts`
- `apps/teacher-admin/src/lib/sync/roster-sync.ts`
- `apps/teacher-admin/src/lib/auth/student.ts`
- `apps/teacher-admin/src/app/(student)/r/[token]/StudentFlow.tsx`
- `apps/teacher-admin/src/app/dashboard/reviews/[courseId]/[assignmentId]/page.tsx`
- `apps/teacher-admin/src/app/api/super-grader/result/route.ts`
- `supabase/migrations/20260512120000_course_rosters.sql`
- `supabase/migrations/20260506000001_initial_schema.sql`
- `supabase/migrations/20260506000003_reflection_session_intake.sql`
- `supabase/migrations/20260511103000_first_draft_and_student_facing_question.sql`
- `supabase/migrations/20260511150000_objective_summary_column.sql`

Anonymizer-drift check: AID's `packages/anonymizer/src/{token.ts,scrub.ts,
deanonymize.ts}` are functionally identical to the OE copy (only comment
divergence). `scripts/verify-anonymizer-drift.sh` covers AID and was run
mentally against the canonical fixture — no drift.

---

## Bug 1 (CRITICAL) — Free-text scrub is fail-open when roster/salt/course is missing

**Severity:** Critical — same shape as the OE bug.
**Files:**
- `apps/teacher-admin/src/lib/scrub/session.ts:30-54`
- `apps/teacher-admin/src/lib/scrub/roster-scrub.ts:43-94`

**Scenario:** `scrubSessionForGemini` is the *only* defense for free-text PII
that the student types or pastes. There are multiple paths through which it
silently degrades to a no-op while the Gemini call still proceeds:

1. **No `course_rosters` row for the Canvas course.**
   `roster-scrub.ts:54-64` — `.maybeSingle()` returns `null`; `rawStudents.length === 0`;
   `compileRoster([])` returned; cached. `session.ts:35` then short-circuits:
   `if (compiled.variants.length === 0) return session;`. The session goes to
   Gemini un-scrubbed. Probability: high — roster sync is a nightly cron
   (`syncTeacherRosters`), and a brand-new course will have no roster row
   until the first sweep completes. Adoption is grassroots; teachers can
   install AID into a Canvas assignment minutes after Canvas-connecting.

2. **`SUPER_GRADER_SALT` env var unset.**
   `roster-scrub.ts:66-80` — `readSaltFromEnv()` throws; the try/catch swallows
   it and returns `null`; same empty-roster fallback as case 1. The doc-string
   even acknowledges this: "No salt configured — return empty roster so we
   don't accidentally emit incorrect tokens. The free-text scrub becomes a
   no-op…". The comment then claims "the structured anonymizer at the
   boundary still runs" — **but no `scrubStructured` call exists anywhere in
   the AID app** (verified: `grep -r scrubStructured apps/` → only a comment
   referencing it). So the structured layer is *not* a defense; the scrub
   really is the only defense, and it's a no-op.

3. **Roster present but a particular student is missing from it.**
   If the student's own name (or a classmate's) isn't in `course_rosters` —
   common when the roster is stale relative to mid-term adds — that name is
   not in the compiled regex and survives the scrub even when other names
   are caught.

4. **`canvasCourseId === null` / `""` / `"preview"`.**
   `preview.ts:34` uses `PREVIEW_COURSE_ID = "preview"` precisely to force the
   empty-roster path, which is fine for synthetic teacher previews — but it
   normalizes the pattern of using a fake course id to bypass the scrub. If
   any future code path passes an empty/null course id to
   `scrubSessionForGemini`, the call silently succeeds with no scrubbing.

5. **Roster entry has empty/null email.**
   `roster-scrub.ts:88` — `s.email ?? ""` is fed into `anonToken`, producing
   a token keyed off `("", canvas_user_id)`. Multiple no-email roster
   entries collide on the same `Student_` prefix bucket. Probability low
   in production (Canvas usually returns email) but the silent collision is
   ugly. **More important:** this produces tokens that diverge from the
   canonical-per-contract `(canvas_user_id, lower(email))` form used
   elsewhere — same root cause as the `null`-email case in OE.

**The fundamental issue:** the docstring says the scrub is "defense-in-depth,
not a hard gate," and `session.ts:29` says "Scrub is defense-in-depth, not a
hard gate." That stance is incorrect for AID — there is no other in-depth
defense. The structured anonymizer is unused; the session row has no
structured PII fields (good — display_name/email aren't on the row); but the
*free-text* fields (`first_draft`, `paste_fallback_text`, `ai_chats[].
transcript_text`) are 100% student-typed/student-pasted content that almost
certainly contains the student's own name, classmates' names, and possibly
the teacher's. With the scrub a no-op and no other layer, **raw PII goes to
Gemini.**

**Fix direction:**

- Refuse to call Gemini at all when the scrub returns the unchanged session
  due to a missing dependency (no roster row, missing/short salt, empty
  canvasCourseId). Return `ok:false` to the caller with "PII scrub
  unavailable — try again in a few minutes" rather than silently shipping
  PII upstream.
- Distinguish "roster present but compiled to zero variants because all
  entries were filtered" from "no roster row exists" — the former is fine
  (one-student course with a Single-name student < 2 chars); the latter is
  not. The two collapse together today.
- On a brand-new course install, kick a synchronous one-shot roster pull
  before allowing the first reflection to bootstrap, the same way other
  apps do for `students` rows.
- Convert `roster-scrub.ts` catch on `readSaltFromEnv` to a throw — if the
  salt is unset, the whole app should refuse to do anything that touches
  Gemini, not silently degrade. (This is symmetric with the short-salt path
  in `anonToken`, which already throws.)
- Audit the preview path to use a different signal than course id ==
  "preview" — e.g., `compiledRosterForCourse(null)` returns a
  type-distinguishable "preview/no-scrub" value that the boundary checks
  for and explicitly allows.

---

## Bug 2 (CRITICAL) — Student-typed reflection messages bypass the scrub on the way to the second Gemini call

**Severity:** Critical.
**File:** `apps/teacher-admin/src/lib/actions/socratic.ts:175-247`,
`apps/teacher-admin/src/lib/socratic/turns.ts:73-133`.

**Scenario:** At the `length === 4` branch (student has answered the
hardcoded second question), the closing-summary Gemini call composes
`priorTurns` from `withStudent` — which is `[...prior, { role: "student",
text: studentMsg, ts: now }]` where `studentMsg` is the **raw, unscrubbed**
user input.

In `turns.ts:87-95` those `priorTurns` are mapped 1:1 into Gemini messages
with the student's text as-is. The student can — and many will — write
sentences like "I worked with Sarah on this section" or "My partner James
said the AI was repetitive." Sarah and James get shipped to Gemini in
plaintext.

The same hole exists at the bootstrap turn (`socratic.ts:102-172`): the
scrub is applied to `session` (first_draft, paste_fallback, ai_chats) but
the `priorTurns` are empty there so it's fine. Length=4 is where it bites.

Worse: `reflection_messages` is the column where these student turns are
*persisted* in `reflection_sessions`. The schema comment in
`20260511150000_objective_summary_column.sql:19` says objective_summary is
"Anonymized in / de-anonymized out." Per CLAUDE.md (§PII anonymization), the
same is supposed to hold for `reflection_messages` — "Stored anonymized in
`reflection_messages`, `objective_summary`. De-anonymize at render time
only." **That invariant is violated:** student turns are written verbatim
(`socratic.ts:179, 192, 234-236`). The next read of the row (teacher review
surface, super-grader webhook, CSV export, Canvas submission body) re-emits
the raw names back out — and the next Gemini call (closing summary) sees
them too.

**Fix direction:**

- In `socratic.ts` and `turns.ts`, scrub `studentMsg` against the compiled
  roster before appending to `withStudent` *and* before persisting to
  `reflection_messages`. Same `compileRoster`+`scrubFreeText` path the
  session scrub uses; the compiled regex is already loaded for the session
  scrub, so no extra DB hit.
- Apply symmetrically at `length === 2` (the path where the hardcoded
  second question is appended) for at-rest correctness even though no
  Gemini call follows immediately.
- Pair with Bug 1's fix: if the scrub is unavailable, refuse to accept the
  student turn (or store the turn but refuse to call Gemini), don't ship
  raw names to Gemini regardless.

---

## Bug 3 (HIGH) — `deAnonymize` is exported but never called; teacher view + Canvas write emit raw `Student_xxxxxx` tokens to humans

**Severity:** High (correctness / UX), Medium (privacy — these tokens are
internal but currently leak into Canvas where they look like garbage to
teachers and students).
**Files:**
- `packages/anonymizer/src/deanonymize.ts` (the function exists)
- `apps/teacher-admin/src/lib/finalize/canvas-submit.ts:134-148, 294-374,
  421-504` (Canvas body composition)
- `apps/teacher-admin/src/lib/finalize/super-grader.ts:124-146` (webhook
  envelope)
- `apps/teacher-admin/src/app/api/super-grader/result/route.ts:158-181`
  (pull-on-view envelope)
- `apps/teacher-admin/src/app/dashboard/reviews/[courseId]/[assignmentId]/page.tsx:67-114`
  (teacher review surface)

**Scenario:** CLAUDE.md says: "De-anonymize at render time only. Canvas
writes are de-anonymized — Canvas is on EHS's side of the privacy boundary."
The implementation does the opposite: `deAnonymize` is never called.
`grep -rn deAnonymize apps/teacher-admin/src` → zero hits.

What actually happens:

- **Objective summary** is generated by Gemini from scrubbed input + a
  prompt instructing "leave `Student_xxxxxx` tokens as-is, never use real
  names." So Gemini's output for that summary contains tokens like
  `Student_aaaaaa`. This is then stored verbatim in
  `reflection_sessions.objective_summary` (`socratic.ts:158-164`). Then:
  - Canvas submission body composition reads it as-is at
    `canvas-submit.ts:138, 329-335` (HTML) and `canvas-submit.ts:455-461`
    (plain text). **The student's Canvas submission contains
    `Student_aaaaaa` literals** when the scrub catches names referenced in
    the source material. To other classmates / teacher viewing the
    submission, that's nonsense.
  - Super-grader webhook envelope ships them raw
    (`super-grader.ts:143-144`).
  - Pull-on-view envelope ships them raw (`route.ts:177`).
  - Teacher review surface ships them raw to the client
    (`page.tsx:95-96`).
  - CSV retention export ships them raw (`csv.ts:78`).

- **Reflection messages** from Gemini (alignment question + closing) — if
  the model obeys the constraint, they'll also contain tokens. Same
  downstream emission.

This is two problems wearing one hat:

1. **UX/correctness problem in production:** teachers reading the review
   surface see `"Student_aaaaaa wrote that they found Gemini helpful…"`.
   Students reading their own Canvas submission see the same. Not a
   security leak (the token is a HMAC), but it looks broken.

2. **CLAUDE.md invariant violation:** the documented architecture says the
   teacher render path de-anonymizes. Either the docs lie or the code is
   missing the deAnonymize calls. The drift means subsequent contributors
   will read the docs, think "great, deAnonymize is handled at the boundary,"
   and reinforce the broken state.

**Compounding effect:** Bug 1 + Bug 3 together mean that in production the
scrub is mostly a no-op (Bug 1), so most submissions contain real names
unscrubbed in Canvas — which "fixes" the rendering problem at the cost of
the privacy boundary. The day Bug 1 gets fixed and the scrub starts
actually working, all production Canvas submissions will start showing
`Student_xxxxxx` literals to confused teachers. Both bugs need to be fixed
together.

**Fix direction:**

- Add `deAnonymize` calls at every render-time boundary that goes to a
  human or to Canvas. Specifically:
  - `canvas-submit.ts:buildSubmissionBody` and `buildSubmissionBodyText` —
    de-anon `firstDraft`, `objectiveSummary`, every
    `reflectionMessages[].text`, every `aiChats[].transcript_text`, and
    `pasteFallback` before HTML/text formatting. Roster source: a fresh
    `course_rosters` row at write time.
  - Teacher review surface `page.tsx:serializeForClient` — same fields.
  - Super-grader envelopes (`super-grader.ts:buildEnvelope`,
    `route.ts:envelope`) — **decide**: super-grader is on the EHS side too
    (per integration-contract); but the envelope carries `anon_token` as a
    join key, and the AI Use card on super-grader's side may want
    de-anonymized text. Check super-grader's expectations and align.
  - CSV retention export — same fields.
- Note: this requires the roster to be loadable at write time, with the
  same `(teacher_id, canvas_course_id)` resolution as the scrub path. If
  the scrub failed open (Bug 1), so will the de-anon — but de-anon failing
  open is fine (token survives), whereas scrub failing open is the
  catastrophic case.

---

## Bug 4 (HIGH) — `course_rosters` row picked by `eq("canvas_course_id", id).limit(1)` is non-deterministic across teachers

**Severity:** High.
**File:** `apps/teacher-admin/src/lib/scrub/roster-scrub.ts:51-58`.

**Scenario:** The `course_rosters` primary key is
`(teacher_id, canvas_course_id)` per
`supabase/migrations/20260512120000_course_rosters.sql:15`. The scrub query
only filters on `canvas_course_id`. When two teachers both have AID
installed on the same Canvas course (co-teaching, cross-listed sections,
shared electives) Postgres returns whichever row matches first — typically
last-inserted, but not contractually so. The two rosters might disagree on
membership (different roster-sync timing, one cron failed, one teacher
hasn't connected Canvas yet so their row is empty).

Consequence: the compiled regex used to scrub a student's transcript may be
derived from a different teacher's view of the course. If the student's
*own* teacher's roster row is empty but a co-teacher's is populated, the
scrub works fine — lucky. The reverse case fails open. Today this is mostly
academic at EHS scale, but the AID architecture decision is "any teacher
who's synced it" (`roster-scrub.ts:21-23`), so this is intentional and the
worst case is "we use the wrong teacher's roster."

The bigger issue: **no snapshot semantics.** The scrub uses the live roster
plus a 5-minute process-level cache. If a roster is updated mid-conversation
(student added/removed), the first Gemini call sees one regex and the
closing-summary call sees another. For most cases, fine. But if a name is
ADDED to the roster between the two calls, the bootstrap's first_draft
scrub may have missed a classmate name that the closing scrub catches —
the at-rest stored `objective_summary` carries the real name while the
later `reflection_messages` carry tokens. Plus: when the student's session
is reviewed later by the teacher, the de-anon (Bug 3 — once fixed) will
substitute the wrong display name if the roster has rotated.

**Fix direction:**

- Resolve `course_rosters` by `(teacher_id, canvas_course_id)` where
  `teacher_id` is the row that owns the session (joined from
  `teacher_assignments`). Falls back to "any teacher for that course" only
  if that exact row is missing.
- Snapshot the compiled roster at session-bootstrap time and store a hash
  (or the raw token-list) on the session row, so every subsequent scrub
  for that session uses the same compiled view. Same idea as the M6.19
  snapshot work in OE.
- Drop the 5-minute process-level cache in favor of either no cache (DB
  read is cheap) or a per-session snapshot. The cache as it stands is the
  worst of both worlds: not authoritative for snapshot semantics, and
  delays roster-add propagation by up to 5 min.

---

## Bug 5 (HIGH) — Salt-missing path is FAIL-OPEN; salt-too-short path is fail-CLOSED. Wrong direction.

**Severity:** High.
**Files:**
- `packages/anonymizer/src/token.ts:46-55` (throws on missing salt)
- `apps/teacher-admin/src/lib/scrub/roster-scrub.ts:66-80` (catches and
  proceeds with empty roster)

**Scenario:** `readSaltFromEnv()` throws on empty/unset `SUPER_GRADER_SALT`
— good. But `roster-scrub.ts` wraps that call in a try/catch that swallows
the throw and returns `null`, then falls through to the empty-roster
no-op. So the strongest defense (refuse to do anything) becomes the
weakest (allow Gemini with raw text).

Compare with `token.ts:24-29`: salt too short (<16 bytes base64-decoded)
also throws, with the same shape. **That throw is NOT caught** by the
roster-scrub layer — it propagates inside `.map((s) => anonToken(...))` on
line 88 of `roster-scrub.ts`, blows up the action, and surfaces to the
student as a 500 (fail-closed — Gemini is not called).

So the same class of misconfiguration produces opposite outcomes depending
on which exact failure mode the operator hits. "I forgot to set the salt"
silently leaks PII; "I set the salt to a 5-byte test value" surfaces as a
hard error. Neither path tells the operator what's wrong; both are PII
boundary failures.

**Fix direction:**

- Remove the try/catch around `readSaltFromEnv` in `roster-scrub.ts:67-75`,
  let the throw propagate, fail-closed (no Gemini call). Add the same
  fail-closed treatment to the empty-roster path (Bug 1).
- Add a startup check in the boot path that calls `readSaltFromEnv` once
  and refuses to start the app if it throws. Symmetric with the existing
  Inngest signing-key / Canvas crypto-key boot checks. Surfaces the
  misconfig at deploy time, not at first-student time.

---

## Bug 6 (MEDIUM) — `students.anon_token` is generated with `canvas_user_id=""`, diverges from canonical until Canvas submission backfill

**Severity:** Medium.
**Files:**
- `apps/teacher-admin/src/lib/auth/student.ts:48` (signup-time token)
- `apps/teacher-admin/src/lib/finalize/canvas-submit.ts:110-119` (re-key on
  first Canvas submission)

**Scenario:** On Google SSO into AID, `upsertStudentFromAuth` computes the
token as `anonToken("", email, salt)`. This is NOT the canonical
`anonToken(canvas_user_id, email, salt)` defined in integration-contract §2
and produced everywhere else in the ecosystem (super-grader, OE, etc.).
The token only converges to canonical form when the student's first
reflection finalizes and `canvas-submit.ts:110-119` re-keys.

Consequences:

1. **Cross-tool join key drift.** The super-grader webhook envelope
   (`super-grader.ts:129`) includes `anon_token: student.anon_token`. For a
   student's *first* reflection ever, this token doesn't match what
   super-grader / OE would compute for the same student. Super-grader's
   ingest is idempotent on `(peer, canvas_user_id, canvas_assignment_id)`,
   so the join key isn't the anon_token directly — but if super-grader's
   AI Use card cross-references anon_tokens across peers (or if any future
   join does), the mismatch breaks it. (Plus: the webhook is fire-and-
   forget; if the backfill happens after the webhook fires, super-grader
   has the old shape forever.)

2. **Scrub/session-token mismatch.** The token passed into Gemini prompts
   as the student identifier (`socratic.ts:128, 141, 204`,
   `objective-summary.ts:143`) is `students.anon_token` — the
   "`canvas_user_id=""`" form on a first session. Meanwhile the roster
   scrub computes tokens from `(canvas_user_id, email)` —
   `roster-scrub.ts:88`. So the same student's own name (if present in
   their pasted transcript) gets replaced by a *different* token than
   the one the Gemini prompt is told represents them. The model sees
   "the student you're coaching is Student_aaaa11" and a transcript
   containing "Student_bbbb22 wrote about…" where bbbb22 is in fact the
   same student. Confusing for the model; cosmetically broken in the
   stored summary.

**Fix direction:**

- Resolve `canvas_user_id` at sign-up time. Either via Canvas SCIM-like
  lookup (requires a teacher to have already synced the course's roster
  including this student) or by deferring student-row creation until the
  first roster match resolves their canvas_user_id.
- Until then, when generating the bootstrap token in `student.ts:48`, fall
  back to a roster lookup if any teacher in this course has the student in
  their `course_rosters`. If a match is found, use the canonical form.
- Document the divergence in CLAUDE.md (PII anonymization section) until
  fixed.

---

## Bug 7 (MEDIUM) — URL-context fetches share-link contents server-side; the linked content is never seen by AID's scrubber

**Severity:** Medium (likely accepted risk, but should be explicit).
**Files:**
- `apps/teacher-admin/src/lib/finalize/objective-summary.ts:110-113`
  (`urlContext: true`)
- `packages/gemini/src/chat.ts:74-78` (sends `url_context: {}` tool)

**Scenario:** When the student supplies share-link URLs (ChatGPT/Claude
share links), the AID server scrubs `ai_chats[].transcript_text` — but
that field is `null` unless the student additionally pasted the transcript
into the paste-fallback. The `url` itself stays in the prompt. With
`urlContext: true`, Gemini fetches those URLs server-side (Google's
infrastructure), retrieves the linked conversation HTML, and incorporates
it into its context.

The student's name almost certainly appears in those linked conversations
(e.g., ChatGPT renders "You" but Claude renders the user's name on the
share-link page). The roster-derived scrubber never sees that content and
can't redact it. The architectural assumption is that all student data
flows through Google anyway because the Gemini API key is hosted there;
the URL-context fetch is just another path to the same destination.

Whether this is acceptable depends on whether the LLM is allowed to see
real names at all. CLAUDE.md says "student names, emails, and any other
identifiers must **never** reach Gemini." Under that contract, URL-context
is a hole.

**Fix direction:**

- Document this gap explicitly in CLAUDE.md (PII section). Either accept
  the hole or close it.
- To close it: drop `urlContext: true` entirely (paste-fallback is already
  documented as "the reliable path"). The cost is losing best-effort
  grounding when the student provides only a link without a paste — small
  in practice, and the M3 design already treats pasted text as canonical.
- Alternatively, fetch the share link server-side ourselves, scrub the
  content against the compiled roster, and pass the scrubbed text instead
  of the URL. Heavy lift; per-provider scrapers are noted as a planned
  `packages/transcript-ingest/` in CLAUDE.md but not yet built.

---

## Bug 8 (MEDIUM) — Process-level roster cache is global per `canvas_course_id`, ignores teacher partition

**Severity:** Medium.
**File:** `apps/teacher-admin/src/lib/scrub/roster-scrub.ts:35-94`.

**Scenario:** The cache map is keyed by `canvasCourseId` only. Two teachers
on the same course will share a cache slot — the first one's lookup wins
and the second one's roster is masked for 5 min. Compounds with Bug 4
(the `.limit(1)` query already returns a non-deterministic teacher) — the
cache freezes whichever teacher's row Postgres returned first, even if
that's the empty-roster teacher.

Also: cache survives across teachers but doesn't differentiate the
"failed-load returned empty" case from the "genuinely empty roster"
case. So a transient DB error during roster fetch poisons the cache for
5 min with an empty compiled regex.

**Fix direction:**

- Key the cache by `(teacher_id, canvas_course_id)` once Bug 4's fix is in.
- Don't cache the empty-roster result; let it re-try on each call so a
  transient miss isn't sticky.
- Add a roster-changed hook (insert/update on `course_rosters`) that
  invalidates the cache for that key.

---

## Bug 9 (LOW) — `getStudentSession` and other reader paths expose unscrubbed `first_draft` and `objective_summary` to the student's browser

**Severity:** Low (the student already wrote this content, so it's their
own data; the privacy hit is if the model produced tokens and they're
showing as gibberish — see Bug 3).
**Files:**
- `apps/teacher-admin/src/lib/actions/session.ts:73-79` (objectiveSummary
  passed to client)
- `apps/teacher-admin/src/app/(student)/r/[token]/StudentFlow.tsx:104,
  519-520, 647-648` (renders objectiveSummary directly)

**Scenario:** The student-side conversation screen renders
`objective_summary` in a card. Today (Bug 1's fail-open state) this
contains real names — the student's and their classmates'. The student
sees their own name, which is fine; they also see classmates' names that
the AID coach prompt was supposed to scrub on the way to Gemini. So a
classmate's name written in pasted transcript leaks to the original
student via the rendered objective summary — even before any teacher
touches it.

This is technically the same root cause as Bug 1 (scrub no-op), but the
in-app rendering surface is worth calling out separately because fixing
Bug 1 alone fixes the Gemini leg without fixing this one — once tokens
flow through correctly, the student would see `Student_xxxxxx` literals
which is its own UX problem (overlaps with Bug 3).

**Fix direction:**

- Apply Bug 3's de-anonymize fix on the student-side render path too. The
  student is allowed to see their own and classmates' real names (it's
  EHS-internal); de-anon at render is the right move.

---

## Bug 10 (LOW) — Rate-limit gate fails OPEN on DB error

**Severity:** Low (the daily cap is a cost-control mechanism, not a
privacy boundary, so fail-open here is reasonable — but worth noting in
the same audit because the comment explicitly endorses fail-open as a
pattern, which can leak into other parts of the codebase).
**File:** `apps/teacher-admin/src/lib/gemini/rate-limit.ts:37-50`.

**Scenario:** `checkAndReserveGeminiCall` calls a Postgres RPC. On RPC
error, the function returns `{ allowed: true, ... }` with a console.error.
This is a deliberate choice (the inline comment defends it: "The rate
limiter should never block a real Gemini call due to a DB hiccup"). The
choice is fine for billing.

However: if the same fail-open instinct creeps into the PII scrub layer
(it already has — see Bug 1, Bug 5), it's catastrophic. The two-paragraph
inline comment here normalizes that pattern. Worth contrasting in
CLAUDE.md: rate-limit fail-open ≠ scrub fail-open. The former costs money;
the latter costs students.

**Fix direction:**

- Add a comment to `rate-limit.ts` explicitly distinguishing this from the
  scrub layer ("This fail-open is acceptable because it's a cost gate, not
  a privacy gate. Do NOT mimic this pattern in `scrub/`.").
- No functional change.

---

## Test coverage assessment

`packages/anonymizer/src/scrub.test.ts`, `token.test.ts`, `contract.test.ts`
are thorough on the *positive* paths:

- contract.test.ts pins the wire format against an in-file reference and a
  golden token. Catches drift in token shape, ordering, case
  normalization. ✓
- token.test.ts checks empty/short salt rejection. ✓
- scrub.test.ts covers possessives, hyphen splits, case-insensitivity,
  multi-student paragraphs. ✓

What the tests DO NOT catch (and which would have caught Bugs 1, 2, 5, 8):

- No test exercises `scrubSessionForGemini` or `compiledRosterForCourse`.
  Those live in `apps/teacher-admin/src/lib/scrub/` and have no test
  partner. The contract for the boundary (what happens on missing roster,
  missing salt, missing course id) is undocumented and untested.
- No test asserts that a Gemini call is REFUSED when the roster is empty.
  A test in that shape — "scrub returned no variants → calling Gemini
  with this session is forbidden" — would fail today, by design (the
  current code allows it). Adding such a test would freeze the desired
  behavior.
- No test asserts that the student-message turn is scrubbed before being
  appended to `reflection_messages` (Bug 2).
- The "drift" script (`scripts/verify-anonymizer-drift.sh`) tests only
  token equality across the 5 apps. It does NOT test that the SCRUB
  boundaries behave the same — and they don't (HH has a different shape
  per CLAUDE.md). Out of scope for this audit but worth flagging.

**Recommendation:** add a `packages/anonymizer/src/boundary.test.ts` (or
`apps/teacher-admin/src/lib/scrub/boundary.test.ts`) that exercises the
fail-closed contract directly. A few specific tests:

- `scrubSessionForGemini` with no `course_rosters` row → should throw OR
  return a sentinel that the caller refuses to ship to Gemini.
- `scrubSessionForGemini` with missing `SUPER_GRADER_SALT` → should throw.
- `scrubSessionForGemini` with empty roster but explicit "preview" mode →
  returns identity transform but caller has an explicit opt-in flag.
- Student message containing a roster name + a non-roster name → the
  roster name is scrubbed, the non-roster name passes through (this is
  the current behavior, but documenting it is good).

---

## Summary

Top-line: the AID PII boundary repeats the OE fail-open pattern almost
exactly — same source structure, same docstrings, same comment that
endorses "defense in depth, not a hard gate." Bugs 1, 2, and 5 together
mean that under normal failure modes (missing roster row, missing salt,
student types a classmate name), real names reach Gemini. Bugs 3 and 6
mean the contract documented in CLAUDE.md (de-anon at render time;
canonical anon_token) is not implemented. Bugs 4 and 8 are
snapshot/concurrency issues that compound the others.

The single most important fix is to make the scrub a HARD GATE: empty
roster → refuse Gemini call. Once that's in place, the rest of the bugs
reduce in severity or become straightforward.
