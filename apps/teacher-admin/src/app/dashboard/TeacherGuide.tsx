"use client";

import { useRef } from "react";

export function TeacherGuide() {
  const ref = useRef<HTMLDialogElement>(null);

  return (
    <>
      <button
        type="button"
        onClick={() => ref.current?.showModal()}
        className="inline-flex items-center gap-1.5 rounded-md border border-stone-300 px-2.5 py-1 text-xs font-medium text-stone-700 hover:bg-stone-100"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="12" cy="12" r="10" />
          <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
          <path d="M12 17h.01" />
        </svg>
        Guide
      </button>

      <dialog
        ref={ref}
        className="fixed inset-0 z-50 m-auto w-full max-w-[calc(100%-2rem)] rounded-md border border-stone-200 bg-white p-0 text-sm text-ink backdrop:bg-black/10 backdrop:backdrop-blur-sm sm:max-w-lg"
      >
        <div className="relative max-h-[80vh] overflow-y-auto p-5">
          <button
            type="button"
            onClick={() => ref.current?.close()}
            className="absolute top-3 right-3 inline-flex size-7 items-center justify-center rounded-md text-cool-gray transition-colors hover:bg-stone-50 hover:text-ink"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M18 6 6 18" />
              <path d="M6 6l12 12" />
            </svg>
          </button>

          <h2 className="text-base font-medium text-ink">
            How to Use AI Documenter
          </h2>

          <div className="mt-4 space-y-4 text-sm text-cool-gray">
            <div>
              <h3 className="mb-1 font-semibold text-ink">
                1. Connect Canvas
              </h3>
              <p>
                Go to Setup and paste your Canvas API token. Your courses and
                assignments sync automatically.
              </p>
            </div>

            <div>
              <h3 className="mb-1 font-semibold text-ink">
                2. Install Reflection Cards
              </h3>
              <p>
                Open any course, select assignments, choose a prompt, and click
                Install. Students see a branded reflection card directly in
                Canvas.
              </p>
            </div>

            <div>
              <h3 className="mb-1 font-semibold text-ink">
                3. Students Reflect
              </h3>
              <p>
                Students click the card in Canvas, sign in with Google, and
                complete a Socratic AI-use reflection conversation.
              </p>
            </div>

            <div>
              <h3 className="mb-1 font-semibold text-ink">4. Review</h3>
              <p>
                Reflections auto-submit to Canvas. View student responses from
                any assignment&apos;s detail page.
              </p>
            </div>

            <div className="rounded-md border border-stone-200 bg-stone-50 px-3 py-2.5">
              <h3 className="mb-1 font-semibold text-ink">Tips</h3>
              <ul className="list-disc space-y-1 pl-4">
                <li>
                  Customize prompts from the Prompts library to tailor the
                  reflection conversation.
                </li>
                <li>
                  Auto-install applies a prompt to every new assignment in a
                  course automatically.
                </li>
                <li>
                  The completion code is a fallback students can paste into
                  Canvas if automatic submission fails.
                </li>
              </ul>
            </div>
          </div>
        </div>
      </dialog>
    </>
  );
}
