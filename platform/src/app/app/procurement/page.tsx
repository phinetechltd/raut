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

import { PurchaseOrderDialog } from "./po-dialog";
import { SupplierDialog, type SupplierShape } from "./supplier-dialog";

export const dynamic = "force-dynamic";

const SUP_SORT: Record<string, string> = {
  name: "name",
  balance: "balanceCents",
  terms: "paymentTermsDays",
  status: "status",
};
const PO_SORT: Record<string, string> = {
  date: "orderDate",
  number: "number",
  total: "totalCents",
  status: "status",
  expected: "expectedAt",
};
const GRN_SORT: Record<string, string> = { received: "receivedAt", number: "number", status: "status" };

const PO_STATUSES = [
  { value: "DRAFT", label: "Draft" },
  { value: "SENT", label: "Sent" },
  { value: "PARTIALLY_RECEIVED", label: "Partially received" },
  { value: "RECEIVED", label: "Received" },
  { value: "CANCELLED", label: "Cancelled" },
];

/** Module 04 · Procurement & Suppliers. */
export default async function ProcurementPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { companyId, principal } = await requireTenant();
  if (!principal.enabledModules.has("PROCUREMENT")) {
    return <ModuleLocked module="PROCUREMENT" />;
  }

  const params = await searchParams;

  const supTs = tableState(params, {
    prefix: "sup",
    allowed: Object.keys(SUP_SORT),
    defaultSort: "name",
    defaultDir: "asc",
    limit: 10,
  });
  const poTs = tableState(params, {
    prefix: "po",
    allowed: Object.keys(PO_SORT),
    defaultSort: "date",
    defaultDir: "desc",
    limit: 10,
  });
  const grnTs = tableState(params, {
    prefix: "grn",
    allowed: Object.keys(GRN_SORT),
    defaultSort: "received",
    defaultDir: "desc",
    limit: 10,
  });

  const canSupplierWrite = can(principal, "supplier:write");
  const canPurchaseWrite = can(principal, "purchase:write");

  const supplierWhere = {
    companyId,
    ...(params.sup_q
      ? { OR: [{ name: { contains: params.sup_q } }, { code: { contains: params.sup_q } }] }
      : {}),
  };
  const poWhere = {
    companyId,
    ...(params.po_status ? { status: params.po_status } : {}),
    ...(params.po_q
      ? { OR: [{ number: { contains: params.po_q } }, { supplier: { name: { contains: params.po_q } } }] }
      : {}),
  };
  const grnWhere = {
    companyId,
    ...(params.grn_q
      ? { OR: [{ number: { contains: params.grn_q } }, { supplier: { name: { contains: params.grn_q } } }] }
      : {}),
  };

  const [suppliers, supplierCount, orders, orderCount, receipts, receiptCount, totalReceipts, openAgg, productsForPo] =
    await Promise.all([
      db.supplier.findMany({
        where: supplierWhere,
        include: { _count: { select: { purchaseOrders: true, goodsReceipts: true } } },
        orderBy: { [SUP_SORT[supTs.sort ?? "name"]]: supTs.dir } as Record<string, string>,
        take: supTs.limit,
        skip: (supTs.page - 1) * supTs.limit,
      }),
      db.supplier.count({ where: supplierWhere }),
      db.purchaseOrder.findMany({
        where: poWhere,
        include: {
          supplier: { select: { name: true } },
          lines: { select: { quantity: true, received: true } },
        },
        orderBy: { [PO_SORT[poTs.sort ?? "date"]]: poTs.dir } as Record<string, string>,
        take: poTs.limit,
        skip: (poTs.page - 1) * poTs.limit,
      }),
      db.purchaseOrder.count({ where: poWhere }),
      db.goodsReceipt.findMany({
        where: grnWhere,
        include: {
          supplier: { select: { name: true } },
          location: { select: { name: true } },
          lines: { select: { quantity: true } },
        },
        orderBy: { [GRN_SORT[grnTs.sort ?? "received"]]: grnTs.dir } as Record<string, string>,
        take: grnTs.limit,
        skip: (grnTs.page - 1) * grnTs.limit,
      }),
      db.goodsReceipt.count({ where: grnWhere }),
      db.goodsReceipt.count({ where: { companyId } }),
      db.purchaseOrder.aggregate({
        where: { companyId, status: { in: ["SENT", "PARTIALLY_RECEIVED"] } },
        _sum: { totalCents: true },
        _count: true,
      }),
      canPurchaseWrite
        ? db.product.findMany({
            where: { companyId, active: true },
            select: { id: true, name: true, costPriceCents: true, taxRateBp: true },
            orderBy: { name: "asc" },
            take: 500,
          })
        : Promise.resolve([] as any[]),
    ]);

  const payablesAgg = await db.supplier.aggregate({
    where: { companyId },
    _sum: { balanceCents: true },
  });
  const payables = payablesAgg._sum.balanceCents ?? 0;

  const supSortHrefFor = (key: string) => {
    const next = toggleSort(supTs, key);
    return tableHref("/app/procurement", params, { sup_sort: next.sort, sup_dir: next.dir }, "sup");
  };
  const poSortHrefFor = (key: string) => {
    const next = toggleSort(poTs, key);
    return tableHref("/app/procurement", params, { po_sort: next.sort, po_dir: next.dir }, "po");
  };
  const grnSortHrefFor = (key: string) => {
    const next = toggleSort(grnTs, key);
    return tableHref("/app/procurement", params, { grn_sort: next.sort, grn_dir: next.dir }, "grn");
  };

  type SupRow = (typeof suppliers)[number];
  const supplierColumns: Array<Column<SupRow>> = [
    {
      key: "supplier",
      header: "Supplier",
      sortKey: "name",
      cell: (s) => <CellStack primary={<span className="font-medium">{s.name}</span>} secondary={s.code} />,
    },
    {
      key: "contact",
      header: "Contact",
      hideBelow: "md",
      cell: (s) => <CellStack primary={<span className="text-xs">{s.contactName ?? "—"}</span>} secondary={s.phone ?? ""} />,
    },
    {
      key: "terms",
      header: "Terms",
      hideBelow: "sm",
      sortKey: "terms",
      cell: (s) => <span className="text-content-muted text-xs">{s.paymentTermsDays}d</span>,
    },
    {
      key: "orders",
      header: "Orders",
      align: "right",
      numeric: true,
      hideBelow: "sm",
      cell: (s) => s._count.purchaseOrders,
    },
    {
      key: "balance",
      header: "Balance",
      align: "right",
      numeric: true,
      sortKey: "balance",
      cell: (s) => (
        <span className={s.balanceCents > 0 ? "text-warning font-medium" : ""}>
          <Money cents={s.balanceCents} />
        </span>
      ),
    },
    {
      key: "status",
      header: "Status",
      align: "right",
      sortKey: "status",
      cell: (s) => <StatusBadge status={s.status} />,
    },
    ...(canSupplierWrite
      ? [
          {
            key: "edit",
            header: "",
            srOnlyHeader: true,
            align: "right" as const,
            cell: (s: SupRow) => (
              <SupplierDialog mode="edit" supplier={s as unknown as SupplierShape} />
            ),
          },
        ]
      : []),
  ];

  type PoRow = (typeof orders)[number];
  const poColumns: Array<Column<PoRow>> = [
    {
      key: "number",
      header: "Number",
      sortKey: "number",
      cell: (po) => <span className="font-medium">{po.number}</span>,
    },
    { key: "supplier", header: "Supplier", cell: (po) => po.supplier.name },
    {
      key: "ordered",
      header: "Ordered",
      sortKey: "date",
      cell: (po) => (
        <span className="text-content-muted text-xs">{po.orderDate.toLocaleDateString("en-KE")}</span>
      ),
    },
    {
      key: "expected",
      header: "Expected",
      hideBelow: "md",
      sortKey: "expected",
      cell: (po) => (
        <span className="text-content-muted text-xs">
          {po.expectedAt?.toLocaleDateString("en-KE") ?? "—"}
        </span>
      ),
    },
    {
      key: "received",
      header: "Received",
      align: "right",
      hideBelow: "sm",
      cell: (po) => {
        const totalQty = po.lines.reduce((s, l) => s + l.quantity, 0);
        const recvQty = po.lines.reduce((s, l) => s + l.received, 0);
        return (
          <span className="text-content-muted text-xs">{recvQty}/{totalQty}</span>
        );
      },
    },
    {
      key: "total",
      header: "Total",
      align: "right",
      numeric: true,
      sortKey: "total",
      cell: (po) => <Money cents={po.totalCents} />,
    },
    {
      key: "status",
      header: "Status",
      align: "right",
      sortKey: "status",
      cell: (po) => <StatusBadge status={po.status} />,
    },
  ];

  type GrnRow = (typeof receipts)[number];
  const grnColumns: Array<Column<GrnRow>> = [
    { key: "number", header: "Number", sortKey: "number", cell: (g) => <span className="font-medium">{g.number}</span> },
    { key: "supplier", header: "Supplier", cell: (g) => g.supplier.name },
    { key: "into", header: "Into", hideBelow: "sm", cell: (g) => <span className="text-xs">{g.location.name}</span> },
    {
      key: "received",
      header: "Received",
      hideBelow: "md",
      sortKey: "received",
      cell: (g) => <span className="text-content-muted text-xs">{g.receivedAt.toLocaleDateString("en-KE")}</span>,
    },
    { key: "lines", header: "Lines", align: "right", numeric: true, cell: (g) => g.lines.length },
    { key: "status", header: "Status", align: "right", sortKey: "status", cell: (g) => <StatusBadge status={g.status} /> },
  ];

  return (
    <div className="space-y-8">
      <PageHeader
        title="Procurement"
        description="Purchase orders, goods received and supplier invoices."
        actions={
          <>
            {canPurchaseWrite && suppliers.length > 0 ? (
              <PurchaseOrderDialog
                suppliers={suppliers.map((s) => ({ id: s.id, name: s.name }))}
                products={productsForPo}
              />
            ) : null}
            {canSupplierWrite ? <SupplierDialog mode="create" /> : null}
          </>
        }
      />

      <StatGrid>
        <StatCard label="Suppliers" value={String(supplierCount)} />
        <StatCard
          label="Open purchase orders"
          value={String(openAgg._count)}
          hint={<><Money cents={openAgg._sum.totalCents ?? 0} compact /> committed</>}
        />
        <StatCard label="Goods receipts" value={String(totalReceipts)} hint="All time" />
        <StatCard
          label="Payables"
          value={<Money cents={payables} compact />}
          tone={payables > 0 ? "warning" : "success"}
        />
      </StatGrid>

      <div>
        <SectionHeading title="Suppliers" description={`${supplierCount} suppliers`} />
        <FilterBar action="/app/procurement" preserve={preserved(params, ["sup_q", "sup_page"])}>
          <FilterSearch name="sup_q" value={params.sup_q} placeholder="Search supplier name, code…" />
        </FilterBar>
        <DataTable
          columns={supplierColumns}
          rows={suppliers}
          getRowKey={(s) => s.id}
          caption="Suppliers"
          sort={{ key: supTs.sort, dir: supTs.dir }}
          sortHrefFor={supSortHrefFor}
          pagination={{
            page: supTs.page,
            pages: Math.max(1, Math.ceil(supplierCount / supTs.limit)),
            total: supplierCount,
            limit: supTs.limit,
            hrefFor: (p) => tableHref("/app/procurement", params, { sup_page: p }),
          }}
          empty={{ title: "No suppliers yet", action: canSupplierWrite ? <SupplierDialog mode="create" /> : undefined }}
        />
      </div>

      <div>
        <SectionHeading title="Purchase orders" description={`${orderCount} orders`} />
        <FilterBar action="/app/procurement" preserve={preserved(params, ["po_q", "po_status", "po_page"])}>
          <FilterSearch name="po_q" value={params.po_q} placeholder="Search PO number, supplier…" />
          <FilterSelect name="po_status" value={params.po_status} allLabel="Any status" options={PO_STATUSES} />
        </FilterBar>
        <DataTable
          columns={poColumns}
          rows={orders}
          getRowKey={(po) => po.id}
          caption="Purchase orders"
          sort={{ key: poTs.sort, dir: poTs.dir }}
          sortHrefFor={poSortHrefFor}
          pagination={{
            page: poTs.page,
            pages: Math.max(1, Math.ceil(orderCount / poTs.limit)),
            total: orderCount,
            limit: poTs.limit,
            hrefFor: (p) => tableHref("/app/procurement", params, { po_page: p }),
          }}
          empty={{ title: "No purchase orders raised yet" }}
        />
      </div>

      <div>
        <SectionHeading
          title="Goods received"
          description="Posting a receipt moves stock and updates the product's cost basis"
        />
        <FilterBar action="/app/procurement" preserve={preserved(params, ["grn_q", "grn_page"])}>
          <FilterSearch name="grn_q" value={params.grn_q} placeholder="Search GRN number, supplier…" />
        </FilterBar>
        <DataTable
          columns={grnColumns}
          rows={receipts}
          getRowKey={(g) => g.id}
          caption="Goods receipts"
          sort={{ key: grnTs.sort, dir: grnTs.dir }}
          sortHrefFor={grnSortHrefFor}
          pagination={{
            page: grnTs.page,
            pages: Math.max(1, Math.ceil(receiptCount / grnTs.limit)),
            total: receiptCount,
            limit: grnTs.limit,
            hrefFor: (p) => tableHref("/app/procurement", params, { grn_page: p }),
          }}
          empty={{ title: params.grn_q ? "No goods receipts match this search" : "No goods receipts recorded" }}
        />
      </div>
    </div>
  );
}
