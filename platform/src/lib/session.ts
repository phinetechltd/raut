import "server-only";

import { redirect } from "next/navigation";

import { getSessionPrincipal, readSessionClaims, type TokenClaims } from "./auth";
import type { Principal } from "./rbac";

/**
 * Page-level guards for the console.
 *
 * Server components call these first; an unauthenticated or wrongly-scoped
 * visitor is redirected before any query runs, so a page cannot accidentally
 * leak data by rendering ahead of its own auth check.
 */

export interface ConsoleSession {
  principal: Principal;
  claims: TokenClaims;
}

export async function requireSession(): Promise<ConsoleSession> {
  const [principal, claims] = await Promise.all([
    getSessionPrincipal(),
    readSessionClaims(),
  ]);
  if (!principal || !claims) redirect("/login");
  return { principal, claims };
}

/** Super Admin only — the platform workspace. */
export async function requireSuperAdmin(): Promise<ConsoleSession> {
  const session = await requireSession();
  if (session.principal.role !== "SUPER_ADMIN") redirect("/app");
  return session;
}

/** Any company-scoped principal — the tenant workspace. */
export async function requireTenant(): Promise<
  ConsoleSession & { companyId: string }
> {
  const session = await requireSession();
  if (!session.principal.companyId) redirect("/admin");
  return { ...session, companyId: session.principal.companyId };
}
