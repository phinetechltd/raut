import Link from "next/link";

import {
  ButtonLink,
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
import { stockLevels, type StockLevelRow } from "@/server/inventory";

import { ProductDialog, type ProductShape } from "./product-dialog";
import { RepackDialog } from "./repack-dialog";
import { StockAdjustDialog } from "./stock-dialog";

export const dynamic = "force-dynamic";

const SORT_COLUMNS: Record<string, string> = {
  name: "name",
  sku: "sku",
  sell: "sellPriceCents",
  cost: "costPriceCents",
  reorder: "reorderLevel",
};

const STOCK_SORT: Record<string, (r: StockLevelRow) => string | number> = {
  name: (r) => r.name.toLowerCase(),
  sku: (r) => r.sku.toLowerCase(),
  unit: (r) => r.unit.toLowerCase(),
  onhand: (r) => r.totalQuantity,
  reorder: (r) => r.reorderLevel,
  status: (r) => (r.belowReorder ? 0 : 1),
};

const MOVEMENT_SORT: Record<string, string> = {
  when: "createdAt",
  type: "type",
  quantity: "quantity",
  balance: "balanceAfter",
};

/** Every movement type with the label the filter shows for it. */
const MOVEMENT_TYPE_LABELS: Record<string, string> = {
  PURCHASE: "purchase",
  SALE: "sale",
  TRANSFER_IN: "transfer in",
  TRANSFER_OUT: "transfer out",
  ADJUSTMENT: "adjustment",
  RETURN: "return",
  OPENING: "opening",
  WRITE_OFF: "write-off",
  REPACK_OUT: "split out",
  REPACK_IN: "split in",
};
const MOVEMENT_TYPES = Object.keys(MOVEMENT_TYPE_LABELS);

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

  const stkTs = tableState(params, {
    prefix: "stk",
    allowed: Object.keys(STOCK_SORT),
    defaultSort: "name",
    defaultDir: "asc",
    limit: 15,
  });
  const movTs = tableState(params, {
    prefix: "mov",
    allowed: Object.keys(MOVEMENT_SORT),
    defaultSort: "when",
    defaultDir: "desc",
    limit: 15,
  });

  const canWrite = can(principal, "product:write");
  const canStock = can(principal, "stock:write");

  const movementWhere = {
    companyId,
    ...(filters.mov_type && MOVEMENT_TYPES.includes(filters.mov_type) ? { type: filters.mov_type } : {}),
    ...(filters.mov_q
      ? {
          OR: [
            { product: { name: { contains: filters.mov_q } } },
            { product: { sku: { contains: filters.mov_q } } },
            { refType: { contains: filters.mov_q } },
            { note: { contains: filters.mov_q } },
          ],
        }
      : {}),
  };

  const where = {
    companyId,
    ...(filters.q
      ? { OR: [{ name: { contains: filters.q } }, { sku: { contains: filters.q } }, { barcode: { contains: filters.q } }] }
      : {}),
    ...(filters.cat ? { categoryId: filters.cat } : {}),
    ...(filters.inactive === "true" ? {} : { active: true }),
  };

  const [products, productCount, categories, locations, allLevels, movements, movementCount, valuation] =
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
        search: filters.stk_q,
      }),
      db.stockMovement.findMany({
        where: movementWhere,
        include: {
          product: { select: { name: true, sku: true } },
          location: { select: { name: true } },
        },
        orderBy: { [MOVEMENT_SORT[movTs.sort ?? "when"]]: movTs.dir } as Record<string, "asc" | "desc">,
        take: movTs.limit,
        skip: (movTs.page - 1) * movTs.limit,
      }),
      db.stockMovement.count({ where: movementWhere }),
      db.stockItem.findMany({
        where: { companyId },
        include: { product: { select: { costPriceCents: true } } },
      }),
    ]);

  const stockValueCents = valuation.reduce(
    (sum, s) => sum + s.quantity * s.product.costPriceCents,
    0,
  );
  const lowCount = allLevels.filter((l) => l.belowReorder).length;

  // stockLevels() computes its rows (totals across locations), so the order
  // and the page are applied here rather than in SQL.
  const stockValue = STOCK_SORT[stkTs.sort ?? "name"];
  const sortedLevels = [...allLevels].sort((a, b) => {
    const av = stockValue(a);
    const bv = stockValue(b);
    const cmp = typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv));
    return stkTs.dir === "asc" ? cmp : -cmp;
  });
  const stockPages = Math.max(1, Math.ceil(sortedLevels.length / stkTs.limit));
  const stockPage = Math.min(stkTs.page, stockPages);
  const levels = sortedLevels.slice((stockPage - 1) * stkTs.limit, stockPage * stkTs.limit);

  const sortHrefFor = (key: string) => {
    const next = toggleSort(ts, key);
    return tableHref("/app/inventory", params, { prod_sort: next.sort, prod_dir: next.dir }, "prod");
  };
  const stkSortHrefFor = (key: string) => {
    const next = toggleSort(stkTs, key);
    return tableHref("/app/inventory", params, { stk_sort: next.sort, stk_dir: next.dir }, "stk");
  };
  const movSortHrefFor = (key: string) => {
    const next = toggleSort(movTs, key);
    return tableHref("/app/inventory", params, { mov_sort: next.sort, mov_dir: next.dir }, "mov");
  };

  const stockColumns: Array<Column<StockLevelRow>> = [
    {
      key: "name",
      header: "Product",
      sortKey: "name",
      cell: (l) => <span className="font-medium">{l.name}</span>,
    },
    {
      key: "sku",
      header: "SKU",
      sortKey: "sku",
      hideBelow: "sm",
      cell: (l) => <span className="text-content-muted text-xs tabular">{l.sku}</span>,
    },
    {
      key: "unit",
      header: "Unit",
      sortKey: "unit",
      hideBelow: "md",
      cell: (l) => <span className="text-content-muted text-xs">{l.unit}</span>,
    },
    {
      key: "onhand",
      header: "On hand",
      align: "right",
      numeric: true,
      sortKey: "onhand",
      cell: (l) => (
        <span className={l.belowReorder ? "font-semibold text-warning" : "font-medium"}>{l.totalQuantity}</span>
      ),
    },
    {
      key: "reorder",
      header: "Reorder at",
      align: "right",
      numeric: true,
      sortKey: "reorder",
      hideBelow: "md",
      cell: (l) => <span className="text-content-muted text-xs">{l.reorderLevel || "—"}</span>,
    },
    {
      key: "locations",
      header: "By location",
      hideBelow: "lg",
      cell: (l) => (
        <span className="text-content-muted text-xs">
          {l.byLocation
            .filter((b) => b.quantity !== 0)
            .map((b) => `${b.locationName}: ${b.quantity}`)
            .join(" · ") || "—"}
        </span>
      ),
    },
    {
      key: "status",
      header: "Status",
      align: "right",
      sortKey: "status",
      cell: (l) =>
        l.belowReorder ? (
          <span className="badge bg-warning-bg text-warning border-warning-border">reorder</span>
        ) : (
          <span className="badge bg-success-bg text-success border-success-border">ok</span>
        ),
    },
  ];

  type MovementRow = (typeof movements)[number];
  const movementColumns: Array<Column<MovementRow>> = [
    {
      key: "when",
      header: "When",
      sortKey: "when",
      cell: (m) => (
        <span className="text-content-muted text-xs">{m.createdAt.toLocaleDateString("en-KE")}</span>
      ),
    },
    {
      key: "product",
      header: "Product",
      cell: (m) => <CellStack primary={m.product.name} secondary={m.product.sku} />,
    },
    {
      key: "location",
      header: "Location",
      hideBelow: "sm",
      cell: (m) => <span className="text-xs">{m.location.name}</span>,
    },
    { key: "type", header: "Type", sortKey: "type", cell: (m) => <StatusBadge status={m.type} /> },
    {
      key: "quantity",
      header: "Quantity",
      align: "right",
      numeric: true,
      sortKey: "quantity",
      cell: (m) => (
        <span className={m.quantity < 0 ? "text-danger" : "text-accent"}>
          {m.quantity > 0 ? "+" : ""}
          {m.quantity}
        </span>
      ),
    },
    {
      key: "balance",
      header: "Balance after",
      align: "right",
      numeric: true,
      sortKey: "balance",
      hideBelow: "md",
      cell: (m) => <span className="text-content-muted text-xs">{m.balanceAfter}</span>,
    },
    {
      key: "reference",
      header: "Reference",
      hideBelow: "lg",
      cell: (m) => (
        <span className="text-content-muted text-xs">{m.refType ? `${m.refType}` : (m.note ?? "—")}</span>
      ),
    },
  ];

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
            <ButtonLink href="/app/inventory/transfers" variant="secondary" size="sm">
              Transfers
            </ButtonLink>
            {canStock && locations.length > 0 ? (
              <RepackDialog locations={locations.map((l) => ({ id: l.id, name: l.name }))} />
            ) : null}
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
              href={tableHref("/app/inventory", params, { location: l.id, stk_page: null })}
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
          description={
            filters.low === "true"
              ? `Showing low stock only · ${sortedLevels.length} products`
              : `${sortedLevels.length} products`
          }
          actions={
            <Link
              href={tableHref("/app/inventory", params, {
                low: filters.low === "true" ? null : "true",
                stk_page: null,
              })}
              className="inline-flex h-8 items-center justify-center rounded-md border border-border px-3 text-xs font-medium hover:bg-surface-hover"
            >
              {filters.low === "true" ? "Show all" : "Show low stock only"}
            </Link>
          }
        />
        <FilterBar action="/app/inventory" preserve={preserved(params, ["stk_q", "stk_page"])}>
          <FilterSearch name="stk_q" value={filters.stk_q} placeholder="Search product, SKU…" />
        </FilterBar>
        <DataTable
          columns={stockColumns}
          rows={levels}
          getRowKey={(l) => l.productId}
          caption="Stock levels"
          sort={{ key: stkTs.sort, dir: stkTs.dir }}
          sortHrefFor={stkSortHrefFor}
          pagination={{
            page: stockPage,
            pages: stockPages,
            total: sortedLevels.length,
            limit: stkTs.limit,
            hrefFor: (pg) => tableHref("/app/inventory", params, { stk_page: pg }),
          }}
          empty={{ title: "No stock lines match this filter" }}
        />
      </div>

      <div>
        <SectionHeading
          title="Recent stock movements"
          description="Every balance change is ledgered — balances are derived, never edited directly"
        />
        <FilterBar action="/app/inventory" preserve={preserved(params, ["mov_q", "mov_type", "mov_page"])}>
          <FilterSearch name="mov_q" value={filters.mov_q} placeholder="Search product, SKU, reference…" />
          <FilterSelect
            name="mov_type"
            value={filters.mov_type}
            allLabel="All types"
            options={MOVEMENT_TYPES.map((t) => ({ value: t, label: MOVEMENT_TYPE_LABELS[t]! }))}
          />
        </FilterBar>
        <DataTable
          columns={movementColumns}
          rows={movements}
          getRowKey={(m) => m.id}
          caption="Stock movements"
          sort={{ key: movTs.sort, dir: movTs.dir }}
          sortHrefFor={movSortHrefFor}
          pagination={{
            page: movTs.page,
            pages: Math.max(1, Math.ceil(movementCount / movTs.limit)),
            total: movementCount,
            limit: movTs.limit,
            hrefFor: (pg) => tableHref("/app/inventory", params, { mov_page: pg }),
          }}
          empty={{ title: filters.mov_q || filters.mov_type ? "No movements match this filter" : "No movements yet" }}
        />
      </div>
    </div>
  );
}
