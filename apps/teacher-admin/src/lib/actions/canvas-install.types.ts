// Types for the Canvas install/uninstall server actions. Lives outside the
// "use server" file because Server Action modules can only export async
// functions (Next 16).

export type AssignmentResult = {
  canvasAssignmentId: string;
  ok: boolean;
  status: "installed" | "uninstalled" | "failed";
  message?: string;
};

export type InstallActionResult = {
  results: AssignmentResult[];
  successCount: number;
  failureCount: number;
};
