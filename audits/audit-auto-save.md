# AID Auto-Save / Server-Action Audit

**Scope:** auto-save layer (`components/auto-save/*`), the screens that
use it (`/admin/prompts`, `/admin/card-text`, `/dashboard/setup` card-text,
`/dashboard/prompts`), and the server actions they invoke
(`system-prompts.ts`, `prompts.ts`, `card-text.ts`, `course-policy.ts`,
`canvas-token.ts`, `canvas-install.ts`, `canvas-sync.ts`, `admins.ts`).

Lens: the five suite-wide root causes (snapshot, state fences,
transactional boundaries, fail-open, idempotency) plus AID-specific
auto-save concerns. Severity skews **high** when teacher work can be
silently lost.

---

## Finding 1 — **HIGH** — `/dashboard/prompts/PromptCard.tsx` is NOT on auto-save (regression vs. CLAUDE.md)

**File:** `apps/teacher-admin/src/app/dashboard/prompts/PromptCard.tsx:1-253`

The CLAUDE.md memo (and the global memory note) explicitly state the
auto-save pattern is applied to "AID `/admin/prompts` + `/admin/card-text`,
HAH `/admin/prompts`, HH `/admin/prompts`, SG `/dashboard/prompts`" and
that "imperative actions stay button-driven, auto-save is for editable
text fields only."

But AID's teacher-side prompt editor (`/dashboard/prompts/PromptCard.tsx`)
still uses **controlled inputs + an explicit Save button + a "Discard
changes" button**:

- Lines 19-23: `useState` for label, sfq, body — controlled.
- Lines 38-56: `onSave` only fires from the Save button click.
- Lines 178-191: explicit "Save / Discard changes / Cancel" UX.
- Lines 51: on successful save, `setExpanded(false)` collapses the card —
  which is itself a UX regression vs. auto-save (you lose your scroll
  context every save).

This is a real divergence, not just style:
1. Teachers have an actual "Discard changes" path here, contrary to the
   suite-wide promise that "discard-without-saving is intentionally NOT
   supported."
2. The component does not import `useAutoSaveDispatch` /
   `useAutoSaveForm`, so the bottom-right pill on the `/dashboard/prompts`
   page never lights up for teacher-owned prompt edits.
3. The page.tsx (line 1-129) does NOT wrap children in `AutoSaveProvider`
   at all — so even if `PromptCard` tried to dispatch, it would `throw`
   per `context.tsx:34-36`.
4. The "fail-open" rule says a failed save should keep the user's typed
   text. This screen still does that (controlled state), but the
   teacher-facing feedback is now a green/red text line (`PromptCard.tsx:240-248`)
   that disappears when the card collapses.

**Scenario:** teacher edits a personal prompt, types a long body, clicks
Save. Save fails (RLS revoke mid-session, Canvas-token decrypt path is
not used here but a network blip is enough). Banner shows "error
message". Teacher hits "Edit" again on a sibling card → loses the
feedback context. They reload → the unsaved typed text is gone (controlled
state evaporated, DB has the old value).

**Fix direction:** port this screen to the auto-save pattern used by
`SystemPromptCard.tsx`. The reference shape is already in this repo —
just mirror it (uncontrolled inputs + refs + `useAutoSaveForm` +
`useAutoSaveDispatch`), and wrap `dashboard/prompts/page.tsx` in
`<AutoSaveProvider>`. Drop the Discard button (suite policy). Until that
port lands, the suite-wide memory note in
`feedback_editable-prompt-auto-save.md` should at minimum be corrected
to flag AID's teacher-prompts page as the holdout.

---

## Finding 2 — **HIGH** — `/dashboard/setup/CardTextEditor.tsx` is NOT on auto-save and ships a Save button (same regression)

**File:** `apps/teacher-admin/src/app/dashboard/setup/CardTextEditor.tsx:35-153`

Same divergence as Finding 1, in the second of two teacher-facing
card-text surfaces (the admin-side `/admin/card-text/CardTextDefaultsEditor.tsx`
*does* auto-save correctly).

