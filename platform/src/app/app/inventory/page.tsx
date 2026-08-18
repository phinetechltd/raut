
import {
  ModuleLocked,
  Money,
  SectionHeading,
  StatCard,
  StatusBadge,
} from "@/components/ui";
import { db } from "@/lib/db";
import { requireTenant } from "@/lib/session";
import { stockLevels } from "@/server/inventory";

export const dynamic = "force-dynamic";

/** Module 03 · Inventory — catalogue, multi-location stock, low-stock alerts. */
export default async function InventoryPage({
  searchParams,
}: {
  searchParams: Promise<{ location?: string; low?: string }>;
}) {
  const { companyId, principal } = await requireTenant();
  if (!principal.enabledModules.has("INVENTORY")) return <ModuleLocked module="INVENTORY" />;

  const filters = await searchParams;

  const [locations, levels, movements, valuation] = await Promise.all([
    db.stockLocation.findMany({
      where: { companyId, active: true },
      include: { _count: { select: { stockItems: true } } },
      orderBy: { name: "asc" },
    }),
    stockLevels(companyId, {
      locationId: filters.location,
      lowOnly: filters.low === "true",
    }),
    db.stockMovement.findMany({
      where: { companyId },
      include: {
        product: { select: { name: true, sku: true } },
        location: { select: { name: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 25,
    }),
    db.stockItem.findMany({
      where: { companyId },
      include: { product: { select: { costPriceCents: true } } },
    }),
  ]);

  const stockValueCents = valuation.reduce(
    (sum, s) => sum + s.quantity * s.product.costPriceCents,
    0,
  );
  const lowCount = levels.filter((l) => l.belowReorder).length;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Inventory</h1>
        <p className="text-content-muted text-sm">
          Product catalogue, stock across locations, and reorder alerts.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Products tracked" value={String(levels.length)} />
        <StatCard
          label="Stock value at cost"
          value={<Money cents={stockValueCents} compact />}
        />
        <StatCard label="Locations" value={String(locations.length)} hint="Stores and vans" />
        <StatCard
          label="Below reorder level"
          value={String(lowCount)}
          hint={lowCount > 0 ? "Needs replenishment" : "All lines healthy"}
          tone={lowCount > 0 ? "warning" : "success"}
        />
      </div>

      <div>
        <SectionHeading title="Stock locations" />
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <a
            href="/app/inventory"
            className={`card p-4 transition-colors hover:border-brand-500 ${
              !filters.location ? "border-brand-500" : ""
            }`}
          >
            <p className="text-sm font-medium">All locations</p>
            <p className="text-content-muted mt-1 text-xs">Combined view</p>
          </a>
          {locations.map((l) => (
            <a
              key={l.id}
              href={`/app/inventory?location=${l.id}`}
              className={`card p-4 transition-colors hover:border-brand-500 ${
                filters.location === l.id ? "border-brand-500" : ""
              }`}
            >
              <p className="truncate text-sm font-medium">{l.name}</p>
              <p className="text-content-muted mt-1 text-xs">
                <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium bg-surface-sunken">
                  {l.type.toLowerCase()}
                </span>{" "}
                {l._count.stockItems} lines
              </p>
            </a>
          ))}
        </div>
      </div>

      <div>
        <SectionHeading
          title="Stock levels"
          description={filters.low === "true" ? "Showing low stock only" : `${levels.length} products`}
          actions={
            <a
              href={`/app/inventory?${filters.location ? `location=${filters.location}&` : ""}${
                filters.low === "true" ? "" : "low=true"
              }`}
              className="inline-flex items-center justify-center rounded border border-border px-3 py-1.5 hover:bg-surface-hover text-xs"
            >
              {filters.low === "true" ? "Show all" : "Show low stock only"}
            </a>
          }
        />
        <div className="scroll-x rounded-lg border border-border bg-surface shadow-sm">
          <table className="w-full border-collapse text-base">
            <thead>
              <tr>
                <th>Product</th>
                <th>SKU</th>
                <th>Unit</th>
                <th>On hand</th>
                <th>Reorder at</th>
                <th>By location</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {levels.length === 0 ? (
                <tr>
                  <td colSpan={7} className="text-content-muted py-10 text-center">
                    No stock lines match this filter
                  </td>
                </tr>
              ) : (
                levels.map((l) => (
                  <tr key={l.productId}>
                    <td className="font-medium">{l.name}</td>
                    <td className="text-content-muted text-xs">{l.sku}</td>
                    <td className="text-content-muted text-xs">{l.unit}</td>
                    <td className={l.belowReorder ? "font-semibold text-warning" : "font-medium"}>
                      {l.totalQuantity}
                    </td>
                    <td className="text-content-text-content-muted">{l.reorderLevel || "—"}</td>
                    <td className="text-content-muted text-xs">
                      {l.byLocation
                        .filter((b) => b.quantity !== 0)
                        .map((b) => `${b.locationName}: ${b.quantity}`)
                        .join(" · ") || "—"}
                    </td>
                    <td>
                      {l.belowReorder ? (
                        <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium bg-warning-bg text-warninging">reorder</span>
                      ) : (
                        <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium bg-success-bg text-success">ok</span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div>
        <SectionHeading
          title="Recent stock movements"
          description="Every balance change is ledgered — balances are derived, never edited directly"
        />
        <div className="scroll-x rounded-lg border border-border bg-surface shadow-sm">
          <table className="w-full border-collapse text-base">
            <thead>
              <tr>
                <th>When</th>
                <th>Product</th>
                <th>Location</th>
                <th>Type</th>
                <th>Quantity</th>
                <th>Balance after</th>
                <th>Reference</th>
              </tr>
            </thead>
            <tbody>
              {movements.map((m) => (
                <tr key={m.id}>
                  <td className="text-content-muted text-xs">
                    {m.createdAt.toLocaleDateString("en-KE")}
                  </td>
                  <td>
                    {m.product.name}
                    <span className="text-content-muted block text-xs">{m.product.sku}</span>
                  </td>
                  <td className="text-xs">{m.location.name}</td>
                  <td>
                    <StatusBadge status={m.type} />
                  </td>
                  <td className={m.quantity < 0 ? "text-danger" : "text-accent"}>
                    {m.quantity > 0 ? "+" : ""}
                    {m.quantity}
                  </td>
                  <td className="text-content-text-content-muted">{m.balanceAfter}</td>
                  <td className="text-content-muted text-xs">
                    {m.refType ? `${m.refType}` : (m.note ?? "—")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

