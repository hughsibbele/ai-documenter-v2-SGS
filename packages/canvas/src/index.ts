// Canvas REST API client for AI Documenter v2.
//
// Scope: just what install-it-for-you needs.
//   - Token verification + course list (Phase B step 1-2)
//   - List + get assignments (Phase B + B2)
//   - Update assignment description (the core "install" call)
//   - Marker-block helpers for idempotent install/reinstall/uninstall (Phase B2.6)
//
// We deliberately skip rosters, submissions, grading, and rubrics — those are
// super-grader's concern. v2 student submission lands the reflection text
// via online_text_entry on the same Canvas API, but that's a separate, single
// endpoint added later.

export * from "./error";
export * from "./types";
export * from "./fetch";
export * from "./courses";
export * from "./assignments";
export * from "./install";
export * from "./submissions";
