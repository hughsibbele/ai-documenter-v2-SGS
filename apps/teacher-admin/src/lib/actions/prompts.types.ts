// Result shapes for prompt CRUD actions. Lives outside the "use server" file
// because Server Action modules can only export async functions (Next 16).

export type CreatePromptResult =
  | { ok: true; promptId: string }
  | { ok: false; message: string };

export type SavePromptResult =
  | { ok: true }
  | { ok: false; message: string };

export type DeletePromptResult =
  | {
      ok: true;
      uninstalledCount: number;
      reassignedPolicyCount: number;
    }
  | { ok: false; message: string };
