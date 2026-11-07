import { notFound } from "next/navigation";

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
  StatCard,
  StatGrid,
  StatusBadge,
  type Column,
} from "@/components/ui";
import { db } from "@/lib/db";
import { can } from "@/lib/rbac";
import { nairobiDate } from "@/lib/report-engine";
import { requireTenant } from "@/lib/session";
import { preserved, tableHref, tableState, toggleSort } from "@/lib/table";

import { NewBillDialog, PayBillDialog, VoidBillDialog } from "./bill-dialogs";

export const dynamic = "force-dynamic";

const PATH = "/app/finance/bills";

const SORTS: Record<string, "issueDate" | "dueDate" | "number" | "totalCents"> = {
  date: "issueDate",
  due: "dueDate",
  number: "number",
  total: "totalCents",
};

/** Supplier bills: what is owed, what has been paid, and the VAT being claimed. */
export default async function BillsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { companyId, principal } = await requireTenant();
  if (!principal.enabledModules.has("FINANCE")) return <ModuleLocked module="FINANCE" />;
  if (!can(principal, "finance:read")) notFound();

  const params = await searchParams;
  const ts = tableState(params, {
    prefix: "bl",
    allowed: Object.keys(SORTS),
    defaultSort: "date",
    defaultDir: "desc",
    limit: 15,
  });

  const where = {
    companyId,
    ...(params.status ? { status: params.status } : {}),
    ...(params.q
      ? {
          OR: [
            { number: { contains: params.q } },
            { supplierRef: { contains: params.q } },
            { supplier: { name: { contains: params.q } } },
          ],
        }
      : {}),
  };

  const [bills, total, suppliers, accounts, open, grni] = await Promise.all([
    db.supplierInvoice.findMany({
      where,
      include: { supplier: { select: { name: true, taxPin: true } } },
      orderBy: ts.sort ? { [SORTS[ts.sort]]: ts.dir } : { issueDate: "desc" },
      take: ts.limit,
      skip: (ts.page - 1) * ts.limit,
    }),
    db.supplierInvoice.count({ where }),
    db.supplier.findMany({
      where: { companyId, status: "ACTIVE" },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
    db.account.findMany({
      where: { companyId, active: true, type: "EXPENSE" },
      select: { id: true, code: true, name: true },
      orderBy: { code: "asc" },
    }),
    db.supplierInvoice.findMany({
      where: { companyId, status: { in: ["UNPAID", "PARTIALLY_PAID"] } },
      select: { totalCents: true, paidCents: true, dueDate: true },
    }),
    db.journalLine.aggregate({
      where: { account: { companyId, systemKey: "GRNI" } },
      _sum: { debitCents: true, creditCents: true },
    }),
  ]);

  const now = new Date();
  const owed = open.reduce((n, b) => n + b.totalCents - b.paidCents, 0);
  const overdue = open.filter((b) => b.dueDate && b.dueDate < now).reduce((n, b) => n + b.totalCents - b.paidCents, 0);
  const unbilled = (grni._sum.creditCents ?? 0) - (grni._sum.debitCents ?? 0);
  const canWrite = can(principal, "payable:write");
  const today = nairobiDate();

  type Row = (typeof bills)[number];
  const columns: Array<Column<Row>> = [
    { key: "date", header: "Bill date", sortKey: "date", cell: (b) => <span>{nairobiDate(b.issueDate)}</span> },
    {
      key: "number",
      header: "Bill",
      sortKey: "number",
      cell: (b) => (
        <CellStack
          primary={<span className="font-mono text-xs font-semibold">{b.number}</span>}
          secondary={b.supplierRef ?? ""}
        />
      ),
    },
    {
      key: "supplier",
      header: "Supplier",
      cell: (b) => <CellStack primary={<span className="text-sm">{b.supplier.name}</span>} secondary={b.supplier.taxPin ?? "No KRA PIN"} />,
    },
    { key: "due", header: "Due", sortKey: "due", hideBelow: "md", cell: (b) => <span>{b.dueDate ? nairobiDate(b.dueDate) : "—"}</span> },
    { key: "vat", header: "VAT", align: "right", numeric: true, hideBelow: "md", cell: (b) => <Money cents={b.taxCents} exact /> },
    { key: "total", header: "Total", align: "right", numeric: true, sortKey: "total", cell: (b) => <Money cents={b.totalCents} exact /> },
    { key: "owed", header: "Owed", align: "right", numeric: true, cell: (b) => <Money cents={b.status === "VOID" ? 0 : b.totalCents - b.paidCents} exact /> },
    { key: "status", header: "Status", cell: (b) => <StatusBadge status={b.status} /> },
    ...(canWrite
      ? [
          {
            key: "actions",
            header: <span className="sr-only">Actions</span>,
            align: "right" as const,
            cell: (b: Row) => (
              <div className="flex items-center justify-end gap-1">
                {b.status === "UNPAID" || b.status === "PARTIALLY_PAID" ? (
                  <PayBillDialog id={b.id} number={b.number} outstandingCents={b.totalCents - b.paidCents} today={today} />
                ) : null}
                {b.status === "UNPAID" ? <VoidBillDialog id={b.id} number={b.number} /> : null}
              </div>
            ),
          } satisfies Column<Row>,
        ]
      : []),
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Supplier bills"
        description="What suppliers have billed and what has been paid. Input VAT on a VAT return comes from here."
        breadcrumb={{ href: "/app/finance", label: "Finance" }}
        actions={
          <>
            <ButtonLink href="/app/report-centre/ap-ageing" variant="secondary" size="sm">
              Payables ageing
            </ButtonLink>
            {canWrite ? (
              <NewBillDialog
                suppliers={suppliers}
                expenseAccounts={accounts.map((a) => ({ id: a.id, name: `${a.code} ${a.name}` }))}
                today={today}
              />
            ) : null}
          </>
        }
      />

      <StatGrid>
        <StatCard label="Owed to suppliers" value={<Money cents={owed} compact />} />
        <StatCard label="Overdue" value={<Money cents={overdue} compact />} tone={overdue > 0 ? "danger" : "success"} />
        <StatCard
          label="Received, not yet billed"
          value={<Money cents={unbilled} compact />}
          tone={unbilled > 0 ? "warning" : "neutral"}
          hint="Stock in, no bill entered"
        />
      </StatGrid>

      <div>
        <FilterBar action={PATH} preserve={preserved(params, ["q", "status", "bl_page"])}>
          <FilterSearch name="q" value={params.q} placeholder="Search bill, supplier invoice, supplier…" />
          <FilterSelect
            name="status"
            value={params.status}
            allLabel="All statuses"
            options={[
              { value: "UNPAID", label: "Unpaid" },
              { value: "PARTIALLY_PAID", label: "Part paid" },
              { value: "PAID", label: "Paid" },
              { value: "VOID", label: "Void" },
            ]}
          />
        </FilterBar>
        <DataTable
          columns={columns}
          rows={bills}
          getRowKey={(b) => b.id}
          caption="Supplier bills"
          sort={{ key: ts.sort, dir: ts.dir }}
          sortHrefFor={(key) => {
            const next = toggleSort(ts, key);
            return tableHref(PATH, params, { bl_sort: next.sort, bl_dir: next.dir }, "bl");
          }}
          pagination={{
            page: ts.page,
            pages: Math.max(1, Math.ceil(total / ts.limit)),
            total,
            limit: ts.limit,
            hrefFor: (p) => tableHref(PATH, params, { bl_page: p }, undefined),
          }}
          empty={{ title: "No bills yet", description: "Enter a supplier's tax invoice to record what is owed and claim its input VAT." }}
        />
      </div>
    </div>
  );
}
