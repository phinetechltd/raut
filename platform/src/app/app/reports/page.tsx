
import {
  BarChart,
  CellStack,
  DataTable,
  FilterBar,
  FilterSearch,
  Meter,
  ModuleLocked,
  Money,
  SectionHeading,
  StatCard,
  type Column,
} from "@/components/ui";
import { db } from "@/lib/db";
import { requireTenant } from "@/lib/session";
import { preserved, tableHref, tableState, toggleSort, type TableState } from "@/lib/table";
import { daysAgo, tenantDashboard, territoryPerformance } from "@/server/analytics";
import { repPerformance, type RepPerformance } from "@/server/field";

export const dynamic = "force-dynamic";

const PATH = "/app/reports";

type TerritoryRow = Awaited<ReturnType<typeof territoryPerformance>>[number];
type MixRow = {
  productId: string;
  name: string;
  sku: string;
  units: number;
  revenueCents: number;
};

const TERR_SORT: Record<string, (r: TerritoryRow) => string | number> = {
  name: (r) => r.name.toLowerCase(),
  customers: (r) => r.customers,
  invoices: (r) => r.invoices,
  visits: (r) => r.visits,
  sales: (r) => r.salesCents,
};
const STAFF_SORT: Record<string, (r: RepPerformance) => string | number> = {
  rep: (r) => r.repName.toLowerCase(),
  planned: (r) => r.visitsPlanned,
  completed: (r) => r.visitsCompleted,
  completion: (r) => r.completionRate,
  verified: (r) => r.visitsVerified,
  verification: (r) => r.verificationRate,
  orders: (r) => r.ordersCount,
  sales: (r) => r.salesCents,
  collections: (r) => r.collectionsCents,
};
const MIX_SORT: Record<string, (r: MixRow) => string | number> = {
  product: (r) => r.name.toLowerCase(),
  sku: (r) => r.sku.toLowerCase(),
  units: (r) => r.units,
  revenue: (r) => r.revenueCents,
};

/**
 * The three tables here are computed (territory and rep performance are
 * aggregates, the product mix is a groupBy), so they are searched, sorted and
 * paged in memory from the full result rather than in SQL.
 */
function arrange<T>(
  rows: T[],
  ts: TableState,
  sorters: Record<string, (r: T) => string | number>,
  fallback: string,
): { rows: T[]; page: number; pages: number; total: number } {
  const value = sorters[ts.sort ?? fallback];
  const sorted = [...rows].sort((a, b) => {
    const av = value(a);
    const bv = value(b);
    const cmp = typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv));
    return ts.dir === "asc" ? cmp : -cmp;
  });
  const pages = Math.max(1, Math.ceil(sorted.length / ts.limit));
  const page = Math.min(ts.page, pages);
  return { rows: sorted.slice((page - 1) * ts.limit, page * ts.limit), page, pages, total: sorted.length };
}

const matches = (q: string | undefined, ...fields: string[]) => {
  const needle = (q ?? "").trim().toLowerCase();
  return !needle || fields.some((f) => f.toLowerCase().includes(needle));
};

