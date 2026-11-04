import "server-only";

import { db } from "@/lib/db";
import { ageBucket, type AgeBucket } from "@/lib/money";

import { lowStockCount } from "./inventory";

/**
 * Module 10 · Advanced Reporting & Analytics, plus the Phase One dashboard.
 *
 * Aggregates are computed on read rather than materialised. At distributor
 * scale (tens of thousands of invoices) SQLite answers these in milliseconds,
 * and a stale KPI is worse than a slightly slower one. If volume outgrows that,
 * the fix is a nightly snapshot table, not a cache in front of wrong numbers.
 */

export function startOfDay(d = new Date()): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

export function daysAgo(n: number): Date {
  return startOfDay(new Date(Date.now() - n * 86_400_000));
}

export interface TenantDashboard {
  salesCents: number;
  ordersCount: number;
  collectionsCents: number;
  receivablesCents: number;
  overdueCents: number;
  customersActive: number;
  lowStockItems: number;
  visitsToday: number;
  visitsCompletedToday: number;
  visitsVerifiedToday: number;
  weeklySales: Array<{ label: string; cents: number }>;
  topCustomers: Array<{ id: string; name: string; cents: number }>;
  topProducts: Array<{ id: string; name: string; quantity: number; cents: number }>;
}

export interface DashboardRange {
  from: Date | null;
  to: Date | null;
}

/**
 * Adaptive sales buckets: daily for short windows, weekly in between, monthly
 * beyond that. The shapes stay daily/weekly/monthly because the label, not the
 * bucket name, is what the chart shows.
 */
function salesBuckets(from: Date, to: Date): Array<{ label: string; start: Date; end: Date }> {
  const spanDays = Math.max(1, Math.ceil((to.getTime() - from.getTime()) / 86_400_000));
  const buckets: Array<{ label: string; start: Date; end: Date }> = [];

  const day = 86_400_000;
  const short = (d: Date) => d.toLocaleDateString("en-KE", { day: "2-digit", month: "short" });
  const monthYear = (d: Date) => d.toLocaleDateString("en-KE", { month: "short", year: spanDays > 370 ? "numeric" : undefined });

  if (spanDays <= 21) {
    for (let i = 0; i < spanDays; i++) {
      const start = new Date(from.getTime() + i * day);
      const end = new Date(Math.min(start.getTime() + day, to.getTime()));
      buckets.push({ label: short(start).replace(/ \d{4}$/, ""), start, end });
    }
    return buckets;
  }

  if (spanDays <= 180) {
    for (let s = startOfDay(from); s.getTime() < to.getTime(); s = new Date(s.getTime() + 7 * day)) {
      const end = new Date(Math.min(s.getTime() + 7 * day, to.getTime()));
      buckets.push({ label: short(s).replace(/ \d{4}$/, ""), start: s, end });
    }
    return buckets;
  }

  for (let s = new Date(startOfDay(from).getFullYear(), startOfDay(from).getMonth(), 1); s.getTime() < to.getTime(); s = new Date(s.getFullYear(), s.getMonth() + 1, 1)) {
    const start = s < from ? new Date(from) : s;
    const next = new Date(s.getFullYear(), s.getMonth() + 1, 1);
    const end = new Date(Math.min(next.getTime(), to.getTime()));
    buckets.push({ label: monthYear(s), start, end });
  }
  return buckets;
}

