// Shared between the real student flow, the Socratic helpers, and the
// teacher preview. Lives in its own module (no "use server", no "server-only")
// so the type can be imported from anywhere without dragging a runtime
// dependency or triggering Turbopack's "use server" wrapping logic on a
// re-export.
export type ReflectionMessage = {
  role: "ai" | "student";
  text: string;
  ts: string;
};
