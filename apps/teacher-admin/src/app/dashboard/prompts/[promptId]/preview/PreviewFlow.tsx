"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useTransition } from "react";
import {
  previewBootstrapReflection,
  previewBuildSubmissionBody,
  previewNextSocraticTurn,
  type PreviewIntake,
} from "@/lib/actions/preview";
import type { ReflectionMessage } from "@/lib/socratic/types";

type Step = "setup" | "intake" | "conversation" | "done";
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

const DEFAULT_ASSIGNMENT_NAME = "Sample assignment: Analyze a theme in The Great Gatsby";
const DEFAULT_COURSE_NAME = "Sample course · English 11";

type Props = {
  promptId: string;
  promptLabel: string;
  studentFacingQuestion: string;
  cardHtml: string;
};

export default function PreviewFlow({
  promptId,
  promptLabel,
  studentFacingQuestion,
  cardHtml,
}: Props) {
  const [step, setStep] = useState<Step>("setup");
  const [assignmentName, setAssignmentName] = useState(DEFAULT_ASSIGNMENT_NAME);
  const [courseName, setCourseName] = useState(DEFAULT_COURSE_NAME);
  const [intake, setIntake] = useState<PreviewIntake | null>(null);
  const [messages, setMessages] = useState<ReflectionMessage[]>([]);
  const [objectiveSummary, setObjectiveSummary] = useState("");
  const [conversationDone, setConversationDone] = useState(false);
  const [pending, startTransition] = useTransition();
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [turnError, setTurnError] = useState<string | null>(null);

  function startOver() {
    setStep("setup");
    setIntake(null);
    setMessages([]);
    setObjectiveSummary("");
    setConversationDone(false);
    setBootstrapError(null);
    setTurnError(null);
  }

  return (
    <div className="space-y-6">
      <PreviewBanner promptLabel={promptLabel} onStartOver={startOver} />

      {step === "setup" && (
        <SetupStep
          assignmentName={assignmentName}
          courseName={courseName}
          onAssignmentName={setAssignmentName}
          onCourseName={setCourseName}
          cardHtml={cardHtml}
          onOpenReflection={() => setStep("intake")}
        />
      )}

      {step === "intake" && (
        <PreviewShell title={assignmentName} subtitle={courseName}>
          <IntakeStep
            studentFacingQuestion={studentFacingQuestion}
            pending={pending}
            error={bootstrapError}
            onSubmit={(submittedIntake) => {
              setBootstrapError(null);
              startTransition(async () => {
                const res = await previewBootstrapReflection({
                  promptId,
                  intake: submittedIntake,
                });
                if (!res.ok) {
                  setBootstrapError(res.error);
                  return;
                }
                setIntake(submittedIntake);
                setObjectiveSummary(res.objectiveSummary);
                setMessages(res.messages);
                setStep("conversation");
              });
            }}
          />
        </PreviewShell>
      )}

      {step === "conversation" && intake && (
        <PreviewShell title={assignmentName} subtitle={courseName}>
          <ConversationStep
            firstDraft={intake.firstDraft}
            objectiveSummary={objectiveSummary}
            messages={messages}
            pending={pending}
            error={turnError}
            done={conversationDone}
            onSend={(text) => {
              setTurnError(null);
              const optimistic: ReflectionMessage[] = [
                ...messages,
                { role: "student", text, ts: new Date().toISOString() },
              ];
              setMessages(optimistic);
              startTransition(async () => {
                const res = await previewNextSocraticTurn({
                  promptId,
                  intake,
                  objectiveSummary,
                  priorMessages: messages,
                  studentMessage: text,
                });
                if (!res.ok) {
                  setMessages(messages);
                  setTurnError(res.error);
                  return;
                }
                setMessages(res.messages);
                setConversationDone(res.conversationDone);
              });
            }}
            onContinueToDone={() => setStep("done")}
          />
        </PreviewShell>
      )}

      {step === "done" && intake && (
        <PreviewShell title={assignmentName} subtitle={courseName}>
          <DoneStep
            intake={intake}
            objectiveSummary={objectiveSummary}
            messages={messages}
            onStartOver={startOver}
          />
        </PreviewShell>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chrome

function PreviewBanner({
  promptLabel,
  onStartOver,
}: {
  promptLabel: string;
  onStartOver: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-dark-blue/30 bg-dark-blue/5 px-4 py-3">
      <div className="min-w-0">
        <div className="ehs-eyebrow text-dark-blue">Preview mode</div>
        <p className="mt-1 text-sm text-stone-700">
          You&rsquo;re testing{" "}
          <span className="font-semibold text-stone-900">{promptLabel}</span>.
          Nothing is saved or posted to Canvas.
        </p>
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onStartOver}
          className="rounded-sm border border-stone-300 px-2.5 py-1 text-xs font-medium text-stone-700 hover:border-maroon hover:text-maroon"
        >
          Start over
        </button>
        <Link
          href="/dashboard/prompts"
          className="rounded-sm border border-stone-300 px-2.5 py-1 text-xs font-medium text-stone-700 hover:border-maroon hover:text-maroon"
        >
          Back to prompts
        </Link>
      </div>
    </div>
  );
}

function PreviewShell({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-md border border-stone-200 bg-paper">
      <div className="border-b border-stone-200 px-6 py-4">
        <div className="ehs-eyebrow text-maroon">AI Use Reflection</div>
        <h2 className="mt-1 text-xl text-ink">{title}</h2>
        {subtitle && (
          <p className="text-sm italic text-cool-gray">{subtitle}</p>
        )}
      </div>
      <div className="px-6 py-8">{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 1: Setup — assignment stub form + Canvas card preview

function SetupStep({
  assignmentName,
  courseName,
  onAssignmentName,
  onCourseName,
  cardHtml,
  onOpenReflection,
}: {
  assignmentName: string;
  courseName: string;
  onAssignmentName: (v: string) => void;
  onCourseName: (v: string) => void;
  cardHtml: string;
  onOpenReflection: () => void;
}) {
  return (
    <div className="space-y-6">
      <section className="rounded-md border border-stone-200 bg-white p-5">
        <h3 className="text-sm font-semibold text-stone-900">
          Assignment context
        </h3>
        <p className="mt-1 text-xs text-stone-500">
          Pretend students are reflecting on this assignment. Edit if you want
          to test how the prompt handles different assignment language &mdash;
          the Gemini calls don&rsquo;t see this directly, but it&rsquo;s shown
          in the page header so the surface feels real.
        </p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="ehs-eyebrow text-stone-500">Assignment name</span>
            <input
              type="text"
              value={assignmentName}
              onChange={(e) => onAssignmentName(e.target.value)}
              className="mt-1 w-full rounded-sm border border-stone-300 bg-white px-3 py-2 text-sm focus:border-maroon"
            />
          </label>
          <label className="block">
            <span className="ehs-eyebrow text-stone-500">Course name</span>
            <input
              type="text"
              value={courseName}
              onChange={(e) => onCourseName(e.target.value)}
              className="mt-1 w-full rounded-sm border border-stone-300 bg-white px-3 py-2 text-sm focus:border-maroon"
            />
          </label>
        </div>
      </section>

      <section>
        <h3 className="text-sm font-semibold text-stone-900">
          What students see in Canvas
        </h3>
        <p className="mt-1 text-xs text-stone-500">
          The card is injected into the assignment description on install.
          Below is the exact HTML &mdash; same logo, colors, copy. Click{" "}
          <span className="font-semibold text-maroon">Open reflection →</span>{" "}
          inside the card to start.
        </p>
        <div className="mt-3 rounded-md border border-dashed border-stone-300 bg-white p-4">
          <CardPreview html={cardHtml} onOpenReflection={onOpenReflection} />
        </div>
      </section>
    </div>
  );
}

// Renders the trusted server-built card HTML. Clicks on any anchor inside
// the card are intercepted and advance the preview flow instead of
// navigating to /r/preview (which would 404).
function CardPreview({
  html,
  onOpenReflection,
}: {
  html: string;
  onOpenReflection: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (ref.current) ref.current.innerHTML = html;
  }, [html]);
  return (
    <div
      ref={ref}
      onClick={(e) => {
        const anchor = (e.target as HTMLElement).closest("a");
        if (anchor) {
          e.preventDefault();
          onOpenReflection();
        }
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// Step 2: Intake — chats, time band, first draft

function IntakeStep({
  studentFacingQuestion,
  pending,
  error,
  onSubmit,
}: {
  studentFacingQuestion: string;
  pending: boolean;
  error: string | null;
  onSubmit: (intake: PreviewIntake) => void;
}) {
  const [chats, setChats] = useState<Chat[]>([{ tool: "gemini", url: "" }]);
  const [timeSpent, setTimeSpent] = useState<TimeSpentBand>("15_30");
  const [pastedTranscript, setPastedTranscript] = useState("");
  const [firstDraft, setFirstDraft] = useState("");

  function updateChat(i: number, patch: Partial<Chat>) {
    setChats(chats.map((c, idx) => (idx === i ? { ...c, ...patch } : c)));
  }
  function removeChat(i: number) {
    if (chats.length === 1) setChats([{ tool: "gemini", url: "" }]);
    else setChats(chats.filter((_, idx) => idx !== i));
  }
  function addChat() {
    setChats([...chats, { tool: "gemini", url: "" }]);
  }

  const draftLen = firstDraft.trim().length;
  const draftReady = draftLen >= 50;
  const hasAnyUrl = chats.some((c) => c.url.trim().length > 5);
  const hasPaste = pastedTranscript.trim().length > 20;
  const canContinue = (hasAnyUrl || hasPaste) && draftReady && !pending;

  return (
    <div className="space-y-10">
      <p className="text-xs italic text-stone-500">
        Pre-filled with sample data so you can click through. Edit anything to
        try different shapes.
      </p>

      <Section numeral="i" label="Your AI use">
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
                type="button"
                onClick={() => removeChat(i)}
                className="shrink-0 rounded-sm p-1.5 text-cool-gray hover:bg-light-blue/30 hover:text-maroon"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
        <button
          type="button"
          onClick={addChat}
          className="text-xs italic text-maroon underline-offset-2 hover:underline"
        >
          + add another chat
        </button>

        <div className="space-y-2 pt-2">
          <label className="ehs-eyebrow block text-cool-gray">
            Paste your AI conversation(s)
          </label>
          <textarea
            value={pastedTranscript}
            onChange={(e) => setPastedTranscript(e.target.value)}
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

      {error && (
        <p className="rounded-sm border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          {error}
        </p>
      )}

      <button
        type="button"
        onClick={() =>
          onSubmit({
            chats,
            pasteFallbackText: pastedTranscript,
            firstDraft,
          })
        }
        disabled={!canContinue}
        className="inline-flex w-full items-center justify-center rounded-sm bg-maroon px-5 py-3 text-sm font-medium text-white hover:bg-maroon-dark disabled:cursor-not-allowed disabled:bg-cool-gray/50"
      >
        {pending ? "Generating opening turns…" : "Submit & continue →"}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 3: Conversation — chat bubbles + composer

function ConversationStep({
  firstDraft,
  objectiveSummary,
  messages,
  pending,
  error,
  done,
  onSend,
  onContinueToDone,
}: {
  firstDraft: string;
  objectiveSummary: string;
  messages: ReflectionMessage[];
  pending: boolean;
  error: string | null;
  done: boolean;
  onSend: (text: string) => void;
  onContinueToDone: () => void;
}) {
  const [draft, setDraft] = useState("");
  const studentTurns = messages.filter((m) => m.role === "student").length;
  const totalStudentTurns = 2;
  const scrollAnchorRef = useRef<HTMLDivElement | null>(null);
  // Match StudentFlow's M4.9 redesign: lift the summary out of the chat
  // thread into a labelled card so students read it before answering.
  const visibleMessages = objectiveSummary
    ? messages.filter(
        (m) => !(m.role === "ai" && m.text === objectiveSummary),
      )
    : messages;
  const onBootstrapTurn = studentTurns === 0;

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
    onSend(text);
    setDraft("");
  }

  return (
    <div className="space-y-8">
      <div className="flex items-baseline justify-between gap-4">
        <div>
          <div className="ehs-eyebrow text-maroon">Reflection conversation</div>
          <h2 className="mt-1 text-2xl text-maroon">
            {done
              ? "Reflection complete"
              : `Question ${Math.min(totalStudentTurns, studentTurns + 1)} of ${totalStudentTurns}`}
          </h2>
        </div>
        <div className="flex shrink-0 items-center gap-1.5" aria-hidden>
          {Array.from({ length: totalStudentTurns }, (_, i) => (
            <span
              key={i}
              className={`block h-2 w-2 rounded-full ${
                i < studentTurns ? "bg-maroon" : "bg-light-blue"
              }`}
            />
          ))}
        </div>
      </div>

      <div className="space-y-5">
        <ChatBubble role="student" caption="Your reflection">
          {firstDraft || (
            <span className="italic text-cool-gray">(no first draft)</span>
          )}
        </ChatBubble>

        {objectiveSummary && (
          <ObjectiveSummaryCard summary={objectiveSummary} />
        )}

        {visibleMessages.map((m, i) => (
          <ChatBubble
            key={i}
            role={m.role}
            caption={captionFor(m, i, visibleMessages)}
          >
            {m.text}
          </ChatBubble>
        ))}

        {pending && <CoachThinking />}
        <div ref={scrollAnchorRef} />
      </div>

      {done ? (
        <div className="rounded-sm border border-maroon/30 bg-white px-5 py-4 text-center">
          <div className="ehs-eyebrow text-maroon">Reflection complete</div>
          <p className="mt-2 text-sm text-ink">
            For a real student, the reflection would now post to Canvas as a
            submission comment (or body, if you opted into that path).
          </p>
          <button
            type="button"
            onClick={onContinueToDone}
            className="mt-4 inline-flex items-center justify-center rounded-sm bg-maroon px-4 py-2 text-sm font-medium text-white hover:bg-maroon-dark"
          >
            See what would be submitted →
          </button>
        </div>
      ) : (
        messages.length > 0 && (
          <div className="rounded-md border border-light-blue/80 bg-white shadow-sm">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={
                onBootstrapTurn
                  ? "Answer the coach's question in 2–3 sentences. Take your time."
                  : "Type your answer here. Take your time — write as much as you need."
              }
              rows={6}
              disabled={pending}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  send();
                }
              }}
              className="w-full resize-y rounded-t-md bg-white px-4 py-3 text-[15px] leading-relaxed text-ink focus:outline-none disabled:bg-cool-gray/5"
            />
            <div className="flex items-center justify-between border-t border-light-blue/40 bg-paper/40 px-3 py-2">
              <span className="text-xs italic text-cool-gray">
                ⌘+Enter to send
              </span>
              <button
                type="button"
                onClick={send}
                disabled={!draft.trim() || pending}
                className="inline-flex items-center justify-center rounded-sm bg-maroon px-5 py-2 text-sm font-medium text-white hover:bg-maroon-dark disabled:cursor-not-allowed disabled:bg-cool-gray/50"
              >
                {pending ? "Sending…" : "Send →"}
              </button>
            </div>
            {error && (
              <div className="border-t border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                {error}
              </div>
            )}
          </div>
        )
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 4: Done — show the submission HTML the student would post

function DoneStep({
  intake,
  objectiveSummary,
  messages,
  onStartOver,
}: {
  intake: PreviewIntake;
  objectiveSummary: string;
  messages: ReflectionMessage[];
  onStartOver: () => void;
}) {
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await previewBuildSubmissionBody({
        intake,
        objectiveSummary,
        messages,
      });
      if (cancelled) return;
      if (res.ok) setHtml(res.html);
      else setError(res.error);
    })();
    return () => {
      cancelled = true;
    };
  }, [intake, objectiveSummary, messages]);

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold text-stone-900">
          What would be submitted to Canvas
        </h3>
        <p className="mt-1 text-sm text-stone-600">
          This is the exact HTML body students post to Canvas when their
          reflection finishes (or the plain-text comment equivalent, depending
          on your install setting). Nothing was actually sent.
        </p>
      </div>

      {error && (
        <p className="rounded-sm border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          {error}
        </p>
      )}

      <div className="rounded-md border border-stone-200 bg-white">
        <div className="border-b border-stone-200 bg-stone-50 px-4 py-2 text-xs font-medium uppercase tracking-wide text-stone-500">
          Rendered preview
        </div>
        <div className="p-5">
          {html ? (
            <RenderedSubmission html={html} />
          ) : !error ? (
            <p className="text-sm italic text-cool-gray">Rendering…</p>
          ) : null}
        </div>
      </div>

      {html && (
        <div className="rounded-md border border-stone-200 bg-white">
          <div className="border-b border-stone-200 bg-stone-50 px-4 py-2 text-xs font-medium uppercase tracking-wide text-stone-500">
            Raw HTML
          </div>
          <pre className="max-h-[400px] overflow-auto whitespace-pre-wrap break-words p-4 font-mono text-xs leading-relaxed text-stone-700">
            {html}
          </pre>
        </div>
      )}

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onStartOver}
          className="rounded-sm border border-stone-300 px-3 py-1.5 text-sm font-medium text-stone-700 hover:border-maroon hover:text-maroon"
        >
          Run another preview
        </button>
        <Link
          href="/dashboard/prompts"
          className="rounded-sm bg-maroon px-3 py-1.5 text-sm font-medium text-white hover:bg-maroon-dark"
        >
          Back to prompts
        </Link>
      </div>
    </div>
  );
}

function RenderedSubmission({ html }: { html: string }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (ref.current) ref.current.innerHTML = html;
  }, [html]);
  return (
    <div
      ref={ref}
      className="prose prose-sm max-w-none font-document text-ink"
    />
  );
}

// ---------------------------------------------------------------------------
// Shared UI bits

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

function ObjectiveSummaryCard({ summary }: { summary: string }) {
  return (
    <section className="rounded-md border border-maroon/30 border-l-4 border-l-maroon bg-white px-5 py-4 shadow-sm">
      <div className="ehs-eyebrow text-maroon">
        Objective Summary of your AI Use
      </div>
      <p className="mt-2 whitespace-pre-wrap text-[15px] leading-relaxed text-ink">
        {summary}
      </p>
      <hr className="my-3 border-light-blue/60" />
      <p className="text-sm italic text-cool-gray">
        Read this, then answer the coach&rsquo;s question below in 2&ndash;3
        sentences.
      </p>
    </section>
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
  const captionColor = role === "ai" ? "text-maroon" : "text-cool-gray";
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

function Dot({ delay }: { delay: string }) {
  return (
    <span
      className="inline-block h-1.5 w-1.5 animate-bounce rounded-full bg-cool-gray/60"
      style={{ animationDelay: delay }}
    />
  );
}

function captionFor(
  m: ReflectionMessage,
  i: number,
  all: ReflectionMessage[],
): string | undefined {
  if (m.role === "student") return undefined;
  const aiBefore = all.slice(0, i + 1).filter((x) => x.role === "ai").length - 1;
  return aiBefore === 0 ? "Coach" : undefined;
}

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
