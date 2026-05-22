# AID — Cross-system seams audit

**Scope:** webhook OUT to super-grader, two pull-on-view endpoints IN from super-grader, Vercel cron, retention sweep, AES-256-GCM at-rest crypto, iframe-token resolution, Sentry config, Supabase proxy.

**Date:** 2026-05-21
**Branch:** main
**Auditor lens:** five suite-wide root causes (snapshot semantics, state fences, transactional boundaries, fail-open, idempotency) + AID-specific seams.

Severity scale: **critical** (data-loss / authz bypass / secret leak), **high** (silent failure / wrong-answer to peer / partial-state visible), **medium** (operability / DoS / hardening), **low** (style / nit / future-proofing).

---

## 1. `/api/super-grader/result` returns un-finalized sessions without a state fence — **high**

File: `apps/teacher-admin/src/app/api/super-grader/result/route.ts:97-122`

The session query takes the most-recent row for `(student_id, canvas_assignment_id)` in ANY state — `started`, `in_progress`, `completed`, `submitted`, `failed`. If a student opens the reflection, types one sentence, and walks away, and the teacher then opens that submission in super-grader, AID will return an envelope where:
- `summary.state = "started"`
- `summary.objective_summary = null`
- `summary.socratic_messages = []`
- `summary.tools_used = []`
- `completed_at = session.created_at` (because both `submitted_at` and `completed_at` are null, the code falls back to `created_at` on line 149)

Super-grader will render the "AI Use" card from this partial envelope and the teacher will see a card that looks like "student completed at <created_at>" with empty content — indistinguishable from "student didn't really reflect" vs "student is mid-reflection right now".

The pull-on-view docstring (line 14) explicitly says "even if the original webhook was dropped or fired before the student finished" — i.e., the comment acknowledges that the endpoint can be hit before finalize. The code doesn't actually guard for it.

**Why this matters under root-cause #1 (snapshot semantics) + #2 (state fences):** SG asked for "the AID result for this student on this assignment", which contractually means "the result of a completed reflection". A `state='started'` row is not a result; it's a work-in-progress. There is no fence.

**Fix direction:**
- Filter `.in("state", ["completed", "submitted"])` in the session query — `failed` is debatable but at minimum exclude `started`/`in_progress`. If no qualifying row exists, return 404 (which SG already handles gracefully as "no AID activity yet").
- OR: keep returning the row, but include an explicit `summary.is_finalized` boolean so SG can render "in progress" rather than a misleading empty card.
- Also tighten `completed_at` fallback on line 149: don't fall back to `session.created_at` for a non-finalized session — that produces a meaningless timestamp for the peer.

---

## 2. `/api/super-grader/prompts/objective_summary` sets `Cache-Control: public` on a bearer-authed response — **high**

File: `apps/teacher-admin/src/app/api/super-grader/prompts/objective_summary/route.ts:65-66`

```ts
"Cache-Control": "public, max-age=600",
```

The endpoint requires `Authorization: Bearer ${AI_DOCUMENTER_API_TOKEN}` (good), but `public` cache directive tells any intermediate cache (Vercel edge / shared proxy / corp HTTP cache) that the response is shareable across users — *for an authed endpoint*. Per RFC 7234 §3.2 / 5.2.2.6, an `Authorization`-bearing response should be `private` (or marked with `s-maxage` only after explicit reasoning about who can fetch from cache).

Today's request flow is server-to-server with no intermediaries, so practical exposure is near-zero. But:
- Vercel's edge cache *does* honor `public` and *will* serve the cached body to subsequent requests that don't re-present credentials, depending on cache-key configuration.
- Anyone who learns the URL and hits it from a CDN-fronted path could potentially get the cached prompt body without presenting a bearer.

The system prompt body is low-sensitivity (not a secret per se), but the directive is wrong and inviting future regressions when caching infra changes.

**Fix direction:** change to `Cache-Control: private, max-age=600`. Matches the `/result` endpoint's posture (line 184).

---

## 3. Retention sweep is fully manual — no end-of-year cron — **high (policy gap)**

