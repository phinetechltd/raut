import type { Metadata } from "next";

import {
  BarChart,
  ButtonLink,
  Card,
  CellStack,
  CustomersIcon,
  DataTable,
  DateRangeBar,
  FieldIcon,
  FinanceIcon,
  Meter,
  Money,
  RankedBars,
  SalesIcon,
  SectionHeading,
  StatCard,
  StatGrid,
  StatusBadge,
  type Column,
} from "@/components/ui";
import { db } from "@/lib/db";
import { MODULE_KEYS } from "@/lib/modules";
import { AGE_BUCKET_LABELS, outstandingCents } from "@/lib/money";
import { can } from "@/lib/rbac";
import { requireTenant } from "@/lib/session";
import { preserved, rangeFromParams, rangeLabel, tableHref, tableState, toggleSort, type TableState } from "@/lib/table";
import { receivablesAgeing, tenantDashboard } from "@/server/analytics";
import { repPerformance, type RepPerformance } from "@/server/field";
import { creditedByInvoice, refreshOverdueStatuses } from "@/server/sales";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Dashboard" };

const RINV_SORT: Record<string, string> = {
  issued: "issueDate",
  number: "number",
  total: "totalCents",
  status: "status",
  channel: "channel",
};

const TEAM_SORT: Record<string, (r: RepPerformance) => string | number> = {
  rep: (r) => r.repName.toLowerCase(),
  visits: (r) => r.visitsCompleted,
  completion: (r) => r.completionRate,
  verified: (r) => r.verificationRate,
  sales: (r) => r.salesCents,
  collections: (r) => r.collectionsCents,
};

async function recentInvoices(companyId: string, ts: TableState) {
  const where = { companyId, status: { not: "DRAFT" } };
  return Promise.all([
    db.invoice.findMany({
      where,
      include: { customer: { select: { name: true, town: true } } },
      orderBy: { [RINV_SORT[ts.sort ?? "issued"]]: ts.dir } as Record<string, "asc" | "desc">,
      take: ts.limit,
      skip: (ts.page - 1) * ts.limit,
    }),
    db.invoice.count({ where }),
  ]);
}

type InvoiceRow = Awaited<ReturnType<typeof recentInvoices>>[0][number];

