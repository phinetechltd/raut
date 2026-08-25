import "server-only";

import { db } from "./db";
import type { Principal } from "./rbac";

/**
 * Audit logging. Phase One of the proposal lists "role-based access & audit
 * logs" as a security deliverable, so writes that change tenant state are
 * recorded here.
 *
 * Failures are swallowed deliberately: an audit write must never be the reason
 * a legitimate business transaction fails. The trade-off is accepted because
 * this is an operational trail, not a regulatory ledger — if it becomes the
 * latter (eTIMS), it needs to move inside the transaction.
 */

export type AuditAction =
  | "CREATE"
  | "UPDATE"
  | "DELETE"
  | "LOGIN"
  | "LOGIN_FAILED"
  | "LOGOUT"
  | "ACTIVATE"
  | "SUSPEND"
  | "MODULE_ENABLE"
  | "MODULE_DISABLE"
  | "APPROVE"
  | "REJECT"
  | "SYNC"
  | "EXPORT"
  // Gateway collections. Kept distinct from CREATE so a money-movement
  // attempt is greppable in the audit trail on its own.
  | "PAYMENT_INITIATE"
  | "PAYMENT_SETTLED"
  | "PAYMENT_FAILED";

export interface AuditInput {
  companyId?: string | null;
  userId?: string | null;
  action: AuditAction;
  entity: string;
  entityId?: string | null;
  changes?: unknown;
  request?: Request;
}

function clientIp(request?: Request): string | null {
  if (!request) return null;
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim();
  return request.headers.get("x-real-ip");
}

export async function audit(input: AuditInput): Promise<void> {
  try {
    await db.auditLog.create({
      data: {
        companyId: input.companyId ?? null,
        userId: input.userId ?? null,
        action: input.action,
        entity: input.entity,
        entityId: input.entityId ?? null,
        changes:
          input.changes === undefined ? null : JSON.stringify(input.changes),
        ipAddress: clientIp(input.request),
        userAgent: input.request?.headers.get("user-agent") ?? null,
      },
    });
  } catch {
    // See note above — never let the trail break the transaction.
  }
}

/** Convenience wrapper for the common "principal did X to Y" case. */
export async function auditAs(
  principal: Principal,
  action: AuditAction,
  entity: string,
  entityId?: string | null,
  changes?: unknown,
  request?: Request,
): Promise<void> {
  await audit({
    companyId: principal.companyId,
    userId: principal.userId,
    action,
    entity,
    entityId,
    changes,
    request,
  });
}

/**
 * Diffs two records down to the fields that actually changed, so the audit
 * trail stores intent rather than a full row dump.
 */
export function diff(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Record<string, { from: unknown; to: unknown }> {
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const key of Object.keys(after)) {
    const a = before[key];
    const b = after[key];
    if (a instanceof Date && b instanceof Date) {
      if (a.getTime() !== b.getTime()) changes[key] = { from: a, to: b };
      continue;
    }
    if (a !== b) changes[key] = { from: a, to: b };
  }
  return changes;
}
