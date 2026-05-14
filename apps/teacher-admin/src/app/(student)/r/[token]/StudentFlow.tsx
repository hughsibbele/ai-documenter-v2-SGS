"use client";

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useTransition,
} from "react";
import { submitIntake } from "@/lib/actions/intake";
import { getStudentSession } from "@/lib/actions/session";
import {
  nextSocraticTurn,
  type ReflectionMessage,
} from "@/lib/actions/socratic";
import { finalizeReflection } from "@/lib/actions/finalize";
import { BrandHeader } from "@/components/brand/BrandHeader";

type FinalizeState =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "submitted" }
  | { kind: "needsCode"; code: string; error: string };

type Step = "intake" | "conversation";
type Tool = "gemini" | "chatgpt" | "claude";
type Chat = { tool: Tool; url: string };
type TimeSpentBand = "lt15" | "15_30" | "30_45" | "45_60" | "1_2h" | "gt2h";

const TIME_BANDS: ReadonlyArray<{ value: TimeSpentBand; label: string }> = [
  { value: "lt15", label: "Less than 15 minutes" },
  { value: "15_30", label: "15–30 minutes" },
  { value: "30_45", label: "30–45 minutes" },
  { value: "45_60", label: "45 minutes – 1 hour" },
  { value: "1_2h", label: "1–2 hours" },
  { value: "gt2h", label: "More than 2 hours" },
];

type Props = {
  iframeToken: string;
  ctxValid: boolean;
  courseName: string | null;
  assignmentName: string | null;
  studentFacingQuestion: string;
  initialAuthError: string | null;
};

type AuthState =
  | { kind: "loading" }
  | { kind: "anon" }
  | {
      kind: "signed-in";
      displayName: string;
      hasActiveReflection: boolean;
      firstDraft: string | null;
    };

export default function StudentFlow({
  iframeToken,
  ctxValid,
  courseName,
  assignmentName,
  studentFacingQuestion,
  initialAuthError,
}: Props) {
  const [auth, setAuth] = useState<AuthState>({ kind: "loading" });

  const refreshSession = useCallback(async () => {
    const info = await getStudentSession({ iframeToken });
    if (!info.signedIn) {
      setAuth({ kind: "anon" });
      return;
    }
    setAuth({
      kind: "signed-in",
      displayName: info.displayName ?? "you",
      hasActiveReflection: info.hasActiveReflection,
      firstDraft: info.firstDraft,
    });
  }, [iframeToken]);

  useEffect(() => {
    void refreshSession();
  }, [refreshSession]);

  if (!ctxValid) return <BrokenLink />;

  return (
    <Shell eyebrow="AI Use Reflection" title={assignmentName} subtitle={courseName}>
      {auth.kind === "loading" ? (
        <LoadingScreen />
      ) : auth.kind === "anon" ? (
        <WelcomeScreen
          iframeToken={iframeToken}
          authError={messageForError(initialAuthError)}
        />
      ) : (
        <SignedInFlow
          iframeToken={iframeToken}
          studentDisplayName={auth.displayName}
          hasActiveReflection={auth.hasActiveReflection}
          firstDraft={auth.firstDraft}
          studentFacingQuestion={studentFacingQuestion}
          onIntakeSubmitted={refreshSession}
        />
      )}
    </Shell>
  );
}

// -----------------------------------------------------------------------------
// Page chrome

// Small italic "Teacher sign-in →" link rendered in the BrandHeader's right
// slot on every student-side surface. Lets a teacher who lands here by
// mistake (shared link, wrong tab) bail to their own sign-in without first
// having to authenticate as a student.
function TeacherCornerLink() {
  return (
    <Link
      href="/auth/login"
      className="text-xs italic text-cool-gray transition-colors hover:text-maroon"
    >
      Teacher sign-in →
    </Link>
  );
}

function Shell({
  eyebrow,
  title,
  subtitle,
  children,
}: {
  eyebrow: string;
  title: string | null;
  subtitle: string | null;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-dvh flex-col bg-paper">
      <BrandHeader
        eyebrow={eyebrow}
        title={title ?? undefined}
        subtitle={subtitle ?? undefined}
        right={<TeacherCornerLink />}
      />
      <main className="flex-1 px-6 py-10">{children}</main>
    </div>
  );
}

