import "server-only";

import { db } from "./db";
import type { Principal } from "./rbac";
import { isSelfScoped } from "./rbac";

/**
 * Tenant scoping.
 *
 * The single rule this file exists to enforce: **companyId comes from the
 * authenticated principal, never from the request**. Any query that reaches
 * tenant data goes through `scope()`, so there is one place to audit rather
 * than a `where` clause per route to review.
 */

export class TenantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TenantError";
  }
}

/**
 * Base filter for a tenant-owned table.
 *
 * Field reps are additionally narrowed to their own records where the caller
 * passes `selfField` — a rep's "my visits" and a manager's "all visits" are
 * the same endpoint, differing only by this.
 */
export function scope(
  principal: Principal,
  opts?: { selfField?: string; ignoreSelfScope?: boolean },
): Record<string, unknown> {
  if (!principal.companyId) {
    throw new TenantError(
      "Principal has no company. Super Admin must query tenant data explicitly.",
    );
  }

  const filter: Record<string, unknown> = { companyId: principal.companyId };

  if (opts?.selfField && isSelfScoped(principal) && !opts.ignoreSelfScope) {
    filter[opts.selfField] = principal.userId;
  }

  return filter;
}

/** The principal's company id, or a thrown error for platform-level principals. */
export function companyIdOf(principal: Principal): string {
  if (!principal.companyId) {
    throw new TenantError("Operation requires a company-scoped principal");
  }
  return principal.companyId;
}

/**
 * Confirms a record belongs to the principal's tenant before it is mutated.
 * Returns the record, or null when it is absent *or* owned by another tenant —
 * the two are deliberately indistinguishable to the caller so that probing for
 * ids cannot reveal another company's data.
 */
export async function assertOwned<T extends { companyId: string }>(
  principal: Principal,
  record: T | null,
): Promise<T | null> {
  if (!record) return null;
  if (record.companyId !== principal.companyId) return null;
  return record;
}

/**
 * Super Admin crossing into a tenant. Separate from `scope()` on purpose: the
 * call site has to name the company, and the crossing is auditable.
 */
export function crossTenantScope(
  principal: Principal,
  companyId: string,
): Record<string, unknown> {
  if (principal.role !== "SUPER_ADMIN") {
    throw new TenantError("Cross-tenant access requires SUPER_ADMIN");
  }
  return { companyId };
}

/** Seat enforcement — the proposal licenses Raut for up to 50 users. */
export async function hasSeatAvailable(companyId: string): Promise<boolean> {
  const company = await db.company.findUnique({
    where: { id: companyId },
    select: { seatLimit: true },
  });
  if (!company) return false;

  const used = await db.user.count({
    where: { companyId, status: { not: "SUSPENDED" } },
  });
  return used < company.seatLimit;
}

export async function seatUsage(
  companyId: string,
): Promise<{ used: number; limit: number }> {
  const company = await db.company.findUnique({
    where: { id: companyId },
    select: { seatLimit: true },
  });
  const used = await db.user.count({
    where: { companyId, status: { not: "SUSPENDED" } },
  });
  return { used, limit: company?.seatLimit ?? 0 };
}