- Lines 35-39: five `useState` calls — fully controlled.
- Lines 53-64: `handleSave(fd)` is fired from `<form action={handleSave}>` —
  i.e. only on explicit form submit (the "Save card text" button at line 139).
- Lines 137-153: bespoke "Saving… / Saved." status string mixed into the
  same `setState` slot as the error message — line 78 sets `setStatus(result.error)`
  so the variable is overloaded as both state-machine token and raw
  error string. Then lines 145-152 rely on the string NOT equaling
  "idle"/"saving"/"saved" to detect error. If a future error message
  contains the substring "saved" it will be silently misclassified
  as a success.

Knock-on issue: the reset-to-default per-field action (`handleReset` at
line 66) **immediately** writes to the DB but does NOT also flush the
user's other pending in-memory edits. So:

**Scenario:** teacher edits kicker AND title (controlled state, dirty
in memory, NOT yet sent to the server). They click "reset to default"
on the body field. `resetMyCardOverride` runs and persists `card_body=NULL`
on the server. But the user's typed-but-unsaved kicker/title edits stay
in client state. They navigate away or refresh; their edits are gone.
The fail-open promise is violated.

**Fix direction:** port to the auto-save pattern used by its sibling
`CardTextDefaultsEditor.tsx` (which already auto-saves correctly). Or
at minimum make `handleReset` first flush the current form (one combined
update) before clearing the field. Disambiguate the status state machine
into a typed union (`AutoSaveStatus` already exists in
`AutoSaveStatusPill.tsx:5-9`).

---

## Finding 3 — **HIGH** — No `version` / `updated_at` guard on prompt or card-text writes (two-tab silent overwrite)

**Files:**
- `apps/teacher-admin/src/lib/actions/system-prompts.ts:96-108` (saveSystemPrompt)
- `apps/teacher-admin/src/lib/actions/prompts.ts:92-104` (savePrompt)
- `apps/teacher-admin/src/lib/actions/card-text.ts:74-79` (updateCardTextDefaults)
- `apps/teacher-admin/src/lib/actions/card-text.ts:153-157` (updateMyCardOverrides)

Every one of these `.update(...).eq("id", …)` calls is unconditional —
last write wins. There is no `updated_at` / `version` fence in the
`WHERE` clause, and the result types
(`SaveSystemPromptResult = { ok: true } | { ok: false; message }`) don't
return the new `updated_at` for the client to compare against.

This is exactly the failure mode OE flagged: two tabs open on the same
prompt, each types half a sentence, the slower one wipes the faster
one's text. Worse here because auto-save fires on **800ms** debounce — a
teacher who has the same admin prompt open on a laptop and a desktop
during a quick edit pass produces multiple overlapping saves within
seconds.

Detection difficulty compounds it:
- `SystemPromptCard.tsx:82-88` keys the `useAutoSaveForm` freshness on
  `prompt.updated_at`, but `prompt.updated_at` only refreshes when the
  Next.js page re-renders after `revalidatePath("/admin/prompts")`.
- The pill (`AutoSaveStatusPill.tsx`) shows green "Saved · just now"
  even when the server-side row now contains the *other* tab's text.

