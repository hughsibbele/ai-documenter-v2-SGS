// Types for the admin-only system-prompt actions.

export type CreateSystemPromptResult =
  | { ok: true; promptId: string }
  | { ok: false; message: string };

export type SaveSystemPromptResult =
  | { ok: true }
  | { ok: false; message: string };

export type DeleteSystemPromptResult =
  | {
      ok: true;
      uninstalledCount: number;
      reassignedPolicyCount: number;
    }
  | { ok: false; message: string };
