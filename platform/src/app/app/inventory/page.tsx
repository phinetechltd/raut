import Link from "next/link";

import {
  CellStack,
  DataTable,
  FilterBar,
  FilterSearch,
  FilterSelect,
  ModuleLocked,
  Money,
  PageHeader,
  SectionHeading,
  StatCard,
  StatGrid,
  StatusBadge,
  type Column,
} from "@/components/ui";
import { db } from "@/lib/db";
import { can } from "@/lib/rbac";
import { requireTenant } from "@/lib/session";
import { preserved, tableHref, tableState, toggleSort } from "@/lib/table";
import { stockLevels } from "@/server/inventory";

import { ProductDialog, type ProductShape } from "./product-dialog";
import { StockAdjustDialog } from "./stock-dialog";

export const dynamic = "force-dynamic";

const SORT_COLUMNS: Record<string, string> = {
  name: "name",
  sku: "sku",
  sell: "sellPriceCents",
  cost: "costPriceCents",
  reorder: "reorderLevel",
};

/** Module 03 · Inventory — catalogue, multi-location stock, low-stock alerts. */
export default async function InventoryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { companyId, principal } = await requireTenant();
  if (!principal.enabledModules.has("INVENTORY")) return <ModuleLocked module="INVENTORY" />;

  const params = await searchParams;
  const filters = params;

  const ts = tableState(params, {
    prefix: "prod",
    allowed: ["name", "sku", "sell", "cost", "reorder"],
    defaultSort: "name",
    defaultDir: "asc",
    limit: 15,
  });

  const canWrite = can(principal, "product:write");
  const canStock = can(principal, "stock:write");

  const where = {
    companyId,
    ...(filters.q
      ? { OR: [{ name: { contains: filters.q } }, { sku: { contains: filters.q } }, { barcode: { contains: filters.q } }] }
      : {}),
    ...(filters.cat ? { categoryId: filters.cat } : {}),
    ...(filters.inactive === "true" ? {} : { active: true }),
  };

  const [products, productCount, categories, locations, levels, movements, valuation] =
    await Promise.all([
      db.product.findMany({
        where,
        include: { category: { select: { id: true, name: true } }, stockItems: { select: { quantity: true } } },
        orderBy: ts.sort ? ({ [SORT_COLUMNS[ts.sort]]: ts.dir } as Record<string, "asc" | "desc">) : { name: "asc" },
        take: ts.limit,
        skip: (ts.page - 1) * ts.limit,
      }),
      db.product.count({ where }),
      db.productCategory.findMany({ where: { companyId }, orderBy: { name: "asc" } }),
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

  const sortHrefFor = (key: string) => {
    const next = toggleSort(ts, key);
    return tableHref("/app/inventory", params, { prod_sort: next.sort, prod_dir: next.dir }, "prod");
  };

  type Row = (typeof products)[number];
  const columns: Array<Column<Row>> = [
    {
      key: "name",
      header: "Product",
      sortKey: "name",
      cell: (p) => (
        <CellStack
          primary={<span className="font-medium">{p.name}</span>}
          secondary={p.description ?? ""}
        />
      ),
    },
    {
      key: "sku",
      header: "SKU",
      sortKey: "sku",
      hideBelow: "sm",
      cell: (p) => <span className="text-content-muted text-xs tabular">{p.sku}</span>,
    },
    {
      key: "category",
      header: "Category",
      hideBelow: "md",
      cell: (p) => <span className="text-xs">{p.category?.name ?? "—"}</span>,
    },
    {
      key: "sell",
      header: "Sell",
      align: "right",
      numeric: true,
      sortKey: "sell",
      cell: (p) => <Money cents={p.sellPriceCents} />,
    },
    {
      key: "stock",
      header: "On hand",
      align: "right",
      numeric: true,
      cell: (p) => {
        const onHand = p.trackStock ? p.stockItems.reduce((s, i) => s + i.quantity, 0) : null;
        return onHand == null ? (
          <span className="text-content-muted text-xs">not tracked</span>
        ) : (
          <span className={onHand <= p.reorderLevel ? "font-semibold text-warning" : "tabular"}>
            {onHand}
          </span>
        );
      },
    },
    {
      key: "reorder",
      header: "Reorder at",
      align: "right",
      numeric: true,
      hideBelow: "md",
      sortKey: "reorder",
      cell: (p) => <span className="text-content-muted text-xs">{p.reorderLevel || "—"}</span>,
    },
    {
      key: "status",
      header: "Status",
      cell: (p) =>
        p.active ? (
          <span className="badge bg-success-bg text-success border-success-border">active</span>
        ) : (
          <span className="badge bg-surface-sunken">retired</span>
        ),
    },
    ...(can(principal, "product:write")
      ? [
          {
            key: "edit",
            header: "",
            srOnlyHeader: true,
            cell: (p: Row) => (
              <ProductDialog mode="edit" product={p as unknown as ProductShape} categories={categories} />
            ),
          } satisfies Column<Row>,
        ]
      : []),
  ];

  return (
    <div className="space-y-8">
      <PageHeader
        title="Inventory"
        description="Product catalogue, stock across locations, and reorder alerts."
        actions={
          <>
            {canStock && locations.length > 0 && products.length > 0 ? (
              <StockAdjustDialog
                products={products.map((p) => ({ id: p.id, name: p.name }))}
                locations={locations.map((l) => ({ id: l.id, name: l.name }))}
              />
            ) : null}
            {canWrite ? <ProductDialog mode="create" categories={categories} buttonVariant="primary" /> : null}
          </>
        }
      />

      <StatGrid>
        <StatCard label="Products tracked" value={String(productCount)} />
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
      </StatGrid>

      <div>
        <SectionHeading title="Stock locations" />
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Link
            href="/app/inventory"
            className={`card p-4 transition-[border-color,box-shadow] hover:border-border-strong hover:shadow-md ${!filters.location ? "border-accent" : ""}`}
          >
            <p className="text-sm font-medium">All locations</p>
            <p className="text-content-muted mt-1 text-xs">Combined view</p>
          </Link>
          {locations.map((l) => (
            <Link
              key={l.id}
              href={tableHref("/app/inventory", params, { location: l.id })}
              className={`card p-4 transition-[border-color,box-shadow] hover:border-border-strong hover:shadow-md ${filters.location === l.id ? "border-accent" : ""}`}
            >
              <p className="truncate text-sm font-medium">{l.name}</p>
              <p className="text-content-muted mt-1 text-xs">
                <span className="badge bg-surface-sunken">{l.type.toLowerCase()}</span>{" "}
                {l._count.stockItems} lines
              </p>
            </Link>
          ))}
        </div>
      </div>

      <div>
        <SectionHeading
          title="Product catalogue"
          description={`${productCount.toLocaleString("en-KE")} products`}
        />
        <FilterBar action="/app/inventory" preserve={preserved(params, ["q", "cat", "inactive", "prod_page"])}>
          <FilterSearch name="q" value={filters.q} placeholder="Search name, SKU, barcode…" />
          <FilterSelect name="cat" value={filters.cat} allLabel="All categories" options={categories.map((c) => ({ value: c.id, label: c.name }))} />
          <label className="flex h-8 items-center gap-2 rounded-md border border-border bg-surface px-3 text-sm">
            <input type="checkbox" name="inactive" value="true" defaultChecked={filters.inactive === "true"} />
            Show retired
          </label>
        </FilterBar>

        <DataTable
          columns={columns}
          rows={products}
          getRowKey={(p) => p.id}
          caption="Product catalogue"
          sort={{ key: ts.sort, dir: ts.dir }}
          sortHrefFor={sortHrefFor}
          pagination={{
            page: ts.page,
            pages: Math.max(1, Math.ceil(productCount / ts.limit)),
            total: productCount,
            limit: ts.limit,
            hrefFor: (pg) => tableHref("/app/inventory", params, { prod_page: pg }),
          }}
          empty={{
            title: "No products match",
            description: filters.q || filters.cat ? "Adjust the filters." : undefined,
            action: canWrite ? <ProductDialog mode="create" categories={categories} buttonVariant="primary" /> : undefined,
          }}
        />
      </div>

      <div>
        <SectionHeading
          title="Stock levels"
          description={filters.low === "true" ? "Showing low stock only" : `${levels.length} products`}
          actions={
            <Link
              href={tableHref("/app/inventory", params, { low: filters.low === "true" ? null : "true" })}
              className="inline-flex h-8 items-center justify-center rounded-md border border-border px-3 text-xs font-medium hover:bg-surface-hover"
            >
              {filters.low === "true" ? "Show all" : "Show low stock only"}
            </Link>
          }
        />
        <Card nopad>
          <div className="scroll-x">
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
                      <td className="text-content-muted text-xs">{l.reorderLevel || "—"}</td>
                      <td className="text-content-muted text-xs">
                        {l.byLocation
                          .filter((b) => b.quantity !== 0)
                          .map((b) => `${b.locationName}: ${b.quantity}`)
                          .join(" · ") || "—"}
                      </td>
                      <td>
                        {l.belowReorder ? (
                          <span className="badge bg-warning-bg text-warning border-warning-border">reorder</span>
                        ) : (
                          <span className="badge bg-success-bg text-success border-success-border">ok</span>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      <div>
        <SectionHeading
          title="Recent stock movements"
          description="Every balance change is ledgered — balances are derived, never edited directly"
        />
        <Card nopad>
          <div className="scroll-x">
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
                {movements.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="text-content-muted py-10 text-center">
                      No movements yet
                    </td>
                  </tr>
                ) : (
                  movements.map((m) => (
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
                      <td className="text-content-muted text-xs">{m.balanceAfter}</td>
                      <td className="text-content-muted text-xs">
                        {m.refType ? `${m.refType}` : (m.note ?? "—")}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </div>
  );
}

/** Local Card variant without padding, used for flush tables. */
function Card({ children, nopad }: { children: React.ReactNode; nopad?: boolean }) {
  return (
    <div className={`rounded-xl border border-border bg-surface shadow-sm ${nopad ? "" : "p-5"}`}>
      {children}
    </div>
  );
}