**Scenario:** two browser tabs A and B on `/admin/prompts`, both showing
the same Default reflection prompt v1. Teacher edits in tab A (debounced
save at t=800ms with body="X"). Teacher switches to tab B (tab A's
visibilitychange fires the save immediately; assume it already finished).
Teacher in tab B sees the OLD body (tab B's defaultValue still "v1"),
types "Y" → at t=2800ms tab B's auto-save fires with body="Y", wiping
"X". Both tabs show green "Saved · just now". No conflict surfaced.

**Fix direction:** add `updated_at` to the actions' read/return shape;
include `.eq("updated_at", expectedUpdatedAt)` in the `.update(...)`;
inspect `count` from `{ count: "exact" }` to detect 0-rows-affected and
return `{ ok: false, message: "Someone else edited this prompt — refresh to see the latest." }`.
Then surface that as a red pill via the existing `dispatch({ kind: "error" })`
path. Re-baseline the client's freshness key on the new updated_at the
server returns.

---

## Finding 4 — **HIGH** — `revalidatePath` after every auto-save re-renders the editor mid-typing (uncontrolled inputs survive, but `useEffect` re-runs and `defaultValue` resets are at risk)

**Files:**
- `apps/teacher-admin/src/lib/actions/system-prompts.ts:110-113`
  (`saveSystemPrompt` revalidates `/admin/prompts`, `/dashboard/prompts`,
  `/dashboard`)
- `apps/teacher-admin/src/lib/actions/prompts.ts:106-108` (same)
- `apps/teacher-admin/src/lib/actions/card-text.ts:81-83`
  (updateCardTextDefaults revalidates BOTH `/admin/card-text` AND
  `/dashboard/setup`)
- `apps/teacher-admin/src/lib/actions/card-text.ts:159` (per-teacher overrides
  revalidate `/dashboard/setup`)

Every save mutates the page server-side cache, which on Next 16 with a
server-rendered `page.tsx` triggers an RSC payload refresh. The client
`SystemPromptCard` (line 14-89) takes `prompt` as a prop — when the
parent re-renders with a fresh `prompt.updated_at`, the
`useAutoSaveForm` effect's dependency array (`freshnessKey:
${prompt.updated_at}:${expanded ? "open" : "closed"}`) changes and the
effect re-runs.

Two implications:
1. The teardown→setup cycle re-binds `input`/`change`/`focusout`/
   `visibilitychange` listeners. Any pending `setTimeout` (line 71)
   is wiped (the cleanup at line 94 calls `clearTimeout`), but
   `saveRef.current` still holds the latest `save` closure so a
   re-render mid-debounce loses 0-800ms of work the user just typed.
   Specifically: if at t=0 user types "a", debounce starts; at t=400ms
   server returns from the *previous* save and revalidatePath fires;
   `prompt.updated_at` arrives, freshnessKey changes, the effect tears
   down and the pending t=800ms timer for "a" is cancelled — no save
   ever fires for "a". On the NEXT keystroke things resume, but if the
   user pauses, "a" is unsaved (lives only in DOM); a refresh / nav
   wipes it.
2. The uncontrolled inputs keep their text in the DOM (good), but
   `defaultValue` was manually re-baselined on the previous save success
   (line 65-74). The RSC refresh swaps in a fresh React-side
   `defaultValue={savedBody}` JSX literal — since the input element is
   the same DOM node (React keys haven't changed), React skips
   re-applying `defaultValue`. So this is **probably** safe, but it's
   fragile: any future change that bumps a `key` or wraps the textarea
   conditionally will silently lose the in-flight text.

**Scenario:** admin holds shift and types fast. Each 800ms-clean burst
triggers a save → revalidatePath → server re-render → fresh prop. If
the typing is fast (>1 word/sec sustained), most of the save round-trips
land mid-keystroke and the freshness-key flip cancels the pending timer
for the most-recently-typed character cluster.

**Fix direction:** stop revalidatePath-ing for inline auto-save updates.
The page does its own data fetch on next render; the editor itself
re-baselines its own DOM. For `/admin/prompts`, the only consumer that
needs the new `updated_at` instantly is the per-card freshness key,
which can be advanced client-side from the action's response (return
the new `updated_at`). For `/dashboard/setup/CardTextEditor.tsx`, similar.
Keep the cross-route `revalidatePath` only for actions where another
route's rendered data actually depends on the value (e.g.,
`updateCardTextDefaults` invalidating `/dashboard/setup` is correct *across*
users, but for the editing admin's own session it's wasted work).

---

## Finding 5 — **HIGH** — `SystemPromptCard.save()` doesn't serialize / debounce concurrent submissions; idempotency relies on `useTransition` alone

**File:** `apps/teacher-admin/src/app/admin/prompts/SystemPromptCard.tsx:44-80`

The hook fires `save()` on three triggers (input-debounce, blur,
visibilitychange). If a teacher blurs the textarea at the exact moment
the 800ms timer is about to fire, `fire()` calls `save()` once
synchronously, then the next debounce cycle can call `save()` again
within the same `startTransition` window:

- `useAutoSaveForm.ts:59-66` `fire()` clears the timer THEN calls
  `saveRef.current()`. Good.
- `useAutoSaveForm.ts:80-82` `onVisibility` calls `fire()` too. Good.
- But `useAutoSaveForm` does **not** guard against `save()` being called
  while a previous `save()` is already in-flight. `SystemPromptCard.tsx`
  wraps with `startTransition`, but `useTransition`'s `pending` is NOT
  read by `save()` to short-circuit re-entry.

Compound case: blur fires `save()`, then visibilitychange fires `save()`,
then the user-agent tab-close fires `save()` again via beforeunload-ish
behavior. Three concurrent `startTransition` calls each computing
`labelChanged` against the SAME `labelRef.current.defaultValue`. Two of
them will see "yes changed" (because the FIRST hasn't completed yet —
defaultValue hasn't been re-baselined per lines 64-74); both submit the
identical body. Database `update` ends up idempotent in this exact case
(same body either way) — but if the user typed between calls, save #2's
body could clobber save #1's response timing in a Promise.all-ish race
and the re-baselining at line 65-74 happens on whichever resolves last.
Since the pill is "saved" both times the teacher has no signal.

**Scenario:** teacher types last sentence, hits Cmd+T to open a new tab.
This fires both blur (focusout) and visibilitychange synchronously. Two
near-simultaneous `saveSystemPrompt` invocations. If the user typed once
more during the gap (it happens — modern keyboards fire repeat events),
the late-arriving response re-baselines `defaultValue` to a value the
user has since edited again, and the *next* save thinks the input is
not dirty (`isFormDirty` is false because `value === defaultValue` was
just re-aligned).

**Fix direction:** add a `savingRef` (or a single-flight queue) inside
`useAutoSaveForm`: if a save is in flight, set a "needsAnotherSave"
flag; on completion, fire one more save iff still dirty. Mirrors the
HAH / SG / OE single-flight pattern (worth checking sibling repos in
M5 consolidation work). At minimum, fold a `pending` check into
`SystemPromptCard.save()` itself: `if (pending) { queueMicrotask(save);
return; }`.

---

## Finding 6 — **MEDIUM** — `AutoSaveProvider` aggregator silently loses errors when a second editor succeeds right after

**File:** `apps/teacher-admin/src/components/auto-save/context.tsx:17-29` +
`AutoSaveStatusPill.tsx:17-62`

When two `SystemPromptCard`s on `/admin/prompts` save in quick
succession:
- Card A's save fails → `dispatch({ kind: "error", msg: "..." })` →
  pill shows red.
- Card B's save (already debounced from earlier typing) finishes
  ~50ms later → `dispatch({ kind: "saved", at: ... })` → pill flips
  back to green.

The admin who was watching the pill never sees that Card A's edit
didn't save. There's no "any-error-sticks" policy and no per-editor
breadcrumb in the aggregator state.

**Scenario:** admin opens two cards (or types into one then the
seeded objective-summary card, which is *always* present per
`/admin/prompts/page.tsx:87-103`). They edit both. One fails (say, the
objective-summary body trim becomes empty → server returns "Body can't
be empty"). The other passes. Aggregator pill shows green "Saved" by
the time the admin glances at it. They tab away believing both saved.
DB has card-A still on the prior body; card-A's textarea still shows
their new text. They navigate back, refresh — their unsaved text is
gone.

**Fix direction:** track an `errors: Set<string>` (keyed by editor id)
inside the provider. Pill renders red whenever the set is non-empty,
showing the most-recent error. Each editor calls `clear(id)` when its
own next save succeeds. Alternatively, surface a per-editor inline
status (small red dot on the card header) in addition to the aggregated
pill.

---

## Finding 7 — **MEDIUM** — `useAutoSaveForm.isFormDirty` skips select / radio / checkbox dirty-resets after save

**File:** `apps/teacher-admin/src/components/auto-save/useAutoSaveForm.ts:5-26`
+ `apps/teacher-admin/src/app/admin/card-text/CardTextDefaultsEditor.tsx:78-90`

`isFormDirty` checks `el.defaultSelected` for select options and
`el.defaultChecked` for radio/checkbox, which is correct for detecting
dirtiness. But the **re-baseline loop** in
`CardTextDefaultsEditor.tsx:79-90` only covers `HTMLInputElement` (non-
hidden, non-submit, non-button) and `HTMLTextAreaElement`. There is no
`HTMLSelectElement` or radio/checkbox branch.

Today this is latent because the three auto-saving screens
(`/admin/prompts`, `/admin/card-text`, sibling `SystemPromptCard.tsx`)
all use only text/textarea fields. But the hook documents itself as a
general-purpose auto-save trigger, and the next person who adds a
checkbox or `<select>` to one of these forms will hit a bug where the
form is reported as dirty forever after the first save (because the
checkbox's `defaultChecked` never gets re-baselined to its new
`checked` state).

The selects case has a second subtle bug: lines 20-22 iterate
`el.options` and compare `opt.selected !== opt.defaultSelected`. Setting
`defaultSelected` only fixes one option; if the user changed the
selected option, the *previously*-selected option's
`defaultSelected=true` flag would also need clearing. So the re-baseline
needs to walk all options and align `defaultSelected` to current
`selected`.

Also, **file inputs** (`type="file"`) are not in the dirty check at all
— they fall into the `else if` for `HTMLInputElement` with `type !==
"hidden"/"submit"/"button"`, which then compares `value !==
defaultValue` (line 15). For files, `value` is the spoofed
`"C:\fakepath\..."` and `defaultValue` is always `""` — so a file input
will *always* report dirty and auto-save would fire on every focusout.
Latent today (no file inputs in scope), but worth a guard.

**Fix direction:** extract the re-baselining into a shared helper in
`useAutoSaveForm.ts` (`reBaselineForm(form)`) that handles every form-
element kind symmetrically; have `CardTextDefaultsEditor` call it
instead of inlining; explicitly skip `type === "file"` in `isFormDirty`.

---

## Finding 8 — **MEDIUM** — Fail-open is honored for text, but the green-pill timing means teachers think their save succeeded after a stale error

**File:** `apps/teacher-admin/src/components/auto-save/AutoSaveStatusPill.tsx:17-62`

The pill goes idle → saving → saved/error. But after an error, **the
next save success unconditionally returns it to green**. There is no
"sticky for N seconds after error" or "user must acknowledge". A
transient network blip could:

1. t=0s: user types; debounce fires save → error.
2. t=200ms: user types again (still in the typing pass); debounce
   fires save → success.
3. Pill flips error → green within 1 second; user never sees the error.

For long edit sessions this is harmless (a retry that succeeds *is* what
the user wanted). But it interacts badly with Finding 3 (no state
fence): a "saved" green after a concurrent-edit clobber tells the user
their text is durable when it's already been silently wiped by another
tab in flight.

There's also a minor render bug: lines 19-23 do
`if (seenKind !== status.kind) { setSeenKind(status.kind); if
(status.kind === "saved") setLastSavedAt(status.at); }` — calling
setState during render. React tolerates this only when the new state
is a direct function of props; here it works, but it warns on Strict
Mode and will break under React's experimental compiler if it ever
optimizes the read order.

**Fix direction:** track a "sawError: true" flag that persists until
the user interacts again with the same card. Or surface an inline
per-card "saved at HH:MM" tooltip with the actual timestamp, so the
"saved · just now" pill is a hint not a guarantee. Move the in-render
`setState` into a `useEffect`.

---

## Finding 9 — **MEDIUM** — `deleteSystemPrompt` / `deletePrompt` fire a chain of Canvas writes inside an auto-save UX context; partial-failure UX is the pill, which is misleading

**Files:**
- `apps/teacher-admin/src/lib/actions/system-prompts.ts:155-272`
- `apps/teacher-admin/src/lib/actions/prompts.ts:111-271`

Delete is an imperative button (good — matches the suite policy), but
it dispatches through the same `dispatch({ kind: "saving" })` pill as
auto-save (lines 91-101 in `SystemPromptCard.tsx`). The delete server
action is doing real work: iterating every binding, decrypting per-
teacher Canvas tokens, hitting Canvas API to rewrite assignment
descriptions, marking install_state, reassigning policies, then finally
deleting the prompt row.

Mid-iteration failures (e.g., one assignment's Canvas description PUT
500s — actually, the error path silently `continue`s and writes
`assignment_install_state.last_error`, see `system-prompts.ts:212-225`)
leave the system in a partially-rolled-back state but return `ok: true`
to the client. The pill goes green; the admin doesn't know which
assignments failed to uninstall.

Worse: `system-prompts.ts:228-239` always upserts `install_state.status
= "uninstalled"` *even on the Canvas failure path* (line 224 only
`continue`s the **assignment description PUT** error block; it falls
through to the unconditional upsert at 228). So the DB says
"uninstalled" but Canvas still shows the reflection card. Re-installing
the same Canvas assignment in the future re-runs ensureTeacherAssignment
and may find no row (deleted at 245) — actually, the iframe_token is
gone, so the card lives orphaned in Canvas (super-grader can't dedupe
it).

Wait — re-reading: line 224 says `continue` which skips the rest of
the loop iteration, so the unconditional upsert at 228 is also skipped.
Re-confirmed: on Canvas failure, install_state is marked `failed` with
last_error, NOT uninstalled. So the orphaned-card concern doesn't apply
on the failure path. But the success path's pill says
"Saved · uninstalledCount=N reassignedPolicyCount=M" — the pill never
reports those counts (return-shape data is dropped at
`SystemPromptCard.tsx:94`).

**Scenario:** admin deletes a non-Default reflection prompt that's used
by 50 teachers across 200 assignments. Two of those assignments' Canvas
descriptions PUT fails. Pill goes green. Admin walks away. Two teachers
later open their dashboards and see a "failed" install_state row. They
have no idea why.

**Fix direction:** plumb the `{ uninstalledCount, reassignedPolicyCount,
failedCount }` from the action's return into the dispatch — extend
`AutoSaveStatus` with a 4th kind `{ kind: "warning"; msg: string }` for
partial-success cases. Or use a one-off modal (not the auto-save pill)
for delete since delete is inherently imperative.

---

## Finding 10 — **MEDIUM** — Snapshot semantics: editing a prompt mid-flight changes the live prompt for in-progress reflections (by design — but no warning surfaced)

**Files:**
- `apps/teacher-admin/src/lib/actions/system-prompts.ts:96-108`
- AID architectural note: "Edits propagate instantly — no Canvas
  re-write needed, since the student-form reads the prompt body live"
  (from `page.tsx:46-50` and `apps/teacher-admin/CLAUDE.md`).

A teacher who has a reflection mid-session (student is on the chat
screen, has already received the alignment question) will, if the admin
edits the system prompt during that minute, have the **closing turn**
generated against the new body. Because there's no "frozen at session
start" snapshot of the prompt body. This is intentional per the design
note, but:

1. There's no `prompt_version` reference on `reflection_sessions` (the
   schema only puts `prompt_version` on `course_install_policies:231`
   for assignment install policy versioning — unrelated). So a teacher
   reviewing a reflection later can't tell which prompt revision generated
   the closing.
2. Auto-save makes this MUCH worse than the old "Save button" world —
   an admin who edits a prompt mid-class can produce 10 versions in a
   sentence-by-sentence typing pass, each landing as the "current"
   body for whatever Gemini call fires next.

This overlaps with the session-state audit; flagging here per the
prompt-direction. Not deep-diving.

**Scenario:** during 1st-period AI-literacy class, 5 students are in
mid-reflection. Admin opens `/admin/prompts`, edits the Default
reflection prompt body, types "be more skeptical of student claims"
into the body field. Auto-save fires 800ms later. The 5 closing-turn
Gemini calls that fire next will use that new instruction. Closings
arrive sounding different from earlier classes today; no audit trail.

**Fix direction:** out of scope for this audit (session-state lane).
But: at minimum log `prompt_id, prompt_updated_at` on every Gemini
turn write into `reflection_messages.meta`, and consider a per-session
`prompt_snapshot_jsonb` for forensics.

---

## Finding 11 — **LOW** — `getCurrentTeacher` redirect doesn't reach the client; auth-revoked auto-saves return a 200-shaped redirect HTML

**File:** `apps/teacher-admin/src/lib/auth/teacher.ts:15-32`

When a teacher's session is revoked (admin invalidates them, RLS
mid-session, expired refresh token), `getCurrentTeacher()` calls
`redirect("/")`. In a server action, Next 16 surfaces `redirect()` as
a thrown special signal that the client runtime turns into a
navigation. From inside `useTransition`, this navigation can fire
mid-form-edit and the user's typed text is lost without a
"save failed — sign in again" message — they're just suddenly on the
landing page.

The pill never shows an error because `redirect` is not caught as a
rejection; it's a navigation. So the fail-open promise breaks: the
teacher's words are gone, and there was no red pill.

`isAdmin()` / `getCurrentAdminEmail()` don't redirect (return null) —
so admin actions correctly path into the explicit
`{ ok: false, message: "Admin only" }` branch. Teacher-side actions
(`savePrompt` line 68, `updateMyCardOverrides` line 118) don't have
this safety net.

**Scenario:** teacher edits a personal prompt. Token revoked by admin
in another tab. 800ms after their next keystroke, the action runs,
`getCurrentTeacher` redirects them to "/". Their typing is in the
auto-save closure but the client never sees a response — it sees a
nav. No pill update; just a vanished editor.

**Fix direction:** in `getCurrentTeacher`, distinguish "called from a
page" (redirect OK) from "called from a server action" (return null /
throw a structured error). Standardize on the latter for actions, and
have actions translate null into `{ ok: false, message: "Sign in again." }`.
Even simpler: catch a known sentinel error type at the
`saveSystemPrompt` / `savePrompt` entry, return the structured shape.

---

## Finding 12 — **LOW** — `setCourseAutoInstall` not in auto-save scope but shares the same callback pattern; UI surface unknown

**File:** `apps/teacher-admin/src/lib/actions/course-policy.ts:22-85`

This action is button-driven from the dashboard's course toggles
(presumably — out of audit scope to verify). It calls `revalidatePath("/dashboard")`
on every flip — which, paired with Finding 4, would re-render any
sibling auto-saving card on the same page. Today `/dashboard` doesn't
appear to host auto-saving editors, so this is latent. If a future
prompt-picker or per-course default-prompt editor moves onto the
dashboard with auto-save, this revalidatePath will start interrupting
its in-flight edits.

**Fix direction:** prefer narrow `revalidatePath("/dashboard", "page")`
or `revalidateTag` once the editors that need it tag themselves.

---

## Finding 13 — **LOW** — `connectCanvas` returns `ConnectState` via `useActionState`; status state machine doesn't tell client whether the page-refresh actually happened

**File:** `apps/teacher-admin/src/app/dashboard/setup/ConnectForm.tsx:9-46`
+ `apps/teacher-admin/src/lib/actions/canvas-token.ts:10-54`

This is the standard `useActionState` pattern (`ConnectForm.tsx:10`). The
form sets `state.status === "ok"` and renders "Connected as X. The page
will refresh momentarily." But there is no actual `router.refresh()`
call — the message is aspirational. `revalidatePath("/dashboard/setup")`
on the server side does invalidate the page cache, but the message is
visible until the user refreshes manually, and there's no spinner.

Not load-bearing for the audit theme, but worth flagging: a teacher who
just connected Canvas may sit on this page for a while not knowing the
"momentarily" never comes. They'll re-paste their token, double-
encrypting and storing twice (idempotent on the DB side — `update`, not
`insert` — but wastes a Canvas getSelf call).

**Fix direction:** call `router.refresh()` from a `useEffect` keyed on
`state.status === "ok"`.

---

## Finding 14 — **INFO** — No PII-leak risk in error messages

Verified each action returns either a constant message ("Admin only",
"Label can't be empty", "Canvas isn't connected") or `error.message`
from Supabase / Canvas. Supabase errors don't carry student data
(they reference column names and constraints). Canvas errors via
`CanvasError.message` could in principle reach the pill, but they're
Canvas API status messages, not student-row content.

The one place that could leak is `deleteSystemPrompt:212-225` where a
Canvas description-fetch failure's error message gets stored in
`assignment_install_state.last_error` — but that text path is the
dashboard display, not the auto-save pill. Out of scope.

No action needed.

---

## Finding 15 — **INFO** — `AutoSaveProvider` import in `/admin/prompts/page.tsx` is good; `/admin/card-text` uses a per-component pill directly

`/admin/card-text/CardTextDefaultsEditor.tsx:153` renders its own
`<AutoSaveStatusPill>` rather than using the provider. Single-editor
page, so this is fine. But it means if a sibling component ever lands
on `/admin/card-text` with auto-save, the two pills will fight for the
`fixed bottom-5 right-5` slot (z-index 50 each — they'll stack/overlap).

**Fix direction:** standardize on `AutoSaveProvider` even for
single-editor pages (zero-cost) to prevent the next-editor footgun.

---

# Severity rollup

| # | Severity | Theme | Data loss risk? |
|---|----------|-------|---|
| 1 | HIGH | Auto-save not applied to `/dashboard/prompts` | YES (controlled state evaporates on nav) |
| 2 | HIGH | Auto-save not applied to `/dashboard/setup` card text | YES (reset wipes parallel edits) |
| 3 | HIGH | No state fence on prompt / card-text writes | YES (two-tab clobber) |
| 4 | HIGH | `revalidatePath` on every save cancels in-flight debounce | YES (last 800ms of typing) |
| 5 | HIGH | Concurrent `save()` from blur+visibility+debounce not single-flighted | YES (re-baseline race) |
| 6 | MED | Aggregator pill loses errors when next save succeeds | YES (silent overwrite, no UX signal) |
| 7 | MED | `isFormDirty` / re-baseline doesn't cover select / radio / checkbox / file | LATENT |
| 8 | MED | Green pill after error is non-sticky | indirect |
| 9 | MED | Delete partial-failure reports as "saved" | indirect |
| 10 | MED | Prompt edits hit in-flight reflections, no snapshot | YES (forensics) |
| 11 | LOW | `redirect()` from teacher actions silently navigates | YES (the lost-typing case) |
| 12 | LOW | Latent revalidatePath fanout on `/dashboard` | LATENT |
| 13 | LOW | "Page will refresh momentarily" doesn't | NO |
| 14 | INFO | No PII leak via server-action errors | NO |
| 15 | INFO | Mixed provider/standalone pill usage | NO |

Top action items (in priority order):

1. Port `/dashboard/prompts/PromptCard.tsx` to auto-save (Finding 1).
2. Port `/dashboard/setup/CardTextEditor.tsx` to auto-save (Finding 2).
3. Add `updated_at`-fenced UPDATEs to `saveSystemPrompt`, `savePrompt`,
   `updateCardTextDefaults`, `updateMyCardOverrides` (Finding 3).
4. Stop `revalidatePath` in auto-save actions; return new `updated_at`
   in response and let client re-baseline freshness key (Finding 4).
5. Add single-flight serialization inside `useAutoSaveForm` (Finding 5).
6. Track per-editor error stickiness in `AutoSaveProvider` (Finding 6).
7. Catch `redirect` in teacher-side actions, surface as `{ ok: false }`
   (Finding 11).
