# AI Documenter v2 — Planning Notes

**Status:** see [`../BUILD_PLAN.md`](../BUILD_PLAN.md) ([on GitHub](https://github.com/hughsibbele/super-grader-suite/blob/main/BUILD_PLAN.md)) for ecosystem-wide milestones and current state. This file is local navigation for the AI Documenter codebase.

## What it is

Web app for EHS students to document their AI use on Canvas assignments. Each reflection is a Socratic conversation: intake (chat URLs + time + first-draft paragraph) → objective summary + alignment question (back-to-back AI bubbles) → student answer → hardcoded "What did you learn / what will you change?" question → student answer → Gemini-generated closing. Three Gemini calls per session, two student turns.

Built as a satellite of super-grader: on completion, AI Documenter auto-submits the reflection to Canvas via `as_user_id` masquerade with the teacher's API token, and fires a webhook to super-grader's `/api/ingest/ai_documenter` (envelope per integration-contract §4).

## Scope & constraints

- **Scale target:** whole-of-EHS (every teacher, every assignment). Robust enough to reach it.
- **School:** EHS only.
- **Canvas integration:** mandatory-feeling without LTI. Pattern is **branded reflection card in the assignment description** linking to a standalone web app at `/r/<token>` + Canvas API auto-submit on the student's behalf. (Iframe-in-assignment was the original plan; retired 2026-05-11 due to third-party-cookie pain.)
- **Reflection style:** Socratic coaching — get the student thinking more deeply about their AI use, not interrogation or grading.
- **Prompt control:** mixed. School-wide **system prompts** are admin-edited and shared across teachers. Every teacher also has a **personal prompts library** they manage themselves. Adoption is grassroots — teachers can use the system Default with zero admin involvement.
- **Transcript ingest:** link-based (Gemini / ChatGPT / Claude share links) with paste-fallback always visible. URL-context grounding via Gemini is best-effort; paste is the reliable path.
- **Billing:** centralized — EHS pays for the Gemini key behind our backend.
- **Student auth:** Google SSO via EHS Workspace accounts.
- **Reflection mode:** written only. Oral mode (Gemini Live) was cut 2026-05-12 as out of scope.
- **PII / FERPA:** student names, emails, and any other identifiers must **never** reach Gemini. Anonymization layer at the boundary — `Student_xxxxxx` tokens go out, real names come back to the teacher view. Pattern matches super-grader's integration-contract §2 byte-for-byte.
- **Retention:** one academic year. End-of-year sweep clears reflection data.
- **Multi-tool per assignment:** yes — one assignment can cover Gemini + ChatGPT + Claude use in the same reflection.

## Architecture decision

**Next.js + Supabase on Vercel.** One merged Next.js 16 app (`apps/teacher-admin` — historical name) serves three route groups: `/r/<token>` (standalone reflection, student-side), `/dashboard/*` (teacher), `/admin/*` (admin). Auth is cookie-based (`@supabase/ssr`) throughout. Unified `/auth/callback` routes by `next` prefix: `next.startsWith('/r/')` → upsert as student; else upsert as teacher.

Incremental cost at our scale: ~$20–40/mo beyond the centralized Gemini key.

## Canvas integration pattern (card + auto-submit)

1. Teacher hits **Install** in our dashboard; backend PUTs a branded reflection card (EHS logo + maroon CTA) into the assignment's description via Canvas API. Idempotent via marker comments (`<!-- ehs-ai-reflect:begin v=2 iframe-token=... -->`); bare-card-by-token fallback handles Canvas's comment-stripping paths.
2. Student in Canvas clicks **Open reflection →**; the standalone app opens at `https://<host>/r/<token>` (new tab).
3. Student signs in with Google (EHS Workspace), completes intake + Socratic conversation.
4. On completion, backend writes to Canvas. Two paths controlled by `teacher_assignments.use_submission_body`:
   - **`false` (default, comment-first):** `PUT submissions/:user_id` with `comment[text_comment]=<plain text>` under `as_user_id` masquerade. Works on every Canvas assignment type via `find_or_create_submission`. Comment carries **no sentinel marker** (super-grader scrapes bodies, not comments). Tradeoff: gradebook column stays `workflow_state="unsubmitted"`.
   - **`true` (opt-in body-mode):** legacy `POST submissions` with `online_text_entry` HTML body, sentinel marker `<!-- ai-documenter:reflection v=1 iframe-token=<token> -->`, comment fallback on 400/422. For AI-literacy assignments where the reflection IS the deliverable.
5. Fire-and-forget webhook to super-grader regardless of path. The Canvas write and the webhook are independent; super-grader's AI Use card renders from `peer_results`.
6. Fallback when both paths fail: a 6-character completion code the student pastes into Canvas manually.

## Reflection conversation design

3 Gemini calls per session:
1. **Objective summary** (`purpose='objective_summary'` prompt) — server-generated at conversation bootstrap, ~100 words of descriptive prose ("the student asked for three thesis options on Anna Karenina's moral arc; used the second with light edits"), explicitly not evaluative.
2. **Alignment question** (reflection prompt body + alignment guard rail) — pulls a question relevant to the student's specific use.
3. **Closing** (reflection prompt body + closing guard rail) — warm summary after the student's second answer.

2 student answers between. After step 1+2, the server hardcodes one more AI message — *"What have you learned about working with AI from this assignment? What, if anything, will you do differently next time?"* — with no Gemini call. All Gemini calls pass `maxOutputTokens: 4096` — Gemini 3 Flash thinking tokens count against the same budget; lower caps truncate mid-sentence.

Chatbot UX: real chat bubbles (left=AI, right=student). Locked first draft renders as opening student bubble.

## PII anonymization

HMAC-SHA256 token matching super-grader's `planning/integration-contract.md` §2 byte-for-byte:
- Salt: `SUPER_GRADER_SALT` (32+ random bytes, base64), shared ecosystem-wide.
- Token: `Student_xxxxxx` (first 6 hex chars of HMAC over `"ehs\0" + canvas_user_id + "\0" + email_lowercased`).
- **Stored anonymized** in `reflection_messages`, `objective_summary`. De-anonymize at render time only.
- Canvas writes are de-anonymized — Canvas is on EHS's side of the privacy boundary.

`scrubSessionForGemini(session, canvasCourseId)` is the boundary helper — scrubs `first_draft`, `paste_fallback_text`, `ai_chats[].transcript_text` before either Gemini call. Roster source is `course_rosters` (Canvas roster cache); compiled regex cached 5 min per course.

## Subrepo layout

```
/v2/
  /apps/
    teacher-admin/        # merged Next.js 16 app — student + teacher + admin
                          # (directory rename to apps/teacher tracked in suite plan M4.1)
  /packages/
    db/                   # Supabase schema, migrations, generated types
    canvas/               # Canvas API client + reflection-card install marker
                          # + submitTextEntryAsStudent + lookupCourseStudentByEmail
    crypto/               # AES-256-GCM at-rest secret encryption
    anonymizer/           # Student_xxxxxx tokens + name-redaction scrubbers
    prompts/              # super-grader prompt-registry fetcher (legacy)
    gemini/               # Gemini v1beta REST chat wrapper (URL-context, thinking config)
  /supabase/              # migrations, generated types
```

Monorepo via pnpm workspaces. `packages/transcript-ingest/` is planned (per-provider share-link scrapers).

## Helper functions (SECURITY DEFINER, EXECUTE granted to `authenticated`)

- `is_teacher_owner(t_id uuid)` — used by RLS on every teacher-owned table
- `is_student_self(s_id uuid)` — used by RLS on student tables
- `is_admin()` — checks `lower(auth.jwt()->>'email')` against `admins.active`

## Migration template (new tables)

Supabase is dropping the default `public`-schema auto-grant on new tables — enforced 2026-10-30. Every `CREATE TABLE` in `public` from here on pairs the CREATE with explicit grants + RLS + policies in the same migration:

```sql
CREATE TABLE public.your_table ( ... );

ALTER TABLE public.your_table ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.your_table TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.your_table TO service_role;
-- intentionally NO grant to anon — AI Documenter is admin-private.

CREATE POLICY "..." ON public.your_table FOR ... TO authenticated USING (...);
```

Helper functions follow the same rule: `GRANT EXECUTE ... TO authenticated, service_role`, with explicit `REVOKE EXECUTE ... FROM anon` since Supabase's `REVOKE ... FROM PUBLIC` doesn't clear role-specific grants.

## Gotchas

- **Supabase auth redirect allowlist needs `http://localhost:3001/**`** (and any other dev origin). Without it, OAuth round-trip falls back to Site URL on completion and `next` is dropped silently.
- **Gemini's URL-context tool key is `url_context` (snake_case).** camelCase is silently ignored — the tool just doesn't run.
- **`iframe_token`** is the DB column name even though it's now an opaque entry token, not pointing to an iframe. Renaming would touch every server action / type / migration with no functional benefit.
- **`apps/teacher-admin` directory name** is historical (pre-merge with `apps/student-form`). Renaming is tracked in suite plan M4.1.

## Out of scope

- LTI (decided, won't reconsider).
- Non-EHS deployments.
- Teacher-side grading or rubrics inside this app — the teacher grades in Canvas as normal.
- Sharing reflections between teachers / department-level prompt libraries.
- Mobile-native apps.
