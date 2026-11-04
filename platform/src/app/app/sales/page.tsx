import Link from "next/link";

import {
  CellStack,
  DataTable,
  ExportLink,
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
import { daysAgo } from "@/server/analytics";
import { refreshOverdueStatuses } from "@/server/sales";

import { InvoiceDialog } from "./invoice-dialog";

export const dynamic = "force-dynamic";

const SORT_COLUMNS: Record<string, string> = {
  issueDate: "issueDate",
  number: "number",
  total: "totalCents",
  status: "status",
};

/** Module 02 · Sales & POS — the invoicing surface from proposal page 7. */
export default async function SalesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { companyId, principal } = await requireTenant();
  if (!principal.enabledModules.has("SALES_POS")) return <ModuleLocked module="SALES_POS" />;

  await refreshOverdueStatuses(companyId);
  const params = await searchParams;
  const filters = params;

  const ts = tableState(params, {
    prefix: "inv",
    allowed: ["issueDate", "number", "total", "status"],
    defaultSort: "issueDate",
    defaultDir: "desc",
    limit: 15,
  });

  const selfScope =
    principal.role === "FIELD_REP" ? { createdById: principal.userId } : {};

  const where = {
    companyId,
    ...selfScope,
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.q
      ? {
          OR: [
            { number: { contains: filters.q } },
            { customer: { name: { contains: filters.q } } },
          ],
        }
      : {}),
  };

  const orderBy: Record<string, "asc" | "desc"> = ts.sort
    ? { [SORT_COLUMNS[ts.sort]]: ts.dir }
    : { issueDate: "desc" };

  const [invoices, invoiceCount, orders, monthAgg, byStatus, channelSplit, customers, products] =
    await Promise.all([
      db.invoice.findMany({
        where,
        include: {
          customer: { select: { name: true, town: true, phone: true } },
          lines: { select: { id: true } },
          _count: { select: { lines: true } },
        },
        orderBy,
        take: ts.limit,
        skip: (ts.page - 1) * ts.limit,
      }),
      db.invoice.count({ where }),
      db.salesOrder.findMany({
        where: { companyId, ...selfScope, status: { in: ["CONFIRMED", "DRAFT"] } },
        include: { customer: { select: { name: true } } },
        orderBy: { orderDate: "desc" },
        take: 15,
      }),
      db.invoice.aggregate({
        where: {
          companyId,
          status: { notIn: ["DRAFT", "CANCELLED"] },
          issueDate: { gte: daysAgo(30) },
        },
        _sum: { totalCents: true, paidCents: true },
        _count: true,
      }),
      db.invoice.groupBy({
        by: ["status"],
        where: { companyId },
        _count: true,
        _sum: { totalCents: true },
      }),
      db.invoice.groupBy({
        by: ["channel"],
        where: { companyId, issueDate: { gte: daysAgo(30) } },
        _count: true,
        _sum: { totalCents: true },
      }),
      can(principal, "invoice:write")
        ? db.customer.findMany({
            where: { companyId, status: "ACTIVE" },
            select: { id: true, name: true },
            orderBy: { name: "asc" },
            take: 200,
          })
        : Promise.resolve([] as Array<{ id: string; name: string }>),
      can(principal, "invoice:write")
        ? db.product.findMany({
            where: { companyId, active: true },
            select: { id: true, name: true, sellPriceCents: true, taxRateBp: true },
            orderBy: { name: "asc" },
            take: 400,
          })
        : Promise.resolve([] as any[]),
    ]);

  const invoiced = monthAgg._sum.totalCents ?? 0;
  const collected = monthAgg._sum.paidCents ?? 0;

  const sortHrefFor = (key: string) => {
    const next = toggleSort(ts, key);
    return tableHref("/app/sales", params, { inv_sort: next.sort, inv_dir: next.dir }, "inv");
  };

  type Row = (typeof invoices)[number];

  const invoiceColumns: Array<Column<Row>> = [
    {
      key: "number",
      header: "Invoice",
      sortKey: "number",
      cell: (inv) => (
        <CellStack
          primary={
            <Link href={`/app/sales/invoices/${inv.id}`} className="font-medium hover:text-accent underline underline-offset-2">
              {inv.number}
            </Link>
          }
          secondary={inv.customer.town ?? ""}
        />
      ),
    },
    {
      key: "customer",
      header: "Customer",
      hideBelow: "sm",
      cell: (inv) => (
        <CellStack primary={inv.customer.name} secondary={inv.customer.phone ?? ""} />
      ),
    },
    {
      key: "issued",
      header: "Issued",
      sortKey: "issueDate",
      cell: (inv) => (
        <span className="text-content-muted text-xs">
          {inv.issueDate.toLocaleDateString("en-KE")}
        </span>
      ),
    },
    {
      key: "due",
      header: "Due",
      hideBelow: "md",
      cell: (inv) => (
        <span className="text-content-muted text-xs">
          {inv.dueDate?.toLocaleDateString("en-KE") ?? "On receipt"}
        </span>
      ),
    },
    {
      key: "total",
      header: "Total",
      align: "right",
      numeric: true,
      sortKey: "total",
      cell: (inv) => <Money cents={inv.totalCents} />,
    },
    {
      key: "paid",
      header: "Paid",
      align: "right",
      numeric: true,
      hideBelow: "md",
      cell: (inv) => (
        <span className="text-content-muted">
          <Money cents={inv.paidCents} />
        </span>
      ),
    },
    {
      key: "outstanding",
      header: "Outstanding",
      align: "right",
      numeric: true,
      hideBelow: "sm",
      cell: (inv) => (
        <span className={inv.totalCents > inv.paidCents ? "font-medium" : "text-content-muted"}>
          <Money cents={inv.totalCents - inv.paidCents} />
        </span>
      ),
    },
    {
      key: "status",
      header: "Status",
      align: "right",
      sortKey: "status",
      cell: (inv) => <StatusBadge status={inv.status} />,
    },
  ];

  return (
    <div className="space-y-8">
      <PageHeader
        title="Sales & POS"
        description="Quotations, orders, invoices, receipts and discounts."
        actions={
          can(principal, "invoice:write") ? (
            <InvoiceDialog customers={customers} products={products} />
          ) : null
        }
      />

      <StatGrid>
        <StatCard
          label="Invoiced (30d)"
          value={<Money cents={invoiced} compact />}
          hint={`${monthAgg._count} invoices`}
        />
        <StatCard
          label="Collected (30d)"
          value={<Money cents={collected} compact />}
          hint={invoiced > 0 ? `${((collected / invoiced) * 100).toFixed(0)}% of invoiced` : undefined}
          tone="success"
        />
        <StatCard label="Open orders" value={String(orders.length)} hint="Awaiting invoicing" />
        <StatCard
          label="Overdue"
          value={
            <Money
              cents={byStatus.find((s) => s.status === "OVERDUE")?._sum.totalCents ?? 0}
              compact
            />
          }
          hint={`${byStatus.find((s) => s.status === "OVERDUE")?._count ?? 0} invoices`}
          tone="danger"
        />
      </StatGrid>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card2>
          <SectionHeading title="Sales channel" description="Last 30 days" />
          <ul className="space-y-3">
            {channelSplit.map((c) => (
              <li key={c.channel} className="flex items-baseline justify-between text-sm">
                <span className="capitalize">{c.channel.toLowerCase()}</span>
                <span>
                  <Money cents={c._sum.totalCents ?? 0} compact />
                  <span className="text-content-muted ml-2 text-xs">{c._count}</span>
                </span>
              </li>
            ))}
          </ul>
          <p className="text-content-muted mt-4 text-xs">
            &ldquo;Field&rdquo; invoices were raised on the mobile app during a
            customer visit.
          </p>
        </Card2>

        <Card2 wide>
          <SectionHeading title="Invoice status" />
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            {byStatus.map((s) => (
              <div key={s.status}>
                <StatusBadge status={s.status} />
                <p className="mt-1.5 text-lg font-semibold">{s._count}</p>
                <p className="text-content-muted text-xs">
                  <Money cents={s._sum.totalCents ?? 0} compact />
                </p>
              </div>
            ))}
          </div>
        </Card2>
      </div>

      {orders.length > 0 ? (
        <div>
          <SectionHeading title="Open orders" description="Confirmed but not yet invoiced" />
          <Card2 noPad>
            <div className="scroll-x">
              <table className="w-full border-collapse text-base">
                <thead>
                  <tr>
                    <th>Order</th>
                    <th>Customer</th>
                    <th>Channel</th>
                    <th>Date</th>
                    <th>Total</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {orders.map((o) => (
                    <tr key={o.id}>
                      <td className="font-medium">{o.number}</td>
                      <td>{o.customer.name}</td>
                      <td>
                        <span className="badge bg-surface-sunken">
                          {o.channel.toLowerCase()}
                        </span>
                      </td>
                      <td className="text-content-muted text-xs">
                        {o.orderDate.toLocaleDateString("en-KE")}
                      </td>
                      <td>
                        <Money cents={o.totalCents} />
                      </td>
                      <td>
                        <StatusBadge status={o.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card2>
        </div>
      ) : null}

      <div>
        <SectionHeading
          title="Invoices"
          description={`${invoiceCount.toLocaleString("en-KE")} total`}
          actions={<ExportLink href="/api/v1/reports/vat-summary?format=csv" label="VAT summary CSV" />}
        />
        <FilterBar
          action="/app/sales"
          preserve={preserved(params, ["q", "status", "inv_page"])}
        >
          <FilterSearch name="q" value={filters.q} placeholder="Search invoice #, customer…" />
          <FilterSelect
            name="status"
            value={filters.status}
            allLabel="Any status"
            options={[
              { value: "ISSUED", label: "Issued" },
              { value: "PARTIALLY_PAID", label: "Partially paid" },
              { value: "OVERDUE", label: "Overdue" },
              { value: "PAID", label: "Paid" },
              { value: "CANCELLED", label: "Cancelled" },
            ]}
          />
        </FilterBar>

        <DataTable
          columns={invoiceColumns}
          rows={invoices}
          getRowKey={(inv) => inv.id}
          caption="Invoices"
          sort={{ key: ts.sort, dir: ts.dir }}
          sortHrefFor={sortHrefFor}
          pagination={{
            page: ts.page,
            pages: Math.max(1, Math.ceil(invoiceCount / ts.limit)),
            total: invoiceCount,
            limit: ts.limit,
            hrefFor: (p) => tableHref("/app/sales", params, { inv_page: p }),
          }}
          empty={{ title: "No invoices match this filter" }}
        />
      </div>
    </div>
  );
}

/** Card with a consistent shell — kept local to avoid another public export. */
function Card2({
  children,
  wide,
  noPad,
}: {
  children: React.ReactNode;
  wide?: boolean;
  noPad?: boolean;
}) {
  return (
    <div
      className={`rounded-xl border border-border bg-surface shadow-sm ${wide ? "lg:col-span-2" : ""} ${noPad ? "" : "p-5"}`}
    >
      {children}
    </div>
  );
}
