import {
  CellStack,
  DataTable,
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
import { tableHref, tableState, toggleSort } from "@/lib/table";

import { PurchaseOrderDialog } from "./po-dialog";
import { SupplierDialog, type SupplierShape } from "./supplier-dialog";

export const dynamic = "force-dynamic";

const SUP_SORT: Record<string, string> = { name: "name", balance: "balanceCents" };
const PO_SORT: Record<string, string> = { date: "orderDate", number: "number", total: "totalCents" };

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
    allowed: ["name", "balance"],
    defaultSort: "name",
    defaultDir: "asc",
    limit: 10,
  });
  const poTs = tableState(params, {
    prefix: "po",
    allowed: ["date", "number", "total"],
    defaultSort: "date",
    defaultDir: "desc",
    limit: 10,
  });

  const canSupplierWrite = can(principal, "supplier:write");
  const canPurchaseWrite = can(principal, "purchase:write");

  const [suppliers, supplierCount, orders, orderCount, receipts, openAgg, productsForPo] =
    await Promise.all([
      db.supplier.findMany({
        where: { companyId },
        include: { _count: { select: { purchaseOrders: true, goodsReceipts: true } } },
        orderBy: { [SUP_SORT[supTs.sort ?? "name"]]: supTs.dir } as Record<string, string>,
        take: supTs.limit,
        skip: (supTs.page - 1) * supTs.limit,
      }),
      db.supplier.count({ where: { companyId } }),
      db.purchaseOrder.findMany({
        where: { companyId },
        include: {
          supplier: { select: { name: true } },
          lines: { select: { quantity: true, received: true } },
        },
        orderBy: { [PO_SORT[poTs.sort ?? "date"]]: poTs.dir } as Record<string, string>,
        take: poTs.limit,
        skip: (poTs.page - 1) * poTs.limit,
      }),
      db.purchaseOrder.count({ where: { companyId } }),
      db.goodsReceipt.findMany({
        where: { companyId },
        include: {
          supplier: { select: { name: true } },
          location: { select: { name: true } },
          lines: { select: { quantity: true } },
        },
        orderBy: { receivedAt: "desc" },
        take: 20,
      }),
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
      cell: (po) => <StatusBadge status={po.status} />,
    },
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
        <StatCard label="Goods receipts" value={String(receipts.length)} hint="Most recent 20" />
        <StatCard
          label="Payables"
          value={<Money cents={payables} compact />}
          tone={payables > 0 ? "warning" : "success"}
        />
      </StatGrid>

      <div>
        <SectionHeading title="Suppliers" description={`${supplierCount} suppliers`} />
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
        <DataTable
          columns={[
            { key: "number", header: "Number", cell: (g: GrnRow) => <span className="font-medium">{g.number}</span> },
            { key: "supplier", header: "Supplier", cell: (g: GrnRow) => g.supplier.name },
            { key: "into", header: "Into", hideBelow: "sm", cell: (g: GrnRow) => <span className="text-xs">{g.location.name}</span>, },
            { key: "received", header: "Received", hideBelow: "md", cell: (g: GrnRow) => <span className="text-content-muted text-xs">{g.receivedAt.toLocaleDateString("en-KE")}</span>, },
            { key: "lines", header: "Lines", align: "right" as const, cell: (g: GrnRow) => g.lines.length, },
            { key: "status", header: "Status", align: "right" as const, cell: (g: GrnRow) => <StatusBadge status={g.status} />, },
          ]}
          rows={receipts}
          getRowKey={(g) => g.id}
          caption="Goods receipts"
          empty={{ title: "No goods receipts recorded" }}
        />
      </div>
    </div>
  );
}

type GrnRow = {
  id: string;
  number: string;
  status: string;
  receivedAt: Date;
  lines: { quantity: number }[];
  supplier: { name: string };
  location: { name: string };
};