function BrokenLink() {
  return (
    <div className="flex min-h-dvh flex-col bg-paper">
      <BrandHeader
        eyebrow="AI Use Reflection"
        right={<TeacherCornerLink />}
      />
      <main className="flex flex-1 items-center justify-center px-6 py-12">
        <div className="mx-auto max-w-md text-center">
          <div className="ehs-eyebrow text-maroon">An issue with this link</div>
          <h2 className="mt-3 text-xl text-ink">
            This reflection link isn&apos;t working.
          </h2>
          <p className="mt-3 text-sm leading-relaxed text-cool-gray">
            The URL doesn&apos;t match an active assignment. Please ask your
            teacher to reinstall the AI Use Reflection on this assignment.
          </p>
        </div>
      </main>
    </div>
  );
}

function LoadingScreen() {
  return (
    <div className="mx-auto max-w-xl pt-16 text-center text-sm italic text-cool-gray">
      Loading…
    </div>
  );
}

// -----------------------------------------------------------------------------
// Welcome (anon)

function WelcomeScreen({
  iframeToken,
  authError,
}: {
  iframeToken: string;
  authError: string | null;
}) {
  const signInHref = `/auth/login?next=${encodeURIComponent(`/r/${iframeToken}`)}`;

  return (
    <div className="mx-auto w-full max-w-2xl space-y-8">
      <div className="space-y-3">
        <div className="ehs-eyebrow text-maroon">Welcome</div>
        <h1 className="text-3xl leading-tight text-ink">
          Reflect on how you used AI for this assignment.
        </h1>
        <p className="text-base leading-relaxed text-cool-gray">
          You&rsquo;ll share the AI chats you used, write a first reflection in
          your own words, then have a brief Socratic conversation with a coach
          to deepen your thinking. Five to ten minutes. Your reflection is
          submitted to Canvas automatically when you finish.
        </p>
      </div>

      <hr className="ehs-rule" />

      <ul className="space-y-2.5 text-sm leading-relaxed text-ink">
        <li className="flex gap-3">
          <span className="text-maroon">i.</span>
          <span>
            Share the AI chats you used and estimate how long you spent.
          </span>
        </li>
        <li className="flex gap-3">
          <span className="text-maroon">ii.</span>
          <span>
            Write a first reflection in your own words. Once submitted, this
            is locked &mdash; the coach builds on it.
          </span>
        </li>
        <li className="flex gap-3">
          <span className="text-maroon">iii.</span>
          <span>
            Answer three Socratic follow-ups to deepen your thinking.
          </span>
        </li>
      </ul>

      <div className="space-y-3 pt-2">
        <Link
          href={signInHref}
          className="inline-flex w-full items-center justify-center rounded-sm bg-maroon px-5 py-3 text-sm font-medium text-white transition-colors hover:bg-maroon-dark"
        >
          Sign in with EHS Google to begin
        </Link>
        {authError && (
          <p className="text-center text-xs text-red-700">{authError}</p>
        )}
        <p className="text-center text-xs italic text-cool-gray">
          By continuing you agree this reflection is your own work, in keeping
          with the EHS Honor Code.
        </p>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Signed-in router

function SignedInFlow({
  iframeToken,
  studentDisplayName,
  hasActiveReflection,
  firstDraft,
  studentFacingQuestion,
  onIntakeSubmitted,
}: {
  iframeToken: string;
  studentDisplayName: string;
  hasActiveReflection: boolean;
  firstDraft: string | null;
  studentFacingQuestion: string;
  onIntakeSubmitted: () => Promise<void> | void;
}) {
  const [step, setStep] = useState<Step>(
    hasActiveReflection ? "conversation" : "intake",
  );

  if (step === "intake") {
    return (
      <IntakeScreen
        iframeToken={iframeToken}
        studentDisplayName={studentDisplayName}
        studentFacingQuestion={studentFacingQuestion}
        onSubmitted={async () => {
          await onIntakeSubmitted();
          setStep("conversation");
        }}
      />
    );
  }
  return (
    <ConversationScreen
      iframeToken={iframeToken}
      studentFacingQuestion={studentFacingQuestion}
      firstDraft={firstDraft ?? ""}
    />
  );
}

// -----------------------------------------------------------------------------
// Intake

function IntakeScreen({
  iframeToken,
  studentDisplayName,
  studentFacingQuestion,
  onSubmitted,
}: {
  iframeToken: string;
  studentDisplayName: string;
  studentFacingQuestion: string;
  onSubmitted: () => void;
}) {
  const [chats, setChats] = useState<Chat[]>([{ tool: "gemini", url: "" }]);
  const [timeSpent, setTimeSpent] = useState<TimeSpentBand | null>(null);
  const [pastedTranscript, setPastedTranscript] = useState("");
  const [firstDraft, setFirstDraft] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const hasAnyUrl = chats.some((c) => c.url.trim().length > 5);
  const hasPaste = pastedTranscript.trim().length > 20;
  const draftLen = firstDraft.trim().length;
  const draftReady = draftLen >= 50;
  const canContinue =
    (hasAnyUrl || hasPaste) && timeSpent !== null && draftReady;

  function updateChat(i: number, patch: Partial<Chat>) {
    setChats(chats.map((c, idx) => (idx === i ? { ...c, ...patch } : c)));
  }
  function removeChat(i: number) {
    if (chats.length === 1) setChats([{ tool: "gemini", url: "" }]);
    else setChats(chats.filter((_, idx) => idx !== i));
  }
  function addChat() {
    const lastTool = chats[chats.length - 1]?.tool ?? "gemini";
    setChats([...chats, { tool: lastTool, url: "" }]);
  }

  function onSubmit() {
    if (!canContinue || !timeSpent) return;
    setSubmitError(null);
    startTransition(async () => {
      const res = await submitIntake({
        iframeToken,
        chats,
        pasteFallbackText: pastedTranscript,
        timeSpentEstimate: timeSpent,
        firstDraft,
      });
      if (res.ok) onSubmitted();
      else setSubmitError(res.error);
    });
  }

  return (
    <div className="mx-auto w-full max-w-2xl space-y-12">
      <div className="ehs-eyebrow text-cool-gray">
        Signed in as {studentDisplayName}
      </div>

      <Section numeral="i" label="Your AI use">
        <p className="text-sm leading-relaxed text-cool-gray">
          Add a row for each AI chat you used on this assignment.
        </p>

        <ul className="space-y-2">
          {chats.map((chat, i) => (
            <li
              key={i}
              className="flex items-center gap-2 rounded-sm border border-light-blue/60 bg-white p-2"
            >
              <select
                value={chat.tool}
                onChange={(e) =>
                  updateChat(i, { tool: e.target.value as Tool })
                }
                className="shrink-0 rounded-sm border border-light-blue/80 bg-white px-2 py-1.5 text-sm focus:border-maroon"
              >
                <option value="gemini">Gemini</option>
                <option value="chatgpt">ChatGPT</option>
                <option value="claude">Claude</option>
              </select>
              <input
                type="url"
                value={chat.url}
                onChange={(e) => updateChat(i, { url: e.target.value })}
                placeholder={placeholderForTool(chat.tool)}
                className="min-w-0 flex-1 rounded-sm border border-light-blue/80 bg-white px-2 py-1.5 font-mono text-xs focus:border-maroon"
              />
              <button
                onClick={() => removeChat(i)}
                aria-label="Remove this chat"
                title="Remove this chat"
                className="shrink-0 rounded-sm p-1.5 text-cool-gray transition-colors hover:bg-light-blue/30 hover:text-maroon"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
        <button
          onClick={addChat}
          className="text-xs italic text-maroon underline-offset-2 hover:underline"
        >
          + add another chat
        </button>

        <div className="space-y-2 pt-2">
          <label className="ehs-eyebrow block text-cool-gray">
            Paste your AI conversation(s)
          </label>
          <p className="text-xs leading-relaxed text-cool-gray">
            Open your AI chat, select all, copy, and paste here. Multiple
            chats? Separate them with a blank line.
          </p>
          <textarea
            value={pastedTranscript}
            onChange={(e) => setPastedTranscript(e.target.value)}
            placeholder="Paste your AI conversation here…"
            rows={6}
            className="w-full rounded-sm border border-light-blue/80 bg-white px-3 py-2 text-sm focus:border-maroon"
          />
        </div>

        <fieldset className="pt-2">
          <legend className="ehs-eyebrow mb-2 text-cool-gray">
            About how long did you spend using AI tools on this assignment?
          </legend>
          <div className="flex flex-col gap-1.5">
            {TIME_BANDS.map((band) => (
              <label
                key={band.value}
                className={`flex cursor-pointer items-center gap-2 rounded-sm border px-3 py-2 text-sm transition-colors ${
                  timeSpent === band.value
                    ? "border-maroon bg-maroon/5 text-maroon"
                    : "border-light-blue/80 bg-white text-ink hover:border-maroon/50"
                }`}
              >
                <input
                  type="radio"
                  name="time-spent"
                  value={band.value}
                  checked={timeSpent === band.value}
                  onChange={() => setTimeSpent(band.value)}
                  className="sr-only"
                />
                <span>{band.label}</span>
              </label>
            ))}
          </div>
        </fieldset>
      </Section>

      <Section numeral="ii" label="Summary & Reflection">
        <StaticPrompt text={studentFacingQuestion} />

        <div>
          <textarea
            value={firstDraft}
            onChange={(e) => setFirstDraft(e.target.value)}
            rows={10}
            className="w-full rounded-sm border border-light-blue/80 bg-white px-4 py-3 font-document text-[15px] leading-relaxed text-ink focus:border-maroon"
          />
          <div className="mt-1.5 flex justify-end">
            <span
              className={`text-xs ${
                draftReady ? "text-cool-gray" : "text-maroon/70"
              }`}
            >
              {draftLen} {draftLen === 1 ? "character" : "characters"}
              {!draftReady && " · 50 minimum"}
            </span>
          </div>
        </div>
      </Section>

      {submitError && (
        <p className="rounded-sm border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          {submitError}
        </p>
      )}

      <button
        onClick={onSubmit}
        disabled={!canContinue || pending}
        className="inline-flex w-full items-center justify-center rounded-sm bg-maroon px-5 py-3 text-sm font-medium text-white transition-colors hover:bg-maroon-dark disabled:cursor-not-allowed disabled:bg-cool-gray/50"
      >
        {pending ? "Saving…" : "Submit & continue →"}
      </button>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Conversation (post-intake)

function ConversationScreen({
  iframeToken,
  studentFacingQuestion,
  firstDraft,
}: {
  iframeToken: string;
  studentFacingQuestion: string;
  firstDraft: string;
}) {
  const [messages, setMessages] = useState<ReflectionMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [pending, startTransition] = useTransition();
  const [done, setDone] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [turnError, setTurnError] = useState<string | null>(null);
  const [finalize, setFinalize] = useState<FinalizeState>({ kind: "idle" });
  const initialFetched = useRef(false);
  const finalizeStarted = useRef(false);
  const scrollAnchorRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (initialFetched.current) return;
    initialFetched.current = true;
    startTransition(async () => {
      const res = await nextSocraticTurn({ iframeToken, studentMessage: "" });
      if (res.ok) {
        setMessages(res.messages);
        setDone(res.conversationDone);
      } else {
        setLoadError(res.error);
      }
    });
  }, [iframeToken]);

  // When the Socratic conversation closes, fire the closing pipeline once.
  // The action generates the objective summary, posts to Canvas as the
  // student, and notifies super-grader. We surface either "Submitted" or
  // "Paste this code into Canvas" to the student based on the result.
  useEffect(() => {
    if (!done || finalizeStarted.current) return;
    finalizeStarted.current = true;
    setFinalize({ kind: "running" });
    void (async () => {
      const res = await finalizeReflection({ iframeToken });
      if (!res.ok) {
        setFinalize({ kind: "needsCode", code: "", error: res.error });
        return;
      }
      if (res.canvasSubmitted) {
        setFinalize({ kind: "submitted" });
      } else {
        setFinalize({
          kind: "needsCode",
          code: res.completionCode,
          error: res.canvasError ?? "Couldn't submit to Canvas.",
        });
      }
    })();
  }, [done, iframeToken]);

  // Scroll the latest coach question into view as new turns arrive.
  useEffect(() => {
    if (scrollAnchorRef.current) {
      scrollAnchorRef.current.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
    }
  }, [messages.length, pending]);

  function send() {
    const text = draft.trim();
    if (!text || pending || done) return;
    setTurnError(null);
    const optimistic: ReflectionMessage[] = [
      ...messages,
      { role: "student", text, ts: new Date().toISOString() },
    ];
    setMessages(optimistic);
    setDraft("");
    startTransition(async () => {
      const res = await nextSocraticTurn({
        iframeToken,
        studentMessage: text,
      });
      if (res.ok) {
        setMessages(res.messages);
        setDone(res.conversationDone);
      } else {
        setMessages(messages);
        setTurnError(res.error);
        setDraft(text);
      }
    });
  }

  const studentTurns = messages.filter((m) => m.role === "student").length;
  const totalStudentTurns = 2;
  const aiHasOpened = messages.length > 0;

  if (loadError) {
    return (
      <div className="mx-auto max-w-md pt-12 text-center text-sm text-red-700">
        {loadError}
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-2xl space-y-8">
      <ConversationHeader
        studentTurns={studentTurns}
        totalStudentTurns={totalStudentTurns}
        done={done}
      />

      <div className="space-y-5">
        <ChatBubble role="student" caption="Your reflection">
          {firstDraft || (
            <span className="italic text-cool-gray">(no first draft saved)</span>
          )}
        </ChatBubble>

        {messages.map((m, i) => (
          <ChatBubble
            key={i}
            role={m.role}
            caption={captionFor(m, i, messages)}
          >
            {m.text}
          </ChatBubble>
        ))}

        {pending && <CoachThinking />}

        <div ref={scrollAnchorRef} />
      </div>

      {done ? (
        <FinalizeStatus state={finalize} />
      ) : (
        aiHasOpened && (
          <Composer
            value={draft}
            onChange={setDraft}
            onSend={send}
            disabled={pending}
            error={turnError}
          />
        )
      )}
    </div>
  );
}

function ConversationHeader({
  studentTurns,
  totalStudentTurns,
  done,
}: {
  studentTurns: number;
  totalStudentTurns: number;
  done: boolean;
}) {
  const nextNumber = Math.min(totalStudentTurns, studentTurns + 1);
  return (
    <div className="flex items-baseline justify-between gap-4">
      <div>
        <div className="ehs-eyebrow text-maroon">Reflection conversation</div>
        <h2 className="mt-1 text-2xl text-maroon">
          {done
            ? "Reflection complete"
            : `Question ${nextNumber} of ${totalStudentTurns}`}
        </h2>
      </div>
      <ProgressDots done={studentTurns} total={totalStudentTurns} />
    </div>
  );
}

function captionFor(
  m: ReflectionMessage,
  i: number,
  all: ReflectionMessage[],
): string | undefined {
  if (m.role === "student") return undefined;
  // Label the very first AI message so students know who's speaking; later
  // bubbles are clear from alignment alone.
  const aiBefore = all.slice(0, i + 1).filter((x) => x.role === "ai").length - 1;
  return aiBefore === 0 ? "Reflection Partner" : undefined;
}

// -----------------------------------------------------------------------------
// Editorial pieces

function FinalizeStatus({ state }: { state: FinalizeState }) {
  if (state.kind === "idle") return null;

  if (state.kind === "running") {
    return (
      <div className="rounded-sm border border-light-blue/60 bg-white px-5 py-4 text-center">
        <div className="ehs-eyebrow text-cool-gray inline-flex items-center gap-1.5">
          Finalizing
          <Dot delay="0s" />
          <Dot delay="0.15s" />
          <Dot delay="0.3s" />
        </div>
        <p className="mt-2 text-sm italic text-cool-gray">
          Posting your reflection to Canvas&hellip;
        </p>
      </div>
    );
  }

  if (state.kind === "submitted") {
    return (
      <div className="rounded-sm border border-maroon/30 bg-white px-5 py-4 text-center">
        <div className="ehs-eyebrow text-maroon">Submitted to Canvas</div>
        <p className="mt-2 text-sm text-ink">
          Thanks &mdash; your reflection is on the assignment. Your teacher
          will see it alongside your work.
        </p>
      </div>
    );
  }

  // needsCode
  return (
    <div className="rounded-sm border border-maroon/40 bg-white px-5 py-5">
      <div className="ehs-eyebrow text-maroon">
        Canvas didn&rsquo;t accept the auto-submit
      </div>
      <p className="mt-2 text-sm leading-relaxed text-ink">
        Paste this code into the Canvas assignment as your submission so your
        teacher knows you completed the reflection:
      </p>
      {state.code ? (
        <div className="my-4 text-center">
          <code className="rounded-sm border border-maroon/40 bg-paper px-4 py-3 font-mono text-2xl tracking-[0.3em] text-maroon">
            {state.code}
          </code>
        </div>
      ) : (
        <p className="my-3 text-sm italic text-cool-gray">
          We couldn&rsquo;t look up a code &mdash; refresh this page to retry.
        </p>
      )}
      {state.error && (
        <p className="mt-1 text-xs italic text-cool-gray">
          ({state.error})
        </p>
      )}
    </div>
  );
}

function Section({
  numeral,
  label,
  children,
}: {
  numeral: string;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-5">
      <div className="flex items-baseline gap-3">
        <span className="text-sm italic text-maroon">{numeral}.</span>
        <h2 className="text-2xl text-maroon">{label}</h2>
      </div>
      <hr className="ehs-rule-maroon" />
      <div className="space-y-5">{children}</div>
    </section>
  );
}

function StaticPrompt({ text }: { text: string }) {
  return (
    <figure className="border-l-2 border-maroon py-1 pl-5">
      <div className="ehs-eyebrow text-maroon">Prompt</div>
      <blockquote className="mt-1.5 font-document text-[17px] leading-relaxed italic text-ink">
        {text}
      </blockquote>
    </figure>
  );
}

function ChatBubble({
  role,
  caption,
  children,
}: {
  role: "ai" | "student";
  caption?: string;
  children: React.ReactNode;
}) {
  const aligned = role === "ai" ? "items-start" : "items-end";
  const captionColor =
    role === "ai" ? "text-maroon" : "text-cool-gray";
  const bubble =
    role === "ai"
      ? "border border-light-blue/80 bg-white"
      : "border border-maroon/30 bg-maroon/5";
  return (
    <div className={`flex flex-col gap-1.5 ${aligned}`}>
      {caption && (
        <div className={`ehs-eyebrow ${captionColor}`}>{caption}</div>
      )}
      <div
        className={`max-w-[90%] whitespace-pre-wrap rounded-md px-5 py-4 text-[15px] leading-relaxed text-ink ${bubble}`}
      >
        {children}
      </div>
    </div>
  );
}

function CoachThinking() {
  return (
    <div className="flex flex-col items-start gap-1.5">
      <div className="ehs-eyebrow text-maroon">Coach</div>
      <div className="inline-flex items-center gap-1 rounded-md border border-light-blue/80 bg-white px-4 py-3">
        <Dot delay="0s" />
        <Dot delay="0.15s" />
        <Dot delay="0.3s" />
      </div>
    </div>
  );
}

function Composer({
  value,
  onChange,
  onSend,
  disabled,
  error,
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  disabled: boolean;
  error: string | null;
}) {
  return (
    <div className="rounded-md border border-light-blue/80 bg-white shadow-sm">
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Type your answer here. Take your time — write as much as you need."
        rows={6}
        disabled={disabled}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            onSend();
          }
        }}
        className="w-full resize-y rounded-t-md bg-white px-4 py-3 text-[15px] leading-relaxed text-ink focus:outline-none disabled:bg-cool-gray/5"
      />
      <div className="flex items-center justify-between border-t border-light-blue/40 bg-paper/40 px-3 py-2">
        <span className="text-xs italic text-cool-gray">
          ⌘+Enter to send
        </span>
        <button
          onClick={onSend}
          disabled={!value.trim() || disabled}
          className="inline-flex items-center justify-center rounded-sm bg-maroon px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-maroon-dark disabled:cursor-not-allowed disabled:bg-cool-gray/50"
        >
          {disabled ? "Sending…" : "Send →"}
        </button>
      </div>
      {error && (
        <div className="border-t border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          {error}
        </div>
      )}
    </div>
  );
}

function ProgressDots({ done, total }: { done: number; total: number }) {
  return (
    <div className="flex shrink-0 items-center gap-1.5" aria-hidden>
      {Array.from({ length: total }, (_, i) => (
        <span
          key={i}
          className={`block h-2 w-2 rounded-full ${
            i < done ? "bg-maroon" : "bg-light-blue"
          }`}
        />
      ))}
    </div>
  );
}

function Dot({ delay }: { delay: string }) {
  return (
    <span
      className="inline-block h-1.5 w-1.5 animate-bounce rounded-full bg-cool-gray/60"
      style={{ animationDelay: delay }}
    />
  );
}

// -----------------------------------------------------------------------------
// helpers

function placeholderForTool(tool: Tool): string {
  switch (tool) {
    case "gemini":
      return "https://gemini.google.com/share/…";
    case "chatgpt":
      return "https://chatgpt.com/share/…";
    case "claude":
      return "https://claude.ai/share/…";
  }
}

function messageForError(message: string | null): string | null {
  if (!message) return null;
  if (message === "domain_not_allowed") {
    return "You must sign in with your @episcopalhighschool.org account.";
  }
  if (message === "missing_code" || message === "no_user") {
    return "Sign-in didn't complete. Try again.";
  }
  return `Sign-in error: ${message}`;
}

