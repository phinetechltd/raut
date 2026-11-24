import "server-only";

import { createHash, randomBytes } from "node:crypto";

import { audit } from "@/lib/audit";
import { hashPassword } from "@/lib/auth";
import { db } from "@/lib/db";
import { queueEmail } from "@/lib/email";

/**
 * Self-service password reset for console (SaaS) users.
 *
 * The raw token is emailed to the address on file and never stored; only its
 * SHA-256 hash lives in the database, so a leaked row cannot reset a password.
 * Tokens are single-use and expire after RESET_TTL_MINUTES.
 *
 * The request step never reveals whether an address has an account — the caller
 * always gets the same answer — so the form cannot be used to enumerate users.
 */

const RESET_TTL_MINUTES = 60;
export const MIN_PASSWORD_LENGTH = 8;

function tokenHash(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function baseUrl(): string {
  return (
    process.env.PUBLIC_BASE_URL ??
    process.env.NEXT_PUBLIC_APP_URL ??
    "https://raut.co.ke"
  ).replace(/\/$/, "");
}

function resetEmailHtml(name: string, link: string): string {
  return `
    <div style="font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:480px">
      <p>Hello ${name || "there"},</p>
      <p>We received a request to reset the password for your Raut account.
         Click the button below to choose a new password. This link expires in
         ${RESET_TTL_MINUTES} minutes and can be used once.</p>
      <p style="margin:24px 0">
        <a href="${link}"
           style="background:#b4531f;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;display:inline-block">
          Reset my password
        </a>
      </p>
      <p style="color:#666;font-size:13px">If the button does not work, paste this link into your browser:<br>
        <a href="${link}" style="color:#b4531f">${link}</a></p>
      <p style="color:#666;font-size:13px">If you did not ask for this, you can ignore this email —
        your password will not change.</p>
    </div>`;
}

/**
 * Starts a reset: if the email matches an active user who belongs to a company,
 * a one-time link is emailed. Always resolves without error, and the message
 * returned to the UI is the same whether or not an account was found.
 */
export async function requestPasswordReset(rawEmail: string): Promise<void> {
  const email = rawEmail.toLowerCase().trim();
  if (!email) return;

  const user = await db.user.findUnique({
    where: { email },
    include: { company: true },
  });

  // Silently stop for: unknown email, deactivated user, or an account with no
  // company (platform super admin) — reset email is tied to a tenant sender.
  if (!user || user.status !== "ACTIVE" || !user.companyId) return;
  if (user.company && user.company.status !== "ACTIVE") return;

  // Invalidate any outstanding tokens for this user before issuing a new one.
  await db.passwordResetToken.deleteMany({
    where: { userId: user.id, usedAt: null },
  });

  const raw = randomBytes(32).toString("base64url");
  await db.passwordResetToken.create({
    data: {
      userId: user.id,
      tokenHash: tokenHash(raw),
      expiresAt: new Date(Date.now() + RESET_TTL_MINUTES * 60_000),
    },
  });

  const link = `${baseUrl()}/reset-password?token=${raw}`;
  await queueEmail({
    companyId: user.companyId,
    toEmail: user.email,
    subject: "Reset your Raut password",
    html: resetEmailHtml(user.name, link),
  });

  await audit({
    companyId: user.companyId,
    userId: user.id,
    action: "PASSWORD_RESET_REQUESTED",
    entity: "User",
    entityId: user.id,
  });
}

export interface ResetResult {
  ok: boolean;
  error?: string;
}

/** Validates a token without consuming it — used to gate the reset form. */
export async function resetTokenIsValid(raw: string): Promise<boolean> {
  if (!raw) return false;
  const row = await db.passwordResetToken.findUnique({
    where: { tokenHash: tokenHash(raw) },
  });
  return Boolean(row && !row.usedAt && row.expiresAt > new Date());
}

/**
 * Completes a reset. The token is consumed on success, and every refresh token
 * for the user is revoked so a thief holding an old mobile session is cut off.
 */
export async function completePasswordReset(
  raw: string,
  newPassword: string,
): Promise<ResetResult> {
  if (newPassword.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` };
  }

  const row = await db.passwordResetToken.findUnique({
    where: { tokenHash: tokenHash(raw) },
    include: { user: true },
  });
  if (!row || row.usedAt || row.expiresAt < new Date()) {
    return { ok: false, error: "This reset link is invalid or has expired. Request a new one." };
  }

  const passwordHash = await hashPassword(newPassword);
  await db.$transaction([
    db.user.update({ where: { id: row.userId }, data: { passwordHash } }),
    db.passwordResetToken.update({ where: { id: row.id }, data: { usedAt: new Date() } }),
    db.refreshToken.updateMany({
      where: { userId: row.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    }),
  ]);

  await audit({
    companyId: row.user.companyId,
    userId: row.userId,
    action: "PASSWORD_RESET_COMPLETED",
    entity: "User",
    entityId: row.userId,
  });

  return { ok: true };
}