export async function tenantDashboard(
  companyId: string,
  range: DashboardRange,
): Promise<TenantDashboard> {
  const now = new Date();
  const today = startOfDay();
  const tomorrow = new Date(today.getTime() + 86_400_000);

  // All-time ranges need a floor for the chart — the first invoice is it.
  let from = range.from;
  if (!from) {
    const first = await db.invoice.findFirst({
      where: { companyId, status: { notIn: ["DRAFT", "CANCELLED"] } },
      orderBy: { issueDate: "asc" },
      select: { issueDate: true },
    });
    from = first ? startOfDay(first.issueDate) : rangeFromDaysAgo(now, 29);
  }
  const to = range.to ?? now;

  const dated = { gte: from, lte: to };

  const [invoiceAgg, payments, receivables, customersActive, visits] =
    await Promise.all([
      db.invoice.aggregate({
        where: { companyId, status: { notIn: ["DRAFT", "CANCELLED"] }, issueDate: dated },
        _sum: { totalCents: true },
        _count: true,
      }),
      db.payment.aggregate({
        where: { companyId, paidAt: dated },
        _sum: { amountCents: true },
      }),
      db.invoice.findMany({
        where: {
          companyId,
          status: { in: ["ISSUED", "PARTIALLY_PAID", "OVERDUE"] },
        },
        select: { totalCents: true, paidCents: true, dueDate: true },
      }),
      db.customer.count({ where: { companyId, status: "ACTIVE" } }),
      db.visit.findMany({
        where: { companyId, scheduledAt: { gte: today, lt: tomorrow } },
        select: { status: true, geofenceVerified: true },
      }),
    ]);

  let receivablesCents = 0;
  let overdueCents = 0;
  for (const inv of receivables) {
    const outstanding = inv.totalCents - inv.paidCents;
    receivablesCents += outstanding;
    if (inv.dueDate && inv.dueDate < now) overdueCents += outstanding;
  }

  // Buckets adapt to the window — daily under three weeks, monthly past six
  // months — so the chart stays readable at 7 days and at 12 months.
  const buckets = salesBuckets(startOfDay(from), to);
  const bucketAggs = await Promise.all(
    buckets.map((b) =>
      db.invoice.aggregate({
        where: {
          companyId,
          status: { notIn: ["DRAFT", "CANCELLED"] },
          issueDate: { gte: b.start, lt: b.end },
        },
        _sum: { totalCents: true },
      }),
    ),
  );
  const weeklySales = buckets.map((b, i) => ({
    label: b.label,
    cents: bucketAggs[i]._sum.totalCents ?? 0,
  }));

  const customerTotals = await db.invoice.groupBy({
    by: ["customerId"],
    where: { companyId, status: { notIn: ["DRAFT", "CANCELLED"] }, issueDate: { gte: from, lte: to } },
    _sum: { totalCents: true },
    orderBy: { _sum: { totalCents: "desc" } },
    take: 5,
  });

  const customerNames = await db.customer.findMany({
    where: { id: { in: customerTotals.map((c) => c.customerId) } },
    select: { id: true, name: true },
  });
  const nameById = new Map(customerNames.map((c) => [c.id, c.name]));

  const lines = await db.invoiceLine.findMany({
    where: {
      invoice: {
        companyId,
        status: { notIn: ["DRAFT", "CANCELLED"] },
        issueDate: { gte: from, lte: to },
      },
    },
    select: { productId: true, description: true, quantity: true, lineTotalCents: true },
  });

  const productAgg = new Map<string, { name: string; quantity: number; cents: number }>();
  for (const line of lines) {
    const entry = productAgg.get(line.productId) ?? {
      name: line.description,
      quantity: 0,
      cents: 0,
    };
    entry.quantity += line.quantity;
    entry.cents += line.lineTotalCents;
    productAgg.set(line.productId, entry);
  }

  const topProducts = [...productAgg.entries()]
    .map(([id, v]) => ({ id, ...v }))
    .sort((a, b) => b.cents - a.cents)
    .slice(0, 5);

  return {
    salesCents: invoiceAgg._sum.totalCents ?? 0,
    ordersCount: invoiceAgg._count,
    collectionsCents: payments._sum.amountCents ?? 0,
    receivablesCents,
    overdueCents,
    customersActive,
    lowStockItems: await lowStockCount(companyId),
    visitsToday: visits.length,
    visitsCompletedToday: visits.filter((v) => v.status === "COMPLETED").length,
    visitsVerifiedToday: visits.filter((v) => v.geofenceVerified).length,
    weeklySales,
    topCustomers: customerTotals.map((c) => ({
      id: c.customerId,
      name: nameById.get(c.customerId) ?? "Unknown",
      cents: c._sum.totalCents ?? 0,
    })),
    topProducts,
  };
}

function rangeFromDaysAgo(now: Date, days: number): Date {
  return new Date(startOfDay(now).getTime() - days * 86_400_000);
}

export interface PlatformOverview {
  companies: number;
  companiesActive: number;
  activeUsers: number;
  monthlyGmvCents: number;
  /** Share of licensable module slots actually sold, 0–1 */
  moduleAdoption: number;
  licensedValueCents: number;
  weeklyOrders: Array<{ label: string; count: number }>;
  moduleCounts: Array<{ moduleKey: string; companies: number }>;
  recentCompanies: Array<{
    id: string;
    name: string;
    status: string;
    users: number;
    modules: number;
    createdAt: Date;
  }>;
}

