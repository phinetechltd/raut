
import Link from "next/link";

import {
  ModuleLocked,
  Money,
  SectionHeading,
  StatCard,
  StatusBadge,
} from "@/components/ui";
import { db } from "@/lib/db";
import { requireTenant } from "@/lib/session";
import { daysAgo } from "@/server/analytics";
import { refreshOverdueStatuses } from "@/server/sales";

export const dynamic = "force-dynamic";

/** Module 02 · Sales & POS — the invoicing surface from proposal page 7. */
export default async function SalesPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const { companyId, principal } = await requireTenant();
  if (!principal.enabledModules.has("SALES_POS")) return <ModuleLocked module="SALES_POS" />;

  await refreshOverdueStatuses(companyId);
  const filters = await searchParams;

  const selfScope =
    principal.role === "FIELD_REP" ? { createdById: principal.userId } : {};

  const [invoices, orders, monthAgg, byStatus, channelSplit] = await Promise.all([
    db.invoice.findMany({
      where: {
        companyId,
        ...selfScope,
        ...(filters.status ? { status: filters.status } : {}),
      },
      include: {
        customer: { select: { name: true, town: true, phone: true } },
        lines: { select: { id: true } },
      },
      orderBy: { issueDate: "desc" },
      take: 60,
    }),
    db.salesOrder.findMany({
      where: { companyId, ...selfScope, status: { in: ["CONFIRMED", "DRAFT"] } },
      include: { customer: { select: { name: true } } },
      orderBy: { orderDate: "desc" },
      take: 15,
    }),
    db.invoice.aggregate({
      where: {
        companyId,
        status: { notIn: ["DRAFT", "CANCELLED"] },
        issueDate: { gte: daysAgo(30) },
      },
      _sum: { totalCents: true, paidCents: true },
      _count: true,
    }),
    db.invoice.groupBy({
      by: ["status"],
      where: { companyId },
      _count: true,
      _sum: { totalCents: true },
    }),
    db.invoice.groupBy({
      by: ["channel"],
      where: { companyId, issueDate: { gte: daysAgo(30) } },
      _count: true,
      _sum: { totalCents: true },
    }),
  ]);

  const invoiced = monthAgg._sum.totalCents ?? 0;
  const collected = monthAgg._sum.paidCents ?? 0;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Sales &amp; POS</h1>
        <p className="text-content-muted text-sm">
          Quotations, orders, invoices, receipts and discounts.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Invoiced (30d)"
          value={<Money cents={invoiced} compact />}
          hint={`${monthAgg._count} invoices`}
        />
        <StatCard
          label="Collected (30d)"
          value={<Money cents={collected} compact />}
          hint={invoiced > 0 ? `${((collected / invoiced) * 100).toFixed(0)}% of invoiced` : undefined}
          tone="success"
        />
        <StatCard label="Open orders" value={String(orders.length)} hint="Awaiting invoicing" />
        <StatCard
          label="Overdue"
          value={
            <Money
              cents={byStatus.find((s) => s.status === "OVERDUE")?._sum.totalCents ?? 0}
              compact
            />
          }
          hint={`${byStatus.find((s) => s.status === "OVERDUE")?._count ?? 0} invoices`}
          tone="danger"
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="rounded-lg border border-border bg-surface p-5 shadow-sm">
          <SectionHeading title="Sales channel" description="Last 30 days" />
          <ul className="space-y-3">
            {channelSplit.map((c) => (
              <li key={c.channel} className="flex items-baseline justify-between text-sm">
                <span className="capitalize">{c.channel.toLowerCase()}</span>
                <span>
                  <Money cents={c._sum.totalCents ?? 0} compact />
                  <span className="text-content-muted ml-2 text-xs">{c._count}</span>
                </span>
              </li>
            ))}
          </ul>
          <p className="text-content-muted mt-4 text-xs">
            &ldquo;Field&rdquo; invoices were raised on the mobile app during a
            customer visit.
          </p>
        </div>

        <div className="rounded-lg border border-border bg-surface shadow-sm p-5 lg:col-span-2">
          <SectionHeading title="Invoice status" />
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            {byStatus.map((s) => (
              <div key={s.status}>
                <StatusBadge status={s.status} />
                <p className="mt-1.5 text-lg font-semibold">{s._count}</p>
                <p className="text-content-muted text-xs">
                  <Money cents={s._sum.totalCents ?? 0} compact />
                </p>
              </div>
            ))}
          </div>
        </div>
      </div>

      {orders.length > 0 ? (
        <div>
          <SectionHeading title="Open orders" description="Confirmed but not yet invoiced" />
          <div className="scroll-x rounded-lg border border-border bg-surface shadow-sm">
            <table className="w-full border-collapse text-base">
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Customer</th>
                  <th>Channel</th>
                  <th>Date</th>
                  <th>Total</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((o) => (
                  <tr key={o.id}>
                    <td className="font-medium">{o.number}</td>
                    <td>{o.customer.name}</td>
                    <td>
                      <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium bg-surface-sunken">
                        {o.channel.toLowerCase()}
                      </span>
                    </td>
                    <td className="text-content-text-content-muted">{o.orderDate.toLocaleDateString("en-KE")}</td>
                    <td>
                      <Money cents={o.totalCents} />
                    </td>
                    <td>
                      <StatusBadge status={o.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      <div>
        <SectionHeading
          title="Invoices"
          description={`${invoices.length} shown`}
          actions={
            <div className="flex flex-wrap gap-1.5">
              <a
                href="/app/sales"
                className={`badge ${!filters.status ? "bg-accent-subtle text-accent" : "bg-surface-sunken"}`}
              >
                all
              </a>
              {["ISSUED", "PARTIALLY_PAID", "OVERDUE", "PAID"].map((s) => (
                <a
                  key={s}
                  href={`/app/sales?status=${s}`}
                  className={`badge ${filters.status === s ? "bg-accent-subtle text-accent" : "bg-surface-sunken"}`}
                >
                  {s.replaceAll("_", " ").toLowerCase()}
                </a>
              ))}
            </div>
          }
        />
        <div className="scroll-x rounded-lg border border-border bg-surface shadow-sm">
          <table className="w-full border-collapse text-base">
            <thead>
              <tr>
                <th>Invoice</th>
                <th>Customer</th>
                <th>Lines</th>
                <th>Issued</th>
                <th>Due</th>
                <th>Total</th>
                <th>Paid</th>
                <th>Outstanding</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {invoices.length === 0 ? (
                <tr>
                  <td colSpan={9} className="text-content-muted py-10 text-center">
                    No invoices match this filter
                  </td>
                </tr>
              ) : (
                invoices.map((inv) => (
                  <tr key={inv.id}>
                    <td className="font-medium">
                      <Link
                        href={`/app/sales/invoices/${inv.id}`}
                        className="underline underline-offset-2"
                      >
                        {inv.number}
                      </Link>
                    </td>
                    <td>
                      {inv.customer.name}
                      <span className="text-content-muted block text-xs">{inv.customer.town}</span>
                    </td>
                    <td className="text-content-text-content-muted">{inv.lines.length}</td>
                    <td className="text-content-muted text-xs">
                      {inv.issueDate.toLocaleDateString("en-KE")}
                    </td>
                    <td className="text-content-muted text-xs">
                      {inv.dueDate?.toLocaleDateString("en-KE") ?? "On receipt"}
                    </td>
                    <td>
                      <Money cents={inv.totalCents} />
                    </td>
                    <td className="text-content-text-content-muted">
                      <Money cents={inv.paidCents} />
                    </td>
                    <td className={inv.totalCents > inv.paidCents ? "font-medium" : "muted"}>
                      <Money cents={inv.totalCents - inv.paidCents} />
                    </td>
                    <td>
                      <StatusBadge status={inv.status} />
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

