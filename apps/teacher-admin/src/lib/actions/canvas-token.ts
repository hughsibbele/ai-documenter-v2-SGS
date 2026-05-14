"use server";

import { revalidatePath } from "next/cache";
import { CanvasError, getSelf } from "@ai-documenter/canvas";
import { encryptSecret, readKeyFromEnv } from "@ai-documenter/crypto";
import { getCurrentTeacher } from "@/lib/auth/teacher";
import { getServerDbClient } from "@/lib/supabase/server";
import { EHS_CANVAS_HOST, type ConnectState } from "./canvas-token.types";

export async function connectCanvas(
  _prev: ConnectState,
  formData: FormData,
): Promise<ConnectState> {
  const token = (formData.get("token") ?? "").toString().trim();
  if (!token) {
    return { status: "error", message: "Paste a Canvas API token first." };
  }

  let canvasUser;
  try {
    canvasUser = await getSelf({ host: EHS_CANVAS_HOST, token });
  } catch (err) {
    if (err instanceof CanvasError) {
      return { status: "error", message: err.message };
    }
    return {
      status: "error",
      message: "Couldn't reach Canvas. Check your connection and try again.",
    };
  }

  const teacher = await getCurrentTeacher();
  const supabase = await getServerDbClient();
  const encrypted = encryptSecret(token, readKeyFromEnv());

  const { error } = await supabase
    .from("teachers")
    .update({
      canvas_token_encrypted: encrypted,
      canvas_host: EHS_CANVAS_HOST,
    })
    .eq("id", teacher.id);

  if (error) {
    return {
      status: "error",
      message: `Token verified, but saving it failed: ${error.message}`,
    };
  }

  revalidatePath("/dashboard/setup");
  revalidatePath("/dashboard");
  return { status: "ok", canvasUserName: canvasUser.name };
}

export async function disconnectCanvas(): Promise<void> {
  const teacher = await getCurrentTeacher();
  const supabase = await getServerDbClient();
  await supabase
    .from("teachers")
    .update({
      canvas_token_encrypted: null,
      canvas_host: null,
    })
    .eq("id", teacher.id);
  revalidatePath("/dashboard/setup");
  revalidatePath("/dashboard");
}