/** Module 10 · Advanced Reporting & Analytics. */
export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { companyId, principal } = await requireTenant();
  if (!principal.enabledModules.has("ANALYTICS")) return <ModuleLocked module="ANALYTICS" />;

  const params = await searchParams;
  const days = Math.min(365, Math.max(7, Number(params.days ?? 30) || 30));
  const from = daysAgo(days);

  const terrTs = tableState(params, {
    prefix: "terr",
    allowed: Object.keys(TERR_SORT),
    defaultSort: "sales",
    defaultDir: "desc",
    limit: 10,
  });
  const staffTs = tableState(params, {
    prefix: "staff",
    allowed: Object.keys(STAFF_SORT),
    defaultSort: "sales",
    defaultDir: "desc",
    limit: 10,
  });
  const mixTs = tableState(params, {
    prefix: "mix",
    allowed: Object.keys(MIX_SORT),
    defaultSort: "revenue",
    defaultDir: "desc",
    limit: 10,
  });

  const [metrics, territories, reps, channelSplit, productMix] = await Promise.all([
    tenantDashboard(companyId, { from: daysAgo(days - 1), to: new Date() }),
    territoryPerformance(companyId, days),
    repPerformance(companyId, from, new Date()),
    db.invoice.groupBy({
      by: ["channel"],
      where: { companyId, issueDate: { gte: from }, status: { notIn: ["DRAFT", "CANCELLED"] } },
      _sum: { totalCents: true },
      _count: true,
    }),
    db.invoiceLine.groupBy({
      by: ["productId"],
      where: {
        invoice: {
          companyId,
          issueDate: { gte: from },
          status: { notIn: ["DRAFT", "CANCELLED"] },
        },
      },
      _sum: { quantity: true, lineTotalCents: true },
      orderBy: { _sum: { lineTotalCents: "desc" } },
      take: 200,
    }),
  ]);

  const products = await db.product.findMany({
    where: { id: { in: productMix.map((p) => p.productId) } },
    select: { id: true, name: true, sku: true },
  });
  const productName = new Map(products.map((p) => [p.id, p]));

  const mixRows: MixRow[] = productMix.map((p) => ({
    productId: p.productId,
    name: productName.get(p.productId)?.name ?? "Unknown",
    sku: productName.get(p.productId)?.sku ?? "—",
    units: p._sum.quantity ?? 0,
    revenueCents: p._sum.lineTotalCents ?? 0,
  }));
  const mixTotal = mixRows.reduce((s, r) => s + r.revenueCents, 0);

  const terr = arrange(
    territories.filter((t) => matches(params.terr_q, t.name)),
    terrTs,
    TERR_SORT,
    "sales",
  );
  const staff = arrange(
    reps.filter((r) => matches(params.staff_q, r.repName)),
    staffTs,
    STAFF_SORT,
    "sales",
  );
  const mix = arrange(
    mixRows.filter((r) => matches(params.mix_q, r.name, r.sku)),
    mixTs,
    MIX_SORT,
    "revenue",
  );

  const sortHref = (ts: TableState, prefix: string) => (key: string) => {
    const next = toggleSort(ts, key);
    return tableHref(PATH, params, { [`${prefix}_sort`]: next.sort, [`${prefix}_dir`]: next.dir }, prefix);
  };
  const pageHref = (prefix: string) => (p: number) => tableHref(PATH, params, { [`${prefix}_page`]: p });

  const grossMargin = metrics.salesCents > 0 ? metrics.collectionsCents / metrics.salesCents : 0;

  const territoryColumns: Array<Column<TerritoryRow>> = [
    {
      key: "name",
      header: "Territory",
      sortKey: "name",
      cell: (t) => (
        <span className="inline-flex items-center gap-2">
          <span className="h-2 w-2 rounded-full" style={{ background: t.colour }} />
          <span className="font-medium">{t.name}</span>
        </span>
      ),
    },
    { key: "customers", header: "Customers", align: "right", numeric: true, sortKey: "customers", cell: (t) => t.customers },
    { key: "invoices", header: "Invoices", align: "right", numeric: true, sortKey: "invoices", cell: (t) => t.invoices },
    { key: "visits", header: "Visits", align: "right", numeric: true, hideBelow: "sm", sortKey: "visits", cell: (t) => t.visits },
    {
      key: "sales",
      header: "Sales",
      align: "right",
      numeric: true,
      sortKey: "sales",
      cell: (t) => (
        <span className="font-medium">
          <Money cents={t.salesCents} compact />
        </span>
      ),
    },
  ];

  const staffColumns: Array<Column<RepPerformance>> = [
    { key: "rep", header: "Rep", sortKey: "rep", cell: (r) => <span className="font-medium">{r.repName}</span> },
    { key: "planned", header: "Visits planned", align: "right", numeric: true, hideBelow: "md", sortKey: "planned", cell: (r) => r.visitsPlanned },
    { key: "completed", header: "Completed", align: "right", numeric: true, hideBelow: "sm", sortKey: "completed", cell: (r) => r.visitsCompleted },
    {
      key: "completion",
      header: "Completion",
      align: "right",
      numeric: true,
      sortKey: "completion",
      cell: (r) => (
        <span className={r.completionRate < 0.7 ? "text-warning" : ""}>{(r.completionRate * 100).toFixed(0)}%</span>
      ),
    },
    { key: "verified", header: "Verified", align: "right", numeric: true, hideBelow: "lg", sortKey: "verified", cell: (r) => r.visitsVerified },
    {
      key: "verification",
      header: "Verification",
      align: "right",
      numeric: true,
      hideBelow: "md",
      sortKey: "verification",
      cell: (r) => (
        <span className={r.verificationRate < 0.8 ? "text-warning" : ""}>{(r.verificationRate * 100).toFixed(0)}%</span>
      ),
    },
    { key: "orders", header: "Orders", align: "right", numeric: true, hideBelow: "lg", sortKey: "orders", cell: (r) => r.ordersCount },
    { key: "sales", header: "Sales", align: "right", numeric: true, sortKey: "sales", cell: (r) => <Money cents={r.salesCents} compact /> },
    {
      key: "collections",
      header: "Collections",
      align: "right",
      numeric: true,
      hideBelow: "sm",
      sortKey: "collections",
      cell: (r) => <Money cents={r.collectionsCents} compact />,
    },
  ];

  const mixColumns: Array<Column<MixRow>> = [
    {
      key: "product",
      header: "Product",
      sortKey: "product",
      cell: (p) => <CellStack primary={<span className="font-medium">{p.name}</span>} secondary={p.sku} />,
    },
    { key: "sku", header: "SKU", hideBelow: "md", sortKey: "sku", cell: (p) => <span className="text-content-muted text-xs tabular">{p.sku}</span> },
    { key: "units", header: "Units sold", align: "right", numeric: true, sortKey: "units", cell: (p) => p.units },
    { key: "revenue", header: "Revenue", align: "right", numeric: true, sortKey: "revenue", cell: (p) => <Money cents={p.revenueCents} compact /> },
    {
      key: "share",
      header: "Share",
      hideBelow: "sm",
      width: "8rem",
      cell: (p) => <Meter value={p.revenueCents} max={mixTotal || 1} />,
    },
  ];

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Reports &amp; Analytics</h1>
          <p className="text-content-muted text-sm">
            Sales and staff dashboards, territory performance and management KPIs.
          </p>
        </div>
        <div className="flex gap-1.5">
          {[7, 30, 90, 180].map((d) => (
            <a
              key={d}
              href={`/app/reports?days=${d}`}
              className={`badge ${
                days === d ? "bg-accent-subtle text-accent" : "bg-surface-sunken"
              }`}
            >
              {d}d
            </a>
          ))}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Revenue" value={<Money cents={metrics.salesCents} compact />} hint={`${metrics.ordersCount} invoices`} />
        <StatCard label="Collected" value={<Money cents={metrics.collectionsCents} compact />} tone="success" />
        <StatCard
          label="Collection ratio"
          value={`${(grossMargin * 100).toFixed(0)}%`}
          hint="Cash collected against value invoiced"
          tone={grossMargin < 0.7 ? "warning" : "success"}
        />
        <StatCard
          label="Average invoice"
          value={
            <Money
              cents={metrics.ordersCount > 0 ? Math.round(metrics.salesCents / metrics.ordersCount) : 0}
              compact
            />
          }
        />
      </div>

      <div className="rounded-lg border border-border bg-surface p-5 shadow-sm">
        <SectionHeading title="Revenue trend" description="Invoiced value by week" />
        <BarChart data={metrics.weeklySales.map((w) => ({ label: w.label, value: w.cents }))} height={200} />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div>
          <SectionHeading title="Territory performance" description={`${terr.total} territories`} />
          <FilterBar action={PATH} preserve={preserved(params, ["terr_q", "terr_page"])}>
            <FilterSearch name="terr_q" value={params.terr_q} placeholder="Search territory…" />
          </FilterBar>
          <DataTable
            columns={territoryColumns}
            rows={terr.rows}
            getRowKey={(t) => t.id}
            caption="Territory performance"
            dense
            sort={{ key: terrTs.sort, dir: terrTs.dir }}
            sortHrefFor={sortHref(terrTs, "terr")}
            pagination={{ page: terr.page, pages: terr.pages, total: terr.total, limit: terrTs.limit, hrefFor: pageHref("terr") }}
            empty={{ title: params.terr_q ? "No territories match" : "No territories configured" }}
          />
        </div>

        <div>
          <SectionHeading title="Sales channel" description="Where revenue is captured" />
          <div className="rounded-lg border border-border bg-surface p-5 shadow-sm">
            <ul className="space-y-4">
              {channelSplit.map((c) => {
                const total = channelSplit.reduce((s, x) => s + (x._sum.totalCents ?? 0), 0);
                const value = c._sum.totalCents ?? 0;
                return (
                  <li key={c.channel}>
                    <div className="mb-1 flex justify-between text-sm">
                      <span className="capitalize">{c.channel.toLowerCase()}</span>
                      <span>
                        <Money cents={value} compact />
                        <span className="text-content-muted ml-2 text-xs">
                          {total > 0 ? `${((value / total) * 100).toFixed(0)}%` : "0%"}
                        </span>
                      </span>
                    </div>
                    <Meter
                      value={value}
                      max={total || 1}
                      tone={c.channel === "FIELD" ? "accent" : "accent"}
                    />
                  </li>
                );
              })}
            </ul>
            <p className="text-content-muted mt-4 text-xs">
              Field revenue is captured on the mobile app during customer visits.
              A high field share is what justifies the routing and geofencing modules.
            </p>
          </div>
        </div>
      </div>

      <div>
        <SectionHeading title="Staff performance" description={`Field team, last ${days} days`} />
        <FilterBar action={PATH} preserve={preserved(params, ["staff_q", "staff_page"])}>
          <FilterSearch name="staff_q" value={params.staff_q} placeholder="Search rep…" />
        </FilterBar>
        <DataTable
          columns={staffColumns}
          rows={staff.rows}
          getRowKey={(r) => r.repId}
          caption="Staff performance"
          sort={{ key: staffTs.sort, dir: staffTs.dir }}
          sortHrefFor={sortHref(staffTs, "staff")}
          pagination={{ page: staff.page, pages: staff.pages, total: staff.total, limit: staffTs.limit, hrefFor: pageHref("staff") }}
          empty={{ title: params.staff_q ? "No reps match" : "No field reps configured" }}
        />
      </div>

      <div>
        <SectionHeading title="Product mix" description={`Top ${mixRows.length} lines by revenue`} />
        <FilterBar action={PATH} preserve={preserved(params, ["mix_q", "mix_page"])}>
          <FilterSearch name="mix_q" value={params.mix_q} placeholder="Search product, SKU…" />
        </FilterBar>
        <DataTable
          columns={mixColumns}
          rows={mix.rows}
          getRowKey={(p) => p.productId}
          caption="Product mix"
          sort={{ key: mixTs.sort, dir: mixTs.dir }}
          sortHrefFor={sortHref(mixTs, "mix")}
          pagination={{ page: mix.page, pages: mix.pages, total: mix.total, limit: mixTs.limit, hrefFor: pageHref("mix") }}
          empty={{ title: params.mix_q ? "No products match" : "No sales in this period" }}
        />
      </div>
    </div>
  );
}
