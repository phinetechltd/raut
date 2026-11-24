"use server";

import { requestPasswordReset } from "@/server/password-reset";

export interface ForgotState {
  sent?: boolean;
  error?: string;
}

export async function requestReset(
  _prev: ForgotState,
  formData: FormData,
): Promise<ForgotState> {
  const email = String(formData.get("email") ?? "").trim();
  if (!email) return { error: "Enter your email address" };

  try {
    await requestPasswordReset(email);
  } catch {
    // Never surface internal failures here — doing so would leak whether an
    // address exists. The uniform confirmation is shown regardless.
  }
  return { sent: true };
}
