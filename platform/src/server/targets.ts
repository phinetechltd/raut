import "server-only";

import { conflict, notFound } from "@/lib/api";
import { db } from "@/lib/db";
import { isSelfScoped, type Principal } from "@/lib/rbac";
import { scope } from "@/lib/tenant";

/**
 * Sales targets and commission (proposal §6, "Sales targets & performance").
 *
 * A target sets what a rep should sell, collect, visit and open in a period.
 * Achievement is read straight from the books — issued invoices, payments,
 * completed visits, new customers — so the numbers cannot drift from reality,
 * and commission is a simple basis-point share of the sales achieved.
 */

export interface TargetInput {
  repId?: string | null;
  territoryId?: string | null;
  period?: string;
  periodStart: string;
  periodEnd: string;
  targetSalesCents?: number;
  targetCollectionCents?: number;
  targetVisits?: number;
  targetNewCustomers?: number;
  commissionRateBp?: number;
}

export async function listTargets(principal: Principal, opts: { repId?: string } = {}) {
  const where: Record<string, unknown> = scope(principal);
  if (isSelfScoped(principal)) where.repId = principal.userId;
  else if (opts.repId) where.repId = opts.repId;
  return db.salesTarget.findMany({
    where,
    include: { rep: { select: { id: true, name: true } }, territory: { select: { id: true, name: true } } },
    orderBy: { periodStart: "desc" },
    take: 500,
  });
}

export async function createTarget(principal: Principal, input: TargetInput) {
  const companyId = principal.companyId!;
  if (input.repId) {
    const rep = await db.user.findFirst({ where: { id: input.repId, companyId }, select: { id: true } });
    if (!rep) throw notFound("Rep not found");
  }
  const periodStart = new Date(input.periodStart);
  const periodEnd = new Date(input.periodEnd);
  if (periodEnd <= periodStart) throw conflict("The period end must be after its start");
  return db.salesTarget.create({
    data: {
      companyId,
      repId: input.repId ?? null,
      territoryId: input.territoryId ?? null,
      period: input.period ?? "MONTHLY",
      periodStart,
      periodEnd,
      targetSalesCents: input.targetSalesCents ?? 0,
      targetCollectionCents: input.targetCollectionCents ?? 0,
      targetVisits: input.targetVisits ?? 0,
      targetNewCustomers: input.targetNewCustomers ?? 0,
      commissionRateBp: input.commissionRateBp ?? 0,
    },
  });
}

export async function updateTarget(principal: Principal, id: string, input: Partial<TargetInput>) {
  const existing = await db.salesTarget.findFirst({ where: { id, ...scope(principal) }, select: { id: true } });
  if (!existing) throw notFound("Target not found");
  const data: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (v === undefined) continue;
    if (k === "periodStart" || k === "periodEnd") data[k] = new Date(v as string);
    else data[k] = v;
  }
  return db.salesTarget.update({ where: { id }, data });
}

export async function deleteTarget(principal: Principal, id: string) {
  const existing = await db.salesTarget.findFirst({ where: { id, ...scope(principal) }, select: { id: true } });
  if (!existing) throw notFound("Target not found");
  await db.salesTarget.delete({ where: { id } });
}

/** What a rep actually did in a window, read from the books. */
async function actualsFor(companyId: string, repId: string | null, start: Date, end: Date) {
  // A company-wide (no rep) target measures the whole company.
  const by = (field: string) => (repId ? { [field]: repId } : {});
  const [salesAgg, collAgg, visits, newCustomers] = await Promise.all([
    db.invoice.aggregate({
      _sum: { totalCents: true },
      where: { companyId, ...by("createdById"), status: { notIn: ["DRAFT", "CANCELLED"] }, issueDate: { gte: start, lte: end } },
    }),
    db.payment.aggregate({
      _sum: { amountCents: true },
      where: { companyId, ...by("createdById"), paidAt: { gte: start, lte: end } },
    }),
    db.visit.count({ where: { companyId, ...by("repId"), status: "COMPLETED", scheduledAt: { gte: start, lte: end } } }),
    db.customer.count({ where: { companyId, ...by("createdById"), createdAt: { gte: start, lte: end } } }),
  ]);
  return {
    salesCents: salesAgg._sum.totalCents ?? 0,
    collectionCents: collAgg._sum.amountCents ?? 0,
    visits,
    newCustomers,
  };
}

const pct = (actual: number, target: number) => (target > 0 ? Math.round((actual / target) * 100) : null);

/**
 * Targets with their achievement and earned commission. `current: true` limits
 * to targets whose window contains today — the usual "how are we doing now" view.
 */
export async function targetAchievement(principal: Principal, opts: { current?: boolean } = {}) {
  const companyId = principal.companyId!;
  const where: Record<string, unknown> = scope(principal);
  if (isSelfScoped(principal)) where.repId = principal.userId;
  if (opts.current) {
    const now = new Date();
    where.periodStart = { lte: now };
    where.periodEnd = { gte: now };
  }
  const targets = await db.salesTarget.findMany({
    where,
    include: { rep: { select: { id: true, name: true } }, territory: { select: { id: true, name: true } } },
    orderBy: { periodStart: "desc" },
    take: 200,
  });

  return Promise.all(
    targets.map(async (t) => {
      const actual = await actualsFor(companyId, t.repId, t.periodStart, t.periodEnd);
      const commissionCents = Math.round((actual.salesCents * t.commissionRateBp) / 10_000);
      return {
        target: t,
        actual,
        progress: {
          sales: pct(actual.salesCents, t.targetSalesCents),
          collection: pct(actual.collectionCents, t.targetCollectionCents),
          visits: pct(actual.visits, t.targetVisits),
          newCustomers: pct(actual.newCustomers, t.targetNewCustomers),
        },
        commissionCents,
      };
    }),
  );
}
