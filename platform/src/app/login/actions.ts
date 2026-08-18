"use server";

import { redirect } from "next/navigation";

import { audit } from "@/lib/audit";
import {
  claimsForUser,
  clearSessionCookie,
  setSessionCookie,
  verifyPassword,
} from "@/lib/auth";
import { db } from "@/lib/db";

export interface LoginState {
  error?: string;
}

export async function login(
  _prev: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const email = String(formData.get("email") ?? "").toLowerCase().trim();
  const password = String(formData.get("password") ?? "");

  if (!email || !password) return { error: "Enter your email and password" };

  const user = await db.user.findUnique({
    where: { email },
    include: { company: true },
  });

  // Uniform failure message — the form must not reveal which accounts exist.
  const invalid = { error: "Email or password is incorrect" };

  if (!user) {
    await verifyPassword(password, "$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinva");
    return invalid;
  }
  if (!(await verifyPassword(password, user.passwordHash))) {
    await audit({
      companyId: user.companyId,
      userId: user.id,
      action: "LOGIN_FAILED",
      entity: "User",
      entityId: user.id,
    });
    return invalid;
  }
  if (user.status !== "ACTIVE") {
    return { error: "This account has been deactivated" };
  }
  if (user.companyId && user.company?.status !== "ACTIVE") {
    return { error: "Your company's subscription is not active" };
  }

  const claims = await claimsForUser(user.id);
  if (!claims) return invalid;

  await setSessionCookie(claims);
  await db.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  await audit({
    companyId: user.companyId,
    userId: user.id,
    action: "LOGIN",
    entity: "User",
    entityId: user.id,
    changes: { channel: "console" },
  });

  redirect(user.role === "SUPER_ADMIN" ? "/admin" : "/app");
}

export async function logout() {
  await clearSessionCookie();
  redirect("/login");
}
