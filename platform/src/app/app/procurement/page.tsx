
import {
  ModuleLocked,
  Money,
  SectionHeading,
  StatCard,
  StatusBadge,
} from "@/components/ui";
import { db } from "@/lib/db";
import { requireTenant } from "@/lib/session";

export const dynamic = "force-dynamic";

/** Module 04 · Procurement & Suppliers. */
export default async function ProcurementPage() {
  const { companyId, principal } = await requireTenant();
  if (!principal.enabledModules.has("PROCUREMENT")) {
    return <ModuleLocked module="PROCUREMENT" />;
  }

  const [suppliers, orders, receipts, openAgg] = await Promise.all([
    db.supplier.findMany({
      where: { companyId },
      include: { _count: { select: { purchaseOrders: true, goodsReceipts: true } } },
      orderBy: { name: "asc" },
    }),
    db.purchaseOrder.findMany({
      where: { companyId },
      include: {
        supplier: { select: { name: true } },
        lines: { select: { quantity: true, received: true } },
      },
      orderBy: { orderDate: "desc" },
      take: 40,
    }),
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
  ]);

  const payables = suppliers.reduce((s, x) => s + x.balanceCents, 0);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Procurement</h1>
        <p className="text-content-muted text-sm">
          Purchase orders, goods received and supplier invoices.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Suppliers" value={String(suppliers.length)} />
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
      </div>

      <div>
        <SectionHeading title="Suppliers" />
        <div className="scroll-x rounded-lg border border-border bg-surface shadow-sm">
          <table className="w-full border-collapse text-base">
            <thead>
              <tr>
                <th>Supplier</th>
                <th>Contact</th>
                <th>Terms</th>
                <th>Orders</th>
                <th>Receipts</th>
                <th>Balance</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {suppliers.length === 0 ? (
                <tr>
                  <td colSpan={7} className="text-content-muted py-10 text-center">
                    No suppliers yet
                  </td>
                </tr>
              ) : (
                suppliers.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <p className="font-medium">{s.name}</p>
                      <p className="text-content-muted text-xs">{s.code}</p>
                    </td>
                    <td className="text-xs">
                      {s.contactName ?? "—"}
                      <span className="text-content-muted block">{s.phone ?? ""}</span>
                    </td>
                    <td className="text-content-muted text-xs">{s.paymentTermsDays}d</td>
                    <td>{s._count.purchaseOrders}</td>
                    <td>{s._count.goodsReceipts}</td>
                    <td>
                      <Money cents={s.balanceCents} />
                    </td>
                    <td>
                      <StatusBadge status={s.status} />
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div>
        <SectionHeading title="Purchase orders" />
        <div className="scroll-x rounded-lg border border-border bg-surface shadow-sm">
          <table className="w-full border-collapse text-base">
            <thead>
              <tr>
                <th>Number</th>
                <th>Supplier</th>
                <th>Ordered</th>
                <th>Expected</th>
                <th>Lines received</th>
                <th>Total</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {orders.length === 0 ? (
                <tr>
                  <td colSpan={7} className="text-content-muted py-10 text-center">
                    No purchase orders raised yet
                  </td>
                </tr>
              ) : (
                orders.map((po) => {
                  const totalQty = po.lines.reduce((s, l) => s + l.quantity, 0);
                  const recvQty = po.lines.reduce((s, l) => s + l.received, 0);
                  return (
                    <tr key={po.id}>
                      <td className="font-medium">{po.number}</td>
                      <td>{po.supplier.name}</td>
                      <td className="text-content-muted text-xs">
                        {po.orderDate.toLocaleDateString("en-KE")}
                      </td>
                      <td className="text-content-muted text-xs">
                        {po.expectedAt?.toLocaleDateString("en-KE") ?? "—"}
                      </td>
                      <td className="text-content-text-content-muted">
                        {recvQty}/{totalQty}
                      </td>
                      <td>
                        <Money cents={po.totalCents} />
                      </td>
                      <td>
                        <StatusBadge status={po.status} />
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div>
        <SectionHeading
          title="Goods received"
          description="Posting a receipt moves stock and updates the product's cost basis"
        />
        <div className="scroll-x rounded-lg border border-border bg-surface shadow-sm">
          <table className="w-full border-collapse text-base">
            <thead>
              <tr>
                <th>Number</th>
                <th>Supplier</th>
                <th>Into</th>
                <th>Received</th>
                <th>Lines</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {receipts.length === 0 ? (
                <tr>
                  <td colSpan={6} className="text-content-muted py-10 text-center">
                    No goods receipts recorded
                  </td>
                </tr>
              ) : (
                receipts.map((g) => (
                  <tr key={g.id}>
                    <td className="font-medium">{g.number}</td>
                    <td>{g.supplier.name}</td>
                    <td className="text-xs">{g.location.name}</td>
                    <td className="text-content-muted text-xs">
                      {g.receivedAt.toLocaleDateString("en-KE")}
                    </td>
                    <td className="text-content-text-content-muted">{g.lines.length}</td>
                    <td>
                      <StatusBadge status={g.status} />
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

