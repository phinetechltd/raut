"use server";

import { redirect } from "next/navigation";

import { audit } from "@/lib/audit";
import { claimsForUser, setSessionCookie } from "@/lib/auth";
import { selfSignup } from "@/server/signup";

export interface SignupState {
  error?: string;
}

export async function signup(
  _prev: SignupState,
  formData: FormData,
): Promise<SignupState> {
  const companyName = String(formData.get("companyName") ?? "");
  const adminName = String(formData.get("adminName") ?? "");
  const email = String(formData.get("email") ?? "");
  const phone = String(formData.get("phone") ?? "");
  const password = String(formData.get("password") ?? "");
  const accepted = formData.get("terms") != null;

  if (!accepted) {
    return { error: "Please accept the Terms of Service and Privacy Policy to continue" };
  }

  const result = await selfSignup({ companyName, adminName, email, phone, password });
  if (!result.ok || !result.userId) {
    return { error: result.error ?? "Could not create your account. Please try again." };
  }

  const claims = await claimsForUser(result.userId);
  if (!claims) {
    // Account was created; send them to sign in manually rather than erroring.
    redirect("/login");
  }

  await setSessionCookie(claims);
  await audit({
    companyId: claims.companyId,
    userId: result.userId,
    action: "SIGNUP",
    entity: "User",
    entityId: result.userId,
    changes: { channel: "self-service" },
  });

  redirect("/app");
}
