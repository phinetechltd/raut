import Link from "next/link";

import {
  ButtonLink,
  CellStack,
  DataTable,
  DateRangeBar,
  FilterBar,
  FilterSearch,
  FilterSelect,
  Meter,
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
import { AGE_BUCKET_LABELS } from "@/lib/money";
import { requireTenant } from "@/lib/session";
import { preserved, rangeFromParams, rangeLabel, tableHref, tableState, toggleSort } from "@/lib/table";
import { receivablesAgeing } from "@/server/analytics";
import { refreshOverdueStatuses } from "@/server/sales";

import { ExpenseDecisionButtons, ExpenseDialog } from "./expense-forms";
import { PaymentDialog } from "./payment-dialog";

export const dynamic = "force-dynamic";

const EXP_SORT: Record<string, string> = {
  incurred: "incurredAt",
  description: "description",
  amount: "amountCents",
  status: "status",
};
const PAY_SORT: Record<string, string> = {
  paid: "paidAt",
  amount: "amountCents",
  number: "number",
  method: "method",
};


/** Module 05 · Finance, Expenses & Receivables. */
export default async function FinancePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { companyId, principal } = await requireTenant();
  if (!principal.enabledModules.has("FINANCE")) return <ModuleLocked module="FINANCE" />;

  await refreshOverdueStatuses(companyId);
  const params = await searchParams;
  const range = rangeFromParams(params);

  const expTs = tableState(params, {
    prefix: "exp",
    allowed: ["incurred", "description", "amount", "status"],
    defaultSort: "incurred",
    defaultDir: "desc",
    limit: 10,
  });
  const payTs = tableState(params, {
    prefix: "pay",
    allowed: Object.keys(PAY_SORT),
    defaultSort: "paid",
    defaultDir: "desc",
    limit: 10,
  });

  const rangeWhere = (field: string) =>
    range.from ? { [field]: { gte: range.from, lte: range.to ?? new Date() } } : {};

  const expenseWhere = {
    companyId,
    ...rangeWhere("incurredAt"),
    ...(params.exp_cat ? { categoryId: params.exp_cat } : {}),
    ...(params.exp_q
      ? {
          OR: [
            { description: { contains: params.exp_q } },
            { number: { contains: params.exp_q } },
            { category: { name: { contains: params.exp_q } } },
          ],
        }
      : {}),
  };
  const paymentWhere = {
    companyId,
    ...rangeWhere("paidAt"),
    ...(params.pay_method ? { method: params.pay_method } : {}),
    ...(params.pay_q
      ? {
          OR: [
            { reference: { contains: params.pay_q } },
            { number: { contains: params.pay_q } },
            { method: { contains: params.pay_q } },
            { customer: { name: { contains: params.pay_q } } },
          ],
        }
      : {}),
  };

  const [ageing, expenses, expenseCount, payments, paymentCount, topDebtors, expenseByCategory, categories, customersForPay, methodsUsed] =
    await Promise.all([
      receivablesAgeing(companyId),
      db.expense.findMany({
        where: expenseWhere,
        include: { category: { select: { name: true } }, user: { select: { name: true } } },
        orderBy: { [EXP_SORT[expTs.sort ?? "incurred"]]: expTs.dir } as Record<string, string>,
        take: expTs.limit,
        skip: (expTs.page - 1) * expTs.limit,
      }),
      db.expense.count({ where: expenseWhere }),
      db.payment.findMany({
        where: paymentWhere,
        include: { customer: { select: { name: true } } },
        orderBy: { [PAY_SORT[payTs.sort ?? "paid"]]: payTs.dir } as Record<string, string>,
        take: payTs.limit,
        skip: (payTs.page - 1) * payTs.limit,
      }),
      db.payment.count({ where: paymentWhere }),
      db.customer.findMany({
        where: { companyId, balanceCents: { gt: 0 } },
        orderBy: { balanceCents: "desc" },
        take: 10,
        select: { id: true, name: true, town: true, balanceCents: true, creditLimitCents: true },
      }),
      db.expense.groupBy({
        by: ["categoryId"],
        where: { companyId, incurredAt: { gte: new Date(Date.now() - 30 * 86_400_000) } },
        _sum: { amountCents: true },
        _count: true,
      }),
      db.expenseCategory.findMany({ where: { companyId } }),
      db.customer.findMany({
        where: { companyId },
        select: { id: true, name: true, balanceCents: true },
        orderBy: { name: "asc" },
        take: 300,
      }),
      db.payment.groupBy({ by: ["method"], where: { companyId }, orderBy: { method: "asc" } }),
    ]);

  const categoryName = new Map(categories.map((c) => [c.id, c.name]));

  const totalReceivable = ageing.reduce((s, a) => s + a.cents, 0);
  const overdue = ageing.filter((a) => a.bucket !== "CURRENT").reduce((s, a) => s + a.cents, 0);
  const pendingCount = await db.expense.count({ where: { companyId, status: "SUBMITTED" } });
  const collectedAgg = await db.payment.aggregate({
    where: { companyId, ...rangeWhere("paidAt") },
    _sum: { amountCents: true },
  });
  const collectedInRange = collectedAgg._sum.amountCents ?? 0;

  const canExpenseWrite = can(principal, "expense:write");
  const canApprove = can(principal, "expense:approve");
  const canPaymentWrite = can(principal, "payment:write");

  const expHrefFor = (key: string) => {
    const next = toggleSort(expTs, key);
    return tableHref("/app/finance", params, { exp_sort: next.sort, exp_dir: next.dir }, "exp");
  };
  const payHrefFor = (key: string) => {
    const next = toggleSort(payTs, key);
    return tableHref("/app/finance", params, { pay_sort: next.sort, pay_dir: next.dir }, "pay");
  };

  type ExpRow = (typeof expenses)[number];
  const expenseColumns: Array<Column<ExpRow>> = [
    {
      key: "number",
      header: "Number",
      cell: (e) => <span className="font-medium">{e.number}</span>,
    },
    {
      key: "description",
      header: "Description",
      sortKey: "description",
      cell: (e) => <CellStack primary={<span>{e.description}</span>} secondary={e.category?.name ?? "Uncategorised"} />,
    },
    {
      key: "claimed",
      header: "Claimed by",
      hideBelow: "md",
      cell: (e) => <span className="text-xs">{e.user?.name ?? "—"}</span>,
    },
    {
      key: "incurred",
      header: "Incurred",
      sortKey: "incurred",
      hideBelow: "sm",
      cell: (e) => <span className="text-content-muted text-xs">{e.incurredAt.toLocaleDateString("en-KE")}</span>,
    },
    {
      key: "amount",
      header: "Amount",
      align: "right",
      numeric: true,
      sortKey: "amount",
      cell: (e) => <Money cents={e.amountCents} />,
    },
    {
      key: "located",
      header: "",
      srOnlyHeader: true,
      hideBelow: "lg",
      cell: (e) =>
        e.latitude != null ? (
          <span className="badge bg-success-bg text-success border-success-border">gps</span>
        ) : (
          <span className="text-content-muted text-xs">—</span>
        ),
    },
    {
      key: "status",
      header: "Status",
      align: "right",
      sortKey: "status",
      cell: (e) => <StatusBadge status={e.status} />,
    },
    ...(canApprove
      ? [
          {
            key: "actions",
            header: "Approve",
            align: "right" as const,
            cell: (e: ExpRow) =>
              e.status === "SUBMITTED" ? (
                <ExpenseDecisionButtons expenseId={e.id} amountTitle={`${e.description}`} />
              ) : (
                <span className="text-content-muted text-xs">{e.status === "APPROVED" ? "✓ approved" : "—"}</span>
              ),
          },
        ]
      : []),
  ];

  type PayRow = (typeof payments)[number];
  const paymentColumns: Array<Column<PayRow>> = [
    {
      key: "number",
      header: "Receipt",
      cell: (p) => <span className="font-medium">{p.number}</span>,
    },
    { key: "customer", header: "Customer", cell: (p) => p.customer.name },
    {
      key: "method",
      header: "Method",
      hideBelow: "sm",
      sortKey: "method",
      cell: (p) => <span className="badge bg-surface-sunken">{p.method.toLowerCase()}</span>,
    },
    {
      key: "reference",
      header: "Reference",
      hideBelow: "lg",
      cell: (p) => <span className="text-content-muted text-xs">{p.reference ?? "—"}</span>,
    },
    {
      key: "paid",
      header: "Paid",
      sortKey: "paid",
      hideBelow: "md",
      cell: (p) => <span className="text-content-muted text-xs">{p.paidAt.toLocaleDateString("en-KE")}</span>,
    },
    {
      key: "amount",
      header: "Amount",
      align: "right",
      numeric: true,
      sortKey: "amount",
      cell: (p) => <span className="font-medium text-accent"><Money cents={p.amountCents} /></span>,
    },
    {
      key: "receipt",
      header: "Receipt",
      align: "right",
      srOnlyHeader: true,
      cell: (p) => (
        <Link href={`/print/receipt/${p.id}`} target="_blank" className="text-xs text-content-muted hover:text-accent print:hidden">
          Receipt
        </Link>
      ),
    },
  ];

  return (
    <div className="space-y-8">
      <PageHeader
        title="Finance"
        description="Receivables, payment history and field expense claims."
        actions={
          <>
            {canPaymentWrite && <PaymentDialog customers={customersForPay} />}
            {canExpenseWrite && <ExpenseDialog categories={categories.map((c) => ({ id: c.id, name: c.name }))} />}
            {can(principal, "report:financial") && (
              <ButtonLink href="/app/finance/reports" variant="secondary">
                Financial reports
              </ButtonLink>
            )}
            {can(principal, "report:financial") && (
              <ButtonLink href="/app/finance/journal" variant="secondary">
                Journal entries
              </ButtonLink>
            )}
            {can(principal, "finance:read") && (
              <ButtonLink href="/app/finance/bills" variant="secondary">
                Supplier bills
              </ButtonLink>
            )}
          </>
        }
      />

      <DateRangeBar
        action="/app/finance"
        active={range.key}
        preserve={preserved(params, ["range", "from", "to", "exp_page", "pay_page"])}
      />

      <StatGrid>
        <StatCard label="Total receivable" value={<Money cents={totalReceivable} compact />} />
        <StatCard
          label="Overdue"
          value={<Money cents={overdue} compact />}
          hint={totalReceivable > 0 ? `${((overdue / totalReceivable) * 100).toFixed(0)}% of book` : undefined}
          tone={overdue > 0 ? "danger" : "success"}
        />
        <StatCard
          label="Collected in range"
          value={<Money cents={collectedInRange} compact />}
          tone="success"
          hint={rangeLabel(range)}
        />
        <StatCard
          label="Claims awaiting approval"
          value={String(pendingCount)}
          tone={pendingCount > 0 ? "warning" : "neutral"}
        />
      </StatGrid>

      <div>
        <SectionHeading title="Receivables ageing" description="Outstanding balance by days past due" />
        <div className="grid gap-4 sm:grid-cols-3 xl:grid-cols-5">
          {ageing.map((row) => (
            <StatCard
              key={row.bucket}
              label={AGE_BUCKET_LABELS[row.bucket]}
              value={<Money cents={row.cents} compact />}
              hint={`${row.invoices} invoice(s)`}
              tone={
                row.bucket === "D90_PLUS" ? "danger" : row.bucket === "D61_90" ? "warning" : "neutral"
              }
            />
          ))}
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div>
          <SectionHeading title="Top debtors" description="Largest outstanding balances" />
          <div className="rounded-xl border border-border bg-surface p-5 shadow-sm">
            {topDebtors.length === 0 ? (
              <p className="text-content-muted text-sm">Nothing outstanding</p>
            ) : (
              <ul className="space-y-3">
                {topDebtors.map((c) => {
                  const overLimit = c.creditLimitCents > 0 && c.balanceCents > c.creditLimitCents;
                  return (
                    <li key={c.id}>
                      <div className="mb-1 flex items-baseline justify-between gap-3 text-xs">
                        <span className="truncate font-medium">
                          {c.name}
                          <span className="text-content-muted ml-1.5">{c.town}</span>
                        </span>
                        <span className={overLimit ? "shrink-0 text-danger" : "shrink-0"}>
                          <Money cents={c.balanceCents} />
                          {overLimit ? " ⚠" : ""}
                        </span>
                      </div>
                      <Meter
                        value={c.balanceCents}
                        max={c.creditLimitCents || topDebtors[0].balanceCents}
                        tone={overLimit ? "danger" : "warning"}
                      />
                      {overLimit ? (
                        <p className="mt-0.5 text-[11px] text-danger">
                          Over credit limit of <Money cents={c.creditLimitCents} />
                        </p>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>

        <div>
          <SectionHeading title="Expenses by category" description="Last 30 days" />
          <div className="rounded-xl border border-border bg-surface p-5 shadow-sm">
            {expenseByCategory.length === 0 ? (
              <p className="text-content-muted text-sm">No expenses recorded</p>
            ) : (
              <ul className="space-y-3">
                {expenseByCategory
                  .sort((a, b) => (b._sum.amountCents ?? 0) - (a._sum.amountCents ?? 0))
                  .map((e) => (
                    <li key={e.categoryId ?? "none"}>
                      <div className="mb-1 flex justify-between text-xs">
                        <span>{categoryName.get(e.categoryId ?? "") ?? "Uncategorised"}</span>
                        <span>
                          <Money cents={e._sum.amountCents ?? 0} />
                          <span className="text-content-muted ml-2">{e._count}</span>
                        </span>
                      </div>
                      <Meter
                        value={e._sum.amountCents ?? 0}
                        max={Math.max(...expenseByCategory.map((x) => x._sum.amountCents ?? 0), 1)}
                        tone="warning"
                      />
                    </li>
                  ))}
              </ul>
            )}
          </div>
        </div>
      </div>

      <div>
        <SectionHeading
          title="Expense claims"
          description="Field claims capture the rep's position when the expense was raised"
        />
        <FilterBar action="/app/finance" preserve={preserved(params, ["exp_q", "exp_cat", "exp_page"])}>
          <FilterSearch name="exp_q" value={params.exp_q} placeholder="Search description, number, category…" />
          <FilterSelect
            name="exp_cat"
            value={params.exp_cat}
            allLabel="All categories"
            options={categories.map((c) => ({ value: c.id, label: c.name }))}
          />
        </FilterBar>
        <DataTable
          columns={expenseColumns}
          rows={expenses}
          getRowKey={(e) => e.id}
          caption="Expense claims"
          sort={{ key: expTs.sort, dir: expTs.dir }}
          sortHrefFor={expHrefFor}
          pagination={{
            page: expTs.page,
            pages: Math.max(1, Math.ceil(expenseCount / expTs.limit)),
            total: expenseCount,
            limit: expTs.limit,
            hrefFor: (p) => tableHref("/app/finance", params, { exp_page: p }),
          }}
          empty={{ title: "No expense claims", action: canExpenseWrite ? <ExpenseDialog categories={categories.map((c) => ({ id: c.id, name: c.name }))} /> : undefined }}
        />
      </div>

      <div>
        <SectionHeading title="Payments" description={`${paymentCount} in range`} />
        <FilterBar action="/app/finance" preserve={preserved(params, ["pay_q", "pay_method", "pay_page"])}>
          <FilterSearch name="pay_q" value={params.pay_q} placeholder="Search reference, receipt, customer…" />
          <FilterSelect
            name="pay_method"
            value={params.pay_method}
            allLabel="Any method"
            options={methodsUsed.map((m) => ({ value: m.method, label: m.method.toLowerCase().replace(/_/g, " ") }))}
          />
        </FilterBar>
        <DataTable
          columns={paymentColumns}
          rows={payments}
          getRowKey={(p) => p.id}
          caption="Payments"
          sort={{ key: payTs.sort, dir: payTs.dir }}
          sortHrefFor={payHrefFor}
          pagination={{
            page: payTs.page,
            pages: Math.max(1, Math.ceil(paymentCount / payTs.limit)),
            total: paymentCount,
            limit: payTs.limit,
            hrefFor: (p) => tableHref("/app/finance", params, { pay_page: p }),
          }}
          empty={{ title: "No payments in the selected range" }}
        />
      </div>
    </div>
  );
}