export default async function TenantDashboard({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { companyId, principal, claims } = await requireTenant();
  const params = await searchParams;

  // The dashboard answers one question ("how are we doing?") over a period the
  // user picks. Default 30 days; the range drives every frame on the page.
  const range = rangeFromParams(params);

  // Invoice status only moves when money moves, so due dates that passed
  // overnight need sweeping before any figure here is trustworthy.
  await refreshOverdueStatuses(companyId);

  const has = (m: string) => principal.enabledModules.has(m);
  const metrics = await tenantDashboard(companyId, { from: range.from, to: range.to });

  const rinvTs = tableState(params, {
    prefix: "rinv",
    allowed: Object.keys(RINV_SORT),
    defaultSort: "issued",
    defaultDir: "desc",
    limit: 8,
  });
  const teamTs = tableState(params, {
    prefix: "team",
    allowed: Object.keys(TEAM_SORT),
    defaultSort: "sales",
    defaultDir: "desc",
    limit: 10,
  });

  const thirtyDaysAgo = new Date(Date.now() - 29 * 86_400_000);
  const [ageing, allReps, [invoices, invoiceCount]] = await Promise.all([
    has("FINANCE") ? receivablesAgeing(companyId) : Promise.resolve(null),
    has("FIELD_SALES")
      ? repPerformance(companyId, range.from ?? thirtyDaysAgo, range.to ?? new Date())
      : Promise.resolve(null),
    // Gated on the permission too, not just the module: an accountant and a
    // storekeeper hold different rights inside the same licensed module.
    has("SALES_POS") && can(principal, "invoice:read")
      ? recentInvoices(companyId, rinvTs)
      : Promise.resolve([[] as InvoiceRow[], 0] as const),
  ]);

  // Credit notes reduce what is outstanding exactly as payments do.
  const credited = await creditedByInvoice(db, invoices.map((i) => i.id));
  const dueFor = (inv: { id: string; totalCents: number; paidCents: number }) =>
    outstandingCents({ ...inv, creditedCents: credited.get(inv.id) ?? 0 });

  // repPerformance computes its rows, so the team table is ordered and paged
  // here rather than in SQL.
  const teamValue = TEAM_SORT[teamTs.sort ?? "sales"];
  const sortedReps = allReps
    ? [...allReps].sort((a, b) => {
        const av = teamValue(a);
        const bv = teamValue(b);
        const cmp = typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv));
        return teamTs.dir === "asc" ? cmp : -cmp;
      })
    : null;
  const teamPages = Math.max(1, Math.ceil((sortedReps?.length ?? 0) / teamTs.limit));
  const teamPage = Math.min(teamTs.page, teamPages);
  const reps = sortedReps?.slice((teamPage - 1) * teamTs.limit, teamPage * teamTs.limit) ?? null;

  const rinvSortHrefFor = (key: string) => {
    const next = toggleSort(rinvTs, key);
    return tableHref("/app", params, { rinv_sort: next.sort, rinv_dir: next.dir }, "rinv");
  };
  const teamSortHrefFor = (key: string) => {
    const next = toggleSort(teamTs, key);
    return tableHref("/app", params, { team_sort: next.sort, team_dir: next.dir }, "team");
  };

  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const collectionRate =
    metrics.salesCents > 0 ? metrics.collectionsCents / metrics.salesCents : 0;

  const invoiceColumns: Array<Column<InvoiceRow>> = [
    {
      key: "number",
      header: "Invoice",
      sortKey: "number",
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
      key: "issued",
      header: "Issued",
      hideBelow: "lg",
      sortKey: "issued",
      cell: (r) => (
        <span className="text-content-muted text-xs">{r.issueDate.toLocaleDateString("en-KE")}</span>
      ),
    },
    {
      key: "channel",
      header: "Channel",
      hideBelow: "md",
      sortKey: "channel",
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
      sortKey: "total",
      cell: (r) => <Money cents={r.totalCents} />,
    },
    {
      key: "outstanding",
      header: "Outstanding",
      align: "right",
      numeric: true,
      hideBelow: "sm",
      cell: (r) => (
        <span className={dueFor(r) > 0 ? "font-medium" : "text-content-muted"}>
          <Money cents={dueFor(r)} />
        </span>
      ),
    },
    {
      key: "status",
      header: "Status",
      align: "right",
      sortKey: "status",
      cell: (r) => <StatusBadge status={r.status} />,
    },
  ];

  const repColumns: Array<Column<RepPerformance>> = [
    { key: "rep", header: "Rep", sortKey: "rep", cell: (r) => <span className="font-medium">{r.repName}</span> },
    {
      key: "visits",
      header: "Visits",
      align: "right",
      numeric: true,
      sortKey: "visits",
      cell: (r) => `${r.visitsCompleted}/${r.visitsPlanned}`,
    },
    {
      key: "completion",
      header: "Completion",
      align: "right",
      numeric: true,
      hideBelow: "sm",
      sortKey: "completion",
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
      sortKey: "verified",
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
      sortKey: "sales",
      cell: (r) => <Money cents={r.salesCents} compact />,
    },
    {
      key: "collections",
      header: "Collected",
      align: "right",
      numeric: true,
      hideBelow: "sm",
      sortKey: "collections",
      cell: (r) => <Money cents={r.collectionsCents} compact />,
    },
  ];

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {greeting}, {claims.name.split(" ")[0]}
          </h1>
          <p className="mt-1 text-base text-content-secondary">
            {rangeLabel(range)} · {principal.enabledModules.size} of {MODULE_KEYS.length} modules licensed
          </p>
        </div>
        <DateRangeBar
          action="/app"
          active={range.key}
          preserve={preserved(params, ["range", "from", "to", "days", "team_page", "rinv_page"])}
        />
      </header>

      <StatGrid>
        <StatCard
          label="Sales"
          value={<Money cents={metrics.salesCents} compact />}
          hint={`${metrics.ordersCount} invoices issued`}
          icon={<SalesIcon size={17} />}
        />
        <StatCard
          label="Collections"
          value={<Money cents={metrics.collectionsCents} compact />}
          tone="success"
          hint={`${(collectionRate * 100).toFixed(0)}% of invoiced value`}
          icon={<FinanceIcon size={17} />}
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
          icon={<FinanceIcon size={17} />}
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
          icon={<CustomersIcon size={17} />}
        />
      </StatGrid>

      {has("FIELD_SALES") ? (
        <div className="grid gap-4 sm:grid-cols-3">
          <StatCard label="Visits scheduled today" value={metrics.visitsToday} />
          <StatCard
            label="Completed today"
            value={metrics.visitsCompletedToday}
            tone="success"
            icon={<FieldIcon size={17} />}
          />
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
            icon={<FieldIcon size={17} />}
          />
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <SectionHeading
            title="Sales trend"
            description={`Invoiced value · ${rangeLabel(range)}`}
          />
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

      {reps && sortedReps && sortedReps.length > 0 ? (
        <section>
          <SectionHeading
            title="Field team"
            description={rangeLabel(range)}
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
            caption="Field rep performance over the selected period"
            sort={{ key: teamTs.sort, dir: teamTs.dir }}
            sortHrefFor={teamSortHrefFor}
            pagination={{
              page: teamPage,
              pages: teamPages,
              total: sortedReps.length,
              limit: teamTs.limit,
              hrefFor: (p) => tableHref("/app", params, { team_page: p }),
            }}
          />
        </section>
      ) : null}

      {invoiceCount > 0 ? (
        <section>
          <SectionHeading
            title="Recent invoices"
            description={`${invoiceCount.toLocaleString("en-KE")} issued`}
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
            caption="Recent invoices"
            sort={{ key: rinvTs.sort, dir: rinvTs.dir }}
            sortHrefFor={rinvSortHrefFor}
            pagination={{
              page: rinvTs.page,
              pages: Math.max(1, Math.ceil(invoiceCount / rinvTs.limit)),
              total: invoiceCount,
              limit: rinvTs.limit,
              hrefFor: (p) => tableHref("/app", params, { rinv_page: p }),
            }}
          />
        </section>
      ) : null}

      {has("ANALYTICS") ? (
        <Card>
          <SectionHeading
            title="Collection performance"
            description={`Cash collected against value invoiced · ${rangeLabel(range)}`}
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
