import type { Metadata } from "next";

import {
  BarChart,
  ButtonLink,
  Card,
  CellStack,
  DataTable,
  Meter,
  Money,
  RankedBars,
  SectionHeading,
  StatCard,
  StatGrid,
  StatusBadge,
  type Column,
} from "@/components/ui";
import { db } from "@/lib/db";
import { AGE_BUCKET_LABELS } from "@/lib/money";
import { can } from "@/lib/rbac";
import { requireTenant } from "@/lib/session";
import { receivablesAgeing, tenantDashboard } from "@/server/analytics";
import { repPerformance, type RepPerformance } from "@/server/field";
import { refreshOverdueStatuses } from "@/server/sales";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Dashboard" };

async function recentInvoices(companyId: string) {
  return db.invoice.findMany({
    where: { companyId, status: { not: "DRAFT" } },
    include: { customer: { select: { name: true, town: true } } },
    orderBy: { issueDate: "desc" },
    take: 8,
  });
}

type InvoiceRow = Awaited<ReturnType<typeof recentInvoices>>[number];

export default async function TenantDashboard() {
  const { companyId, principal, claims } = await requireTenant();

  // Invoice status only moves when money moves, so due dates that passed
  // overnight need sweeping before any figure here is trustworthy.
  await refreshOverdueStatuses(companyId);

  const has = (m: string) => principal.enabledModules.has(m);
  const metrics = await tenantDashboard(companyId, 30);

  const [ageing, reps, invoices] = await Promise.all([
    has("FINANCE") ? receivablesAgeing(companyId) : Promise.resolve(null),
    has("FIELD_SALES")
      ? repPerformance(companyId, new Date(Date.now() - 30 * 86_400_000), new Date())
      : Promise.resolve(null),
    // Gated on the permission too, not just the module: an accountant and a
    // storekeeper hold different rights inside the same licensed module.
    has("SALES_POS") && can(principal, "invoice:read")
      ? recentInvoices(companyId)
      : Promise.resolve([] as InvoiceRow[]),
  ]);

  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const collectionRate =
    metrics.salesCents > 0 ? metrics.collectionsCents / metrics.salesCents : 0;

  const invoiceColumns: Array<Column<InvoiceRow>> = [
    {
      key: "number",
      header: "Invoice",
      cell: (r) => (
        <CellStack primary={r.number} secondary={r.issueDate.toLocaleDateString("en-KE")} />
      ),
    },
    {
      key: "customer",
      header: "Customer",
      cell: (r) => <CellStack primary={r.customer.name} secondary={r.customer.town} />,
    },
    {
      key: "channel",
      header: "Channel",
      hideBelow: "md",
      cell: (r) => (
        <span className="text-sm capitalize text-content-secondary">
          {r.channel.toLowerCase()}
        </span>
      ),
    },
    {
      key: "total",
      header: "Total",
      align: "right",
      numeric: true,
      cell: (r) => <Money cents={r.totalCents} />,
    },
    {
      key: "outstanding",
      header: "Outstanding",
      align: "right",
      numeric: true,
      hideBelow: "sm",
      cell: (r) => (
        <span className={r.totalCents > r.paidCents ? "font-medium" : "text-content-muted"}>
          <Money cents={r.totalCents - r.paidCents} />
        </span>
      ),
    },
    {
      key: "status",
      header: "Status",
      align: "right",
      cell: (r) => <StatusBadge status={r.status} />,
    },
  ];

  const repColumns: Array<Column<RepPerformance>> = [
    { key: "rep", header: "Rep", cell: (r) => <span className="font-medium">{r.repName}</span> },
    {
      key: "visits",
      header: "Visits",
      align: "right",
      numeric: true,
      cell: (r) => `${r.visitsCompleted}/${r.visitsPlanned}`,
    },
    {
      key: "completion",
      header: "Completion",
      align: "right",
      numeric: true,
      hideBelow: "sm",
      cell: (r) => (
        <span className={r.completionRate < 0.7 ? "text-warning" : undefined}>
          {(r.completionRate * 100).toFixed(0)}%
        </span>
      ),
    },
    {
      key: "verified",
      header: "GPS verified",
      align: "right",
      numeric: true,
      hideBelow: "md",
      cell: (r) => (
        <span className={r.verificationRate < 0.8 ? "text-warning" : undefined}>
          {(r.verificationRate * 100).toFixed(0)}%
        </span>
      ),
    },
    {
      key: "sales",
      header: "Sales",
      align: "right",
      numeric: true,
      cell: (r) => <Money cents={r.salesCents} compact />,
    },
    {
      key: "collections",
      header: "Collected",
      align: "right",
      numeric: true,
      hideBelow: "sm",
      cell: (r) => <Money cents={r.collectionsCents} compact />,
    },
  ];

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">
          {greeting}, {claims.name.split(" ")[0]}
        </h1>
        <p className="mt-1 text-base text-content-secondary">
          Last 30 days · {principal.enabledModules.size} of 10 modules licensed
        </p>
      </header>

      <StatGrid>
        <StatCard
          label="Sales"
          value={<Money cents={metrics.salesCents} compact />}
          hint={`${metrics.ordersCount} invoices issued`}
        />
        <StatCard
          label="Collections"
          value={<Money cents={metrics.collectionsCents} compact />}
          tone="success"
          hint={
            metrics.salesCents > 0
              ? `${(collectionRate * 100).toFixed(0)}% of invoiced value`
              : undefined
          }
        />
        <StatCard
          label="Receivables"
          value={<Money cents={metrics.receivablesCents} compact />}
          tone={metrics.overdueCents > 0 ? "warning" : "neutral"}
          hint={
            <>
              <Money cents={metrics.overdueCents} compact /> overdue
            </>
          }
        />
        <StatCard
          label="Active customers"
          value={metrics.customersActive}
          tone={metrics.lowStockItems > 0 ? "warning" : "neutral"}
          hint={
            has("INVENTORY")
              ? `${metrics.lowStockItems} product(s) below reorder level`
              : undefined
          }
        />
      </StatGrid>

      {has("FIELD_SALES") ? (
        <div className="grid gap-4 sm:grid-cols-3">
          <StatCard label="Visits scheduled today" value={metrics.visitsToday} />
          <StatCard label="Completed today" value={metrics.visitsCompletedToday} tone="success" />
          <StatCard
            label="GPS-verified today"
            value={metrics.visitsVerifiedToday}
            tone={
              metrics.visitsCompletedToday > 0 &&
              metrics.visitsVerifiedToday < metrics.visitsCompletedToday
                ? "warning"
                : "success"
            }
            hint={
              has("GEOFENCING")
                ? "Check-in inside the customer geofence"
                : "Geofencing not licensed — positions recorded, not verified"
            }
          />
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <SectionHeading title="Sales trend" description="Invoiced value by week" />
          <BarChart data={metrics.weeklySales.map((w) => ({ label: w.label, value: w.cents }))} />
        </Card>

        <Card>
          <SectionHeading title="Top customers" description="By invoiced value" />
          <RankedBars
            data={metrics.topCustomers.map((c) => ({ label: c.name, value: c.cents }))}
            emptyMessage="No sales in this period"
          />
        </Card>
      </div>

      {ageing ? (
        <section>
          <SectionHeading
            title="Receivables ageing"
            description="Outstanding balance by how long it has been due"
            actions={
              <ButtonLink href="/app/finance" size="sm">
                Open Finance
              </ButtonLink>
            }
          />
          <div className="grid gap-4 sm:grid-cols-3 xl:grid-cols-5">
            {ageing.map((row) => (
              <StatCard
                key={row.bucket}
                label={AGE_BUCKET_LABELS[row.bucket]}
                value={<Money cents={row.cents} compact />}
                hint={`${row.invoices} invoice(s)`}
                tone={
                  row.bucket === "D90_PLUS"
                    ? "danger"
                    : row.bucket === "D61_90"
                      ? "warning"
                      : "neutral"
                }
              />
            ))}
          </div>
        </section>
      ) : null}

      {reps && reps.length > 0 ? (
        <section>
          <SectionHeading
            title="Field team"
            description="Last 30 days"
            actions={
              <ButtonLink href="/app/field" size="sm">
                Open Field Sales
              </ButtonLink>
            }
          />
          <DataTable
            columns={repColumns}
            rows={reps}
            getRowKey={(r) => r.repId}
            caption="Field rep performance over the last 30 days"
          />
        </section>
      ) : null}

      {invoices.length > 0 ? (
        <section>
          <SectionHeading
            title="Recent invoices"
            actions={
              <ButtonLink href="/app/sales" size="sm">
                Open Sales
              </ButtonLink>
            }
          />
          <DataTable
            columns={invoiceColumns}
            rows={invoices}
            getRowKey={(r) => r.id}
            caption="Eight most recent invoices"
          />
        </section>
      ) : null}

      {has("ANALYTICS") ? (
        <Card>
          <SectionHeading
            title="Collection performance"
            description="Cash collected against value invoiced, last 30 days"
          />
          <Meter
            value={metrics.collectionsCents}
            max={Math.max(metrics.salesCents, 1)}
            tone={collectionRate < 0.7 ? "warning" : "success"}
            label="Collection ratio"
            showValue
          />
        </Card>
      ) : null}
    </div>
  );
}