/** Powers the Super Admin dashboard on proposal p.5. */
export async function platformOverview(): Promise<PlatformOverview> {
  const monthStart = daysAgo(30);

  const [companies, companiesActive, activeUsers, gmv, licences] = await Promise.all([
    db.company.count(),
    db.company.count({ where: { status: "ACTIVE" } }),
    db.user.count({ where: { status: "ACTIVE", role: { not: "SUPER_ADMIN" } } }),
    db.invoice.aggregate({
      where: { status: { notIn: ["DRAFT", "CANCELLED"] }, issueDate: { gte: monthStart } },
      _sum: { totalCents: true },
    }),
    db.companyModule.findMany({
      where: { enabled: true },
      select: { moduleKey: true, priceCents: true },
    }),
  ]);

  const weeklyOrders: Array<{ label: string; count: number }> = [];
  for (let w = 5; w >= 0; w--) {
    const count = await db.salesOrder.count({
      where: { orderDate: { gte: daysAgo((w + 1) * 7), lt: daysAgo(w * 7) } },
    });
    weeklyOrders.push({ label: `W${6 - w}`, count });
  }

  const moduleCountMap = new Map<string, number>();
  for (const l of licences) {
    moduleCountMap.set(l.moduleKey, (moduleCountMap.get(l.moduleKey) ?? 0) + 1);
  }

  const recent = await db.company.findMany({
    orderBy: { createdAt: "desc" },
    take: 8,
    select: {
      id: true,
      name: true,
      status: true,
      createdAt: true,
      _count: { select: { users: true } },
      modules: { where: { enabled: true }, select: { id: true } },
    },
  });

  return {
    companies,
    companiesActive,
    activeUsers,
    monthlyGmvCents: gmv._sum.totalCents ?? 0,
    moduleAdoption: companies > 0 ? licences.length / (companies * 10) : 0,
    licensedValueCents: licences.reduce((sum, l) => sum + l.priceCents, 0),
    weeklyOrders,
    moduleCounts: [...moduleCountMap.entries()].map(([moduleKey, count]) => ({
      moduleKey,
      companies: count,
    })),
    recentCompanies: recent.map((c) => ({
      id: c.id,
      name: c.name,
      status: c.status,
      users: c._count.users,
      modules: c.modules.length,
      createdAt: c.createdAt,
    })),
  };
}

export interface AgeingRow {
  bucket: AgeBucket;
  invoices: number;
  cents: number;
}

/** Receivables ageing — Module 05's headline report. */
export async function receivablesAgeing(companyId: string): Promise<AgeingRow[]> {
  const invoices = await db.invoice.findMany({
    where: { companyId, status: { in: ["ISSUED", "PARTIALLY_PAID", "OVERDUE"] } },
    select: { totalCents: true, paidCents: true, dueDate: true },
  });

  const buckets: Record<AgeBucket, { invoices: number; cents: number }> = {
    CURRENT: { invoices: 0, cents: 0 },
    D1_30: { invoices: 0, cents: 0 },
    D31_60: { invoices: 0, cents: 0 },
    D61_90: { invoices: 0, cents: 0 },
    D90_PLUS: { invoices: 0, cents: 0 },
  };

  for (const inv of invoices) {
    const bucket = ageBucket(inv.dueDate);
    buckets[bucket].invoices += 1;
    buckets[bucket].cents += inv.totalCents - inv.paidCents;
  }

  return (Object.keys(buckets) as AgeBucket[]).map((bucket) => ({
    bucket,
    ...buckets[bucket],
  }));
}

/** Territory performance — Module 10 bullet 2. */
export async function territoryPerformance(companyId: string, days = 30) {
  const from = daysAgo(days);

  const territories = await db.territory.findMany({
    where: { companyId, active: true },
    include: { _count: { select: { customers: true } } },
    orderBy: { name: "asc" },
  });

  const rows = [];
  for (const t of territories) {
    const invoices = await db.invoice.aggregate({
      where: {
        companyId,
        issueDate: { gte: from },
        status: { notIn: ["DRAFT", "CANCELLED"] },
        customer: { territoryId: t.id },
      },
      _sum: { totalCents: true },
      _count: true,
    });

    const visits = await db.visit.count({
      where: { companyId, scheduledAt: { gte: from }, customer: { territoryId: t.id } },
    });

    rows.push({
      id: t.id,
      name: t.name,
      colour: t.colour,
      customers: t._count.customers,
      invoices: invoices._count,
      salesCents: invoices._sum.totalCents ?? 0,
      visits,
    });
  }

  return rows.sort((a, b) => b.salesCents - a.salesCents);
}
