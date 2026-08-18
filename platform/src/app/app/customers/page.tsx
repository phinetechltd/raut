import Link from "next/link";

import {
  GeoMap,
  ModuleLocked,
  Money,
  SectionHeading,
  StatCard,
  StatusBadge,
} from "@/components/ui";
import { db } from "@/lib/db";
import { parseBoundary } from "@/lib/geo";
import { requireTenant } from "@/lib/session";

export const dynamic = "force-dynamic";

/** Module 01 · CRM — the customer list from proposal page 7. */
export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; territory?: string; status?: string }>;
}) {
  const { companyId, principal } = await requireTenant();
  if (!principal.enabledModules.has("CRM")) return <ModuleLocked module="CRM" />;

  const filters = await searchParams;

  const where = {
    companyId,
    ...(principal.role === "FIELD_REP" ? { assignedRepId: principal.userId } : {}),
    ...(filters.q
      ? {
          OR: [
            { name: { contains: filters.q } },
            { code: { contains: filters.q } },
            { phone: { contains: filters.q } },
            { town: { contains: filters.q } },
          ],
        }
      : {}),
    ...(filters.territory ? { territoryId: filters.territory } : {}),
    ...(filters.status ? { status: filters.status } : {}),
  };

  const [customers, territories, totals] = await Promise.all([
    db.customer.findMany({
      where,
      include: {
        territory: { select: { id: true, name: true, colour: true } },
        assignedRep: { select: { name: true } },
      },
      orderBy: { name: "asc" },
      take: 200,
    }),
    db.territory.findMany({
      where: { companyId, active: true },
      include: { _count: { select: { customers: true } } },
      orderBy: { name: "asc" },
    }),
    db.customer.aggregate({
      where: { companyId },
      _sum: { balanceCents: true },
      _count: true,
    }),
  ]);

  const mapped = customers.filter((c) => c.latitude != null && c.longitude != null);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Customers</h1>
        <p className="text-content-muted text-sm">
          Advanced profiles, segmentation, territories and GPS pins.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Customers" value={String(totals._count)} />
        <StatCard
          label="Total balance"
          value={<Money cents={totals._sum.balanceCents ?? 0} compact />}
          hint="Outstanding across all accounts"
        />
        <StatCard label="Territories" value={String(territories.length)} />
        <StatCard
          label="GPS pins captured"
          value={`${mapped.length} / ${customers.length}`}
          hint="Required for routing and geofencing"
          tone={mapped.length < customers.length ? "warning" : "success"}
        />
      </div>

      <div>
        <SectionHeading
          title="Customer locations"
          description="Pins and territory fences, drawn from stored coordinates"
        />
        <GeoMap
          points={mapped.map((c) => ({
            id: c.id,
            lat: c.latitude!,
            lng: c.longitude!,
            label: c.name,
            tone:
              c.status !== "ACTIVE" ? "danger" : c.balanceCents > 0 ? "warning" : "success",
          }))}
          polygons={territories
            .map((t) => ({
              id: t.id,
              colour: t.colour,
              vertices: parseBoundary(t.boundary).map(
                (v) => [v.lat, v.lng] as [number, number],
              ),
            }))
            .filter((p) => p.vertices.length >= 3)}
          height={400}
        />
      </div>

      <div>
        <SectionHeading title="Territories" />
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {territories.map((t) => (
            <Link
              key={t.id}
              href={`/app/customers?territory=${t.id}`}
              className="rounded-lg border border-border bg-surface shadow-sm p-4 transition-colors hover:border-brand-500"
            >
              <div className="flex items-center gap-2">
                <span
                  className="h-2.5 w-2.5 rounded-full"
                  style={{ background: t.colour }}
                />
                <p className="text-sm font-medium">{t.name}</p>
              </div>
              <p className="text-content-muted mt-1 text-xs">
                {t._count.customers} customers ·{" "}
                {parseBoundary(t.boundary).length >= 3
                  ? "polygon fence"
                  : `${(t.radiusM / 1000).toFixed(0)}km radius`}
              </p>
            </Link>
          ))}
        </div>
      </div>

      <div>
        <SectionHeading
          title="All customers"
          description={`${customers.length} shown`}
          actions={
            <form className="flex gap-2">
              <input
                name="q"
                defaultValue={filters.q ?? ""}
                className="input w-56"
                placeholder="Search customers, territories…"
              />
              <button className="inline-flex items-center justify-center rounded border border-border px-3 py-1.5 hover:bg-surface-hover text-xs" type="submit">
                Search
              </button>
            </form>
          }
        />
        <div className="scroll-x rounded-lg border border-border bg-surface shadow-sm">
          <table className="w-full border-collapse text-base">
            <thead>
              <tr>
                <th>Customer</th>
                <th>Territory</th>
                <th>Rep</th>
                <th>Segment</th>
                <th>Terms</th>
                <th>Balance</th>
                <th>Status</th>
                <th>Pin</th>
              </tr>
            </thead>
            <tbody>
              {customers.length === 0 ? (
                <tr>
                  <td colSpan={8} className="text-content-muted py-10 text-center">
                    No customers match this filter
                  </td>
                </tr>
              ) : (
                customers.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <Link
                        href={`/app/customers/${c.id}`}
                        className="font-medium hover:text-accent"
                      >
                        {c.name}
                      </Link>
                      <span className="text-content-muted block text-xs">
                        {c.code} · {c.town ?? "—"}
                      </span>
                    </td>
                    <td>
                      {c.territory ? (
                        <span className="inline-flex items-center gap-1.5 text-xs">
                          <span
                            className="h-2 w-2 rounded-full"
                            style={{ background: c.territory.colour }}
                          />
                          {c.territory.name}
                        </span>
                      ) : (
                        <span className="text-content-muted text-xs">Unassigned</span>
                      )}
                    </td>
                    <td className="text-xs">{c.assignedRep?.name ?? "—"}</td>
                    <td>
                      <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium bg-surface-sunken">{c.segment}</span>
                    </td>
                    <td className="text-content-muted text-xs">
                      {c.paymentTermsDays > 0 ? `${c.paymentTermsDays}d` : "Cash"}
                    </td>
                    <td className={c.balanceCents > 0 ? "font-medium text-warning" : "muted"}>
                      <Money cents={c.balanceCents} />
                    </td>
                    <td>
                      <StatusBadge status={c.status} />
                    </td>
                    <td>
                      {c.latitude != null ? (
                        <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium bg-success-bg text-success">mapped</span>
                      ) : (
                        <span className="text-content-muted text-xs">none</span>
                      )}
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

