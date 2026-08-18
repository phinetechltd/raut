
import {
  BarChart,
  Meter,
  ModuleLocked,
  Money,
  SectionHeading,
  StatCard,
} from "@/components/ui";
import { db } from "@/lib/db";
import { requireTenant } from "@/lib/session";
import { daysAgo, tenantDashboard, territoryPerformance } from "@/server/analytics";
import { repPerformance } from "@/server/field";

export const dynamic = "force-dynamic";

/** Module 10 · Advanced Reporting & Analytics. */
export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  const { companyId, principal } = await requireTenant();
  if (!principal.enabledModules.has("ANALYTICS")) return <ModuleLocked module="ANALYTICS" />;

  const params = await searchParams;
  const days = Math.min(365, Math.max(7, Number(params.days ?? 30) || 30));
  const from = daysAgo(days);

  const [metrics, territories, reps, channelSplit, productMix] = await Promise.all([
    tenantDashboard(companyId, days),
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
      take: 10,
    }),
  ]);

  const products = await db.product.findMany({
    where: { id: { in: productMix.map((p) => p.productId) } },
    select: { id: true, name: true, sku: true },
  });
  const productName = new Map(products.map((p) => [p.id, p]));

  const grossMargin = metrics.salesCents > 0 ? metrics.collectionsCents / metrics.salesCents : 0;

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
          <SectionHeading title="Territory performance" />
          <div className="scroll-x rounded-lg border border-border bg-surface shadow-sm">
            <table className="w-full border-collapse text-base">
              <thead>
                <tr>
                  <th>Territory</th>
                  <th>Customers</th>
                  <th>Invoices</th>
                  <th>Visits</th>
                  <th>Sales</th>
                </tr>
              </thead>
              <tbody>
                {territories.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="text-content-muted py-8 text-center">
                      No territories configured
                    </td>
                  </tr>
                ) : (
                  territories.map((t) => (
                    <tr key={t.id}>
                      <td>
                        <span className="inline-flex items-center gap-2">
                          <span
                            className="h-2 w-2 rounded-full"
                            style={{ background: t.colour }}
                          />
                          <span className="font-medium">{t.name}</span>
                        </span>
                      </td>
                      <td>{t.customers}</td>
                      <td>{t.invoices}</td>
                      <td>{t.visits}</td>
                      <td className="font-medium">
                        <Money cents={t.salesCents} compact />
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
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
        <div className="scroll-x rounded-lg border border-border bg-surface shadow-sm">
          <table className="w-full border-collapse text-base">
            <thead>
              <tr>
                <th>Rep</th>
                <th>Visits planned</th>
                <th>Completed</th>
                <th>Completion</th>
                <th>Verified</th>
                <th>Verification</th>
                <th>Orders</th>
                <th>Sales</th>
                <th>Collections</th>
              </tr>
            </thead>
            <tbody>
              {reps.length === 0 ? (
                <tr>
                  <td colSpan={9} className="text-content-muted py-8 text-center">
                    No field reps configured
                  </td>
                </tr>
              ) : (
                reps.map((r) => (
                  <tr key={r.repId}>
                    <td className="font-medium">{r.repName}</td>
                    <td>{r.visitsPlanned}</td>
                    <td>{r.visitsCompleted}</td>
                    <td className={r.completionRate < 0.7 ? "text-warning" : ""}>
                      {(r.completionRate * 100).toFixed(0)}%
                    </td>
                    <td>{r.visitsVerified}</td>
                    <td className={r.verificationRate < 0.8 ? "text-warning" : ""}>
                      {(r.verificationRate * 100).toFixed(0)}%
                    </td>
                    <td>{r.ordersCount}</td>
                    <td>
                      <Money cents={r.salesCents} compact />
                    </td>
                    <td>
                      <Money cents={r.collectionsCents} compact />
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div>
        <SectionHeading title="Product mix" description="Top lines by revenue" />
        <div className="scroll-x rounded-lg border border-border bg-surface shadow-sm">
          <table className="w-full border-collapse text-base">
            <thead>
              <tr>
                <th>Product</th>
                <th>SKU</th>
                <th>Units sold</th>
                <th>Revenue</th>
                <th>Share</th>
              </tr>
            </thead>
            <tbody>
              {productMix.map((p) => {
                const total = productMix.reduce((s, x) => s + (x._sum.lineTotalCents ?? 0), 0);
                const value = p._sum.lineTotalCents ?? 0;
                return (
                  <tr key={p.productId}>
                    <td className="font-medium">
                      {productName.get(p.productId)?.name ?? "Unknown"}
                    </td>
                    <td className="text-content-muted text-xs">
                      {productName.get(p.productId)?.sku ?? "—"}
                    </td>
                    <td>{p._sum.quantity ?? 0}</td>
                    <td>
                      <Money cents={value} compact />
                    </td>
                    <td className="w-32">
                      <Meter value={value} max={total || 1} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