Files: `apps/teacher-admin/vercel.json`, `apps/teacher-admin/src/app/api/cron/`, `apps/teacher-admin/src/lib/actions/retention.ts`

CLAUDE.md (line 23) commits: "Retention: one academic year. End-of-year sweep clears reflection data."

In code:
- `vercel.json` registers exactly one cron, `/api/cron/sync-all-teachers`. No retention cron.
- `apps/teacher-admin/src/lib/actions/retention.ts:hardDeleteReflections` is a **server action** that requires a logged-in admin to click "Permanently delete" with `confirmText="DELETE"`.
- `reflection_sessions.expires_at` defaults to `now() + interval '1 year'` (migration line 73) but nothing reads `expires_at` to expire rows.

**Why this matters:** the stated retention contract is unenforced. Sessions accumulate forever in the DB unless an admin remembers to log in and click the button. The `expires_at` column exists as a planning artifact but has no consumer.

**Fix direction:**
- Add a second Vercel cron (e.g. weekly at 03:00) hitting a new `/api/cron/expire-old-sessions` route that deletes rows WHERE `expires_at < now()` AND `state IN ('submitted','failed','completed')` (state fence — don't nuke an in-progress session). Same `CRON_SECRET` check pattern.
- OR: re-document the policy as "admin sweeps annually" and remove `expires_at` to avoid future-Claude assuming it does something.
- Whichever path: make it a deliberate decision, not a silent gap.

---

## 4. `hardDeleteReflections` server action — no ownership check on `canvasCourseId` (mitigated downstream, but defense-in-depth gap) — **medium**

File: `apps/teacher-admin/src/lib/actions/retention.ts:123-153`

`resolveScope` for `target='course'`:
```ts
const teacher = await getCurrentTeacher();
// ...
return { ok: true, scope: { kind: "teacher_course", teacherId: teacher.id, canvasCourseId: input.canvasCourseId } };
```

It uses the calling teacher's id, but accepts any `canvasCourseId` the client sends. If the teacher doesn't actually own that course, `loadReflectionsInScope` (load.ts:50-53) filters by `(teacher_id, canvas_course_id)` AND'd together, so the inner join yields zero rows and nothing gets deleted — saved by query shape.

This is mitigated, not safe. The protection lives one function call away from the auth check; a refactor that loosens the scope filter (e.g., admins-can-delete-as-any-teacher path, or an admin-impersonation feature) would silently re-open it.

**Why it matters under root-cause #2 (state fences):** authority assertions should be co-located with the auth boundary, not split across two files.

**Fix direction:** in `resolveScope`, when `target='course'` and the caller isn't an admin, verify `teacher_assignments` has at least one row matching `(teacher_id=teacher.id, canvas_course_id=input.canvasCourseId)`. Return `{ ok: false }` immediately if not. Defense in depth; cheap.

Additionally consider: when `target='all'`, log who triggered it (`adminEmail`) for an audit trail — this is the highest-blast-radius operation in the system.

---

## 5. Cron auth string-compares secrets (timing attack surface) + ingress auth too — **low**

Files:
- `apps/teacher-admin/src/app/api/cron/sync-all-teachers/route.ts:27-30`
- `apps/teacher-admin/src/lib/super-grader/auth.ts:28-30`

Both use `===` (or `!==`) to compare a bearer token / cron secret against the expected value. JS string comparison short-circuits on first byte mismatch, in principle leaking byte-by-byte timing info.

Realistic exploitability: very low. TLS, Vercel's request scheduling jitter, V8 string interning, and 32+ bytes of secret entropy combine to make remote timing attacks impractical. But the hardening is one line:

```ts
import { timingSafeEqual } from "node:crypto";
const a = Buffer.from(presented, "utf8");
const b = Buffer.from(expected, "utf8");
if (a.length !== b.length || !timingSafeEqual(a, b)) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
```

**Fix direction:** switch both compares to `timingSafeEqual` with length pre-check. Apply to webhook ingress (`/api/super-grader/*`) and cron (`/api/cron/*`).

---

## 6. Cron is fail-closed on missing `CRON_SECRET` (good) — confirm same posture on ingress — **info / passes audit**

File: `apps/teacher-admin/src/app/api/cron/sync-all-teachers/route.ts:19-25`

```ts
const expected = process.env.CRON_SECRET;
if (!expected) {
  return NextResponse.json({ ok: false, error: "CRON_SECRET not configured" }, { status: 500 });
}
```

Returns 500, not 200. So if someone deploys without `CRON_SECRET`, the cron will fail loudly (and Vercel cron retries surface as failure events) rather than silently allowing anyone to trigger the loop. This is the correct posture and **avoids the common Next.js cron CVE pattern** of accepting unauthed when secret-unset.

Same pattern in `authorizeSuperGraderRequest` (auth.ts:14-22): missing `AI_DOCUMENTER_API_TOKEN` → 500, not pass-through. Both endpoints are fail-closed. **No bug — audit passes here.**

---

## 7. `notifySuperGrader` is fire-and-forget but actually awaited; failures only log, no retry, no DLQ — **medium**

Files:
- `apps/teacher-admin/src/lib/finalize/super-grader.ts:75-99`
- `apps/teacher-admin/src/lib/actions/finalize.ts:149-164`

The webhook is `await`ed in `finalizeReflection`. On non-skipped failure the caller logs via `console.error` and proceeds. No retry, no scheduled DLQ flush, no database row recording the dropped delivery.

This is intentional per CLAUDE.md (line 5 of finalize.ts) — SG has its own pull-on-view path via `/api/super-grader/result` (audited in #1). So the recovery story is: SG misses the webhook, but next time the teacher opens the assignment in SG, SG's `fetchLivePrompt`/result-pull picks it up.

**Why this still matters:** the recovery path only triggers when the teacher manually opens the SG view. If the teacher never opens it, the AI-Use card never renders, and there's no record on AID's side that a delivery was attempted, failed, and never recovered. Operationally invisible.

**Why this matters under root-cause #3 (transactional boundaries) + #5 (idempotency):** the three writes (Canvas submit, DB session update, webhook) have implicit ordering but no compensating transaction. If the DB update succeeds and the webhook silently fails, the only repair path is teacher-action-driven.

**Fix direction (lightweight):**
- Add a `webhook_delivery_attempts` row (succeeded/failed + status + response body snippet + retry count) per attempt. Currently we have `submission_attempts` for Canvas; this is the symmetric row for the SG leg.
- Or simpler: write the failed-webhook state on the session itself (`webhook_status` column with values `pending`/`delivered`/`failed`) and have the next teacher view trigger a re-attempt.
- Aggressive option: tiny retry-with-backoff inside `notifySuperGrader` (3 attempts, 200/800/3200ms) — most transient failures recover within seconds and don't need an out-of-band repair.

---

## 8. Webhook envelope sends a snapshot of `objective_summary` at finalize time — but the IN endpoint serves live — **medium (inconsistency)**

Files:
- `apps/teacher-admin/src/lib/finalize/super-grader.ts:143` — POST envelope reads `session.objective_summary` (snapshot already on the row)
- `apps/teacher-admin/src/app/api/super-grader/result/route.ts:177` — GET envelope reads `session.objective_summary` (same field, but on a live row)

The POST is **snapshot semantics** by construction (the value was generated during the conversation and stored). The GET is **live semantics** (it reads the same column, which never changes after finalize, so de facto snapshot — but if a future migration ever re-runs summary generation or admin-edits the row, the two would diverge).

Currently consistent because the column is write-once. But:
- `prompts.body` (the objective-summary system prompt) IS editable post-finalize.
- The IN endpoint at `/api/super-grader/prompts/objective_summary` returns the **live** prompt body (route.ts:30-37: queries by `purpose='objective_summary' AND is_default=true`, no version pin).

So if an admin edits the objective-summary prompt today, every future SG pull-on-view will see the new prompt body, but old `reflection_sessions.objective_summary` will reflect the OLD prompt's output. There's no version pin connecting the two.

**Why this matters under root-cause #1 (snapshot semantics):** SG renders an "AI Use" card alongside the prompt text the summary was generated from. If the prompt body is edited, the rendered card combines NEW prompt body + OLD summary text — visually plausible but factually wrong.

**Fix direction:**
- Stamp `reflection_sessions.objective_summary_prompt_version` (a copy of `prompts.updated_at` at generation time) and expose it in the envelope.
- Or freeze: forbid in-place edits to the objective-summary system prompt body; admins create a new row instead.
- Or simpler: document the inconsistency and accept it — but at minimum, make sure the SG-side `fetchLivePrompt` cache doesn't expose the divergence in audit views.

---

## 9. `resolveIframeToken` length check is the only token-validation gate — no expiry, no rate limit, no revocation path — **medium**

File: `apps/teacher-admin/src/lib/iframe/resolve.ts:21`

```ts
if (!iframeToken || iframeToken.length < 16) return null;
```

The DB column `iframe_token` has no expiry, no revocation column, and no rate limiting on the lookup. If a teacher's reflection URL leaks (Canvas description is HTML, scraped by anyone with course access), the token is valid until the row is deleted.

Mitigation in place:
- Student must auth via Google SSO before any DB write (`finalizeReflection` checks `supabase.auth.getUser()`).
- The token only resolves to `(teacher_assignment, prompt)` — no PII directly returned from the lookup.
- Random tokens (entropy not audited here but presumably high).

**Why this matters under root-cause #5 (idempotency) and AID-specific concern:** a brute-force attacker can probe the token space against `resolveIframeToken` (returns 200 vs 404 implicitly) without any rate limit. 16-char minimum suggests the token is presumably 32+ chars of hex/base64; if so, brute force is infeasible. But the validation doesn't enforce a max length, format, or expiry — it accepts any string ≥16 chars and does a DB lookup.

**Fix direction:**
- Enforce a strict format match (regex for the issued token format) before hitting the DB; saves a query on garbage input and tightens the surface.
- Consider adding `iframe_token_revoked_at` for the "teacher rotates a token" path; today there's no way to invalidate a leaked token short of deleting the `teacher_assignments` row, which deletes all student reflection sessions tied to it (cascade per migration line 60).

---

## 10. AES-256-GCM crypto is correctly implemented — but single static key, no rotation tooling — **low (operability)**

File: `packages/crypto/src/index.ts`

Construction is textbook AES-256-GCM:
- 12-byte random IV per call (line 32) — collision probability ~2^-48 per row pair, safe under any realistic encrypted-row count.
- 16-byte auth tag (`TAG_LEN = 16`) — full GCM tag, not truncated.
- `base64(iv ‖ tag ‖ ciphertext)` blob format — unambiguous parse, length check (line 42) before splitting.
- `decodeKey` validates 32-byte length — fail-closed on wrong-key-size.
- `readKeyFromEnv` throws on missing `CANVAS_TOKEN_ENC_KEY` — fail-closed.

**No IV reuse, no nonce-misuse, no malleable framing.** This is good crypto.

What's missing:
- No KDF — the env var IS the key. If you ever want to derive per-row keys, or migrate from env-key to KMS, you'll need to re-encrypt every row.
- No rotation story. The doc comment says "rotation requires re-encrypting all rows" — but there's no script in `scripts/` (suite-level) or in `packages/crypto/` to actually do that re-encrypt sweep. If a key compromise event hit AID, current procedure is "write a one-off script under pressure".
- Single key encrypts every teacher's Canvas token. Compromise of the env var compromises every teacher's Canvas masquerade token.

**Why this matters under root-cause #4 (fail-open):** crypto fails closed (good), but operationally there's no rotation runbook. Combined with the suite's salt-rotation script at `scripts/rotate-salt.sh` (suite root), this is an obvious symmetry gap.

**Fix direction:**
- Add `scripts/rotate-canvas-token-key.sh` (suite-level) that: takes OLD_KEY + NEW_KEY, decrypts each `teachers.canvas_token_encrypted` with OLD_KEY, re-encrypts with NEW_KEY, atomically updates the row.
- Document in the suite-root README under the "useful patterns" or "scripts" section.

---

## 11. Sentry config — `sendDefaultPii: false` is correct — but no explicit body scrubber — **low**

File: `apps/teacher-admin/src/lib/telemetry/sentry-init.ts`

`sendDefaultPii: false` (line 35) — Sentry won't attach IP, user-agent breadcrumbs, request body, or cookies. Good baseline.

The doc comment on line 33-34 acknowledges "never attach request bodies until we have a redaction story" — meaning the author knows there's no body-redaction layer.

Practical scenario: a server action throws while processing a reflection. Sentry captures the throw + stack trace. If any in-flight variable holds anonymized-but-still-Gemini-bound text (Student_xxxxxx tokens), or anti-anon raw text (pre-scrub), it could end up in the local-variable capture under `event.extra` or as part of the stack frame snapshot if frame variables are captured (Sentry's default is OFF for variable capture in Node, so this is theoretical).

**Why it matters under root-cause #4 (fail-open):** if `sendDefaultPii` is accidentally flipped to `true` (perf-debugging session, anyone), there's no second-line scrubber to catch the slip. Belt-and-suspenders missing.

**Fix direction:**
- Add a `beforeSend` hook that walks `event.request.data`, `event.extra`, and any string fields, redacting `Student_[a-f0-9]{6}` and any obvious email-shaped strings before transmission. Idempotent on already-redacted strings.
- Same hook should redact `Bearer .*` and `eyJ.*` (JWT-shaped strings) from error messages.

---

## 12. Supabase proxy uses publishable (anon-scope) key — correct posture — **info / passes audit**

File: `apps/teacher-admin/src/lib/supabase/proxy.ts:18`

Uses `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (the new name for the anon key). Cannot bypass RLS. Cookie-bound; per-user.

The boundary between "service-role admin client" (`createAdminDbClient` in `packages/db/src/admin.ts`, which DOES bypass RLS) and this proxy client is clean — admin client is server-only, marked `import "server-only"`, only invoked from routes / actions / loaders. The proxy never escalates. **No bug.**

---

## 13. No Inngest in AID — confirms CLAUDE.md note, no post-rename re-sync needed — **info**

`grep -rn inngest` across the repo: zero matches. AID is webhook-OUT only (to SG); SG runs its own Inngest. The post-Vercel-rename `PUT /api/inngest` gotcha from the suite CLAUDE.md does NOT apply to AID. **Audit passes here.**

---

## Summary table

| # | Finding | Severity |
|---|---------|----------|
| 1 | `/api/super-grader/result` returns un-finalized sessions | high |
| 2 | `prompts/objective_summary` sets `Cache-Control: public` on authed response | high |
| 3 | Retention sweep is manual only — no end-of-year cron despite policy | high |
| 4 | `hardDeleteReflections` no co-located ownership check (mitigated downstream) | medium |
| 5 | Cron + ingress auth uses `===`, not `timingSafeEqual` | low |
| 6 | Cron is fail-closed on missing secret | info / pass |
| 7 | Webhook is awaited but failures only log; no retry / DLQ / state row | medium |
| 8 | Snapshot vs live divergence on objective-summary prompt body | medium |
| 9 | `iframe_token` has no expiry/revocation/rate-limit | medium |
| 10 | AES-256-GCM correct but no rotation tooling | low |
| 11 | Sentry baseline OK but no `beforeSend` scrubber | low |
| 12 | Supabase proxy uses anon key — clean | info / pass |
| 13 | No Inngest in AID — matches CLAUDE.md | info / pass |

---

## Priority recommendations

If only one fix lands this sprint: **#1** (state fence on `/result`) — it actively returns wrong answers to the peer right now.

If two: add **#3** (retention cron) — the policy commitment is currently aspirational.

If three: add **#2** (`Cache-Control: private`) — one-line change, removes a future-regression vector.

Everything else is hardening / operability and can sit on the backlog.
