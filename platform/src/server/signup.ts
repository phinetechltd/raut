import "server-only";

import { db } from "@/lib/db";
import { isValidEmail } from "@/lib/email";
import { MODULE_KEYS, type ModuleKey } from "@/lib/modules";

import { createCompany, slugify } from "./provisioning";

/**
 * Public self-service signup for SaaS customers.
 *
 * A visitor who completes the form gets a fully provisioned, ACTIVE tenant and
 * a COMPANY_ADMIN login they can use immediately — this is the "create account
 * and sign in" path, distinct from Super-Admin provisioning in /admin.
 *
 * New tenants start on a trial with the modules below enabled. There is no
 * billing gate yet; narrow TRIAL_MODULES, or create tenants as PENDING for
 * manual approval, when subscriptions are wired up.
 */

/** Modules a self-service trial starts with. Core platform is always included. */
export const TRIAL_MODULES: ModuleKey[] = [...MODULE_KEYS];

export const MIN_PASSWORD_LENGTH = 8;

export interface SignupInput {
  companyName: string;
  adminName: string;
  email: string;
  phone?: string | null;
  password: string;
}

export interface SignupResult {
  ok: boolean;
  error?: string;
  userId?: string;
}

/** Picks a slug not already taken, suffixing -2, -3… on collision. */
async function uniqueSlug(name: string): Promise<string> {
  const base = slugify(name) || "company";
  let candidate = base;
  for (let n = 2; n < 1000; n++) {
    const taken = await db.company.findUnique({ where: { slug: candidate } });
    if (!taken) return candidate;
    candidate = `${base}-${n}`.slice(0, 40);
  }
  // Fall back to a random suffix rather than loop forever.
  return `${base}-${Math.random().toString(36).slice(2, 7)}`.slice(0, 40);
}

export async function selfSignup(input: SignupInput): Promise<SignupResult> {
  const companyName = input.companyName.trim();
  const adminName = input.adminName.trim();
  const email = input.email.toLowerCase().trim();
  const phone = input.phone?.trim() || null;

  if (!companyName) return { ok: false, error: "Enter your business name" };
  if (!adminName) return { ok: false, error: "Enter your name" };
  if (!isValidEmail(email)) return { ok: false, error: "Enter a valid email address" };
  if (input.password.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` };
  }

  // One account per email across the whole platform (User.email is unique).
  const existing = await db.user.findUnique({ where: { email } });
  if (existing) {
    return { ok: false, error: "An account with this email already exists. Sign in instead." };
  }

  const slug = await uniqueSlug(companyName);

  const company = await createCompany({
    name: companyName,
    slug,
    email,
    phone,
    modules: TRIAL_MODULES,
    activate: true,
    admin: { name: adminName, email, password: input.password, phone },
  });

  const admin = await db.user.findFirst({
    where: { companyId: company.id, role: "COMPANY_ADMIN" },
    select: { id: true },
  });

  return { ok: true, userId: admin?.id };
}
