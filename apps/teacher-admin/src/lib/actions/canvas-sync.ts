"use server";

import { revalidatePath } from "next/cache";
import { getCurrentTeacher } from "@/lib/auth/teacher";
import { syncTeacherCanvasData } from "@/lib/sync/canvas-sync";
import { autoInstallNewAssignmentsForTeacher } from "@/lib/sync/auto-install";

// Triggered by the Refresh button in the dashboard page.
// Two steps, matching the nightly cron's per-teacher sequence:
//   1. Refresh the course/assignment cache from Canvas.
//   2. For courses with auto-install policy enabled, install the reflection
//      card on any newly-encountered published assignment. Without this, a
//      teacher who flips on auto-install and creates a new assignment in
//      Canvas would have to wait up to 24h for the nightly cron to pick it
//      up.
export async function refreshCanvas(): Promise<void> {
  const teacher = await getCurrentTeacher();
  const sync = await syncTeacherCanvasData(teacher.id);
  if (sync.ok) {
    // M4.3 transition: prefer NEXT_PUBLIC_APP_URL; fall back to legacy name.
    const appBaseUrl =
      process.env.NEXT_PUBLIC_APP_URL ?? process.env.NEXT_PUBLIC_STUDENT_FORM_URL;
    if (appBaseUrl) {
      await autoInstallNewAssignmentsForTeacher(teacher.id, appBaseUrl);
    }
  }
  revalidatePath("/dashboard");
}
