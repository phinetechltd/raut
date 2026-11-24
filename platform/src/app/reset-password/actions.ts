"use server";

import { redirect } from "next/navigation";

import { completePasswordReset } from "@/server/password-reset";

export interface ResetState {
  error?: string;
}

export async function resetPassword(
  _prev: ResetState,
  formData: FormData,
): Promise<ResetState> {
  const token = String(formData.get("token") ?? "");
  const password = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirm") ?? "");

  if (!token) return { error: "This reset link is invalid. Request a new one." };
  if (password !== confirm) return { error: "The two passwords do not match" };

  const result = await completePasswordReset(token, password);
  if (!result.ok) return { error: result.error ?? "Could not reset your password" };

  redirect("/login?reset=1");
}
