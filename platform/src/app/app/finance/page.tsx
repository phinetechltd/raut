
import {
  ButtonLink,
  Meter,
  ModuleLocked,
  Money,
  SectionHeading,
  StatCard,
  StatusBadge,
} from "@/components/ui";
import { db } from "@/lib/db";
import { can } from "@/lib/rbac";
import { AGE_BUCKET_LABELS } from "@/lib/money";
import { requireTenant } from "@/lib/session";
import { daysAgo, receivablesAgeing } from "@/server/analytics";
import { refreshOverdueStatuses } from "@/server/sales";

export const dynamic = "force-dynamic";

/** Module 05 · Finance, Expenses & Receivables. */
export default async function FinancePage() {
  const { companyId, principal } = await requireTenant();
  if (!principal.enabledModules.has("FINANCE")) return <ModuleLocked module="FINANCE" />;

  await refreshOverdueStatuses(companyId);

  const [ageing, expenses, payments, topDebtors, expenseByCategory] = await Promise.all([
    receivablesAgeing(companyId),
    db.expense.findMany({
      where: { companyId },
      include: {
        category: { select: { name: true } },
        user: { select: { name: true } },
      },
      orderBy: { incurredAt: "desc" },
      take: 30,
    }),
    db.payment.findMany({
      where: { companyId },
      include: { customer: { select: { name: true } } },
      orderBy: { paidAt: "desc" },
      take: 20,
    }),
    db.customer.findMany({
      where: { companyId, balanceCents: { gt: 0 } },
      orderBy: { balanceCents: "desc" },
      take: 10,
      select: { id: true, name: true, town: true, balanceCents: true, creditLimitCents: true },
    }),
    db.expense.groupBy({
      by: ["categoryId"],
      where: { companyId, incurredAt: { gte: daysAgo(30) } },
      _sum: { amountCents: true },
      _count: true,
    }),
  ]);

  const categories = await db.expenseCategory.findMany({ where: { companyId } });
  const categoryName = new Map(categories.map((c) => [c.id, c.name]));

  const totalReceivable = ageing.reduce((s, a) => s + a.cents, 0);
  const overdue = ageing.filter((a) => a.bucket !== "CURRENT").reduce((s, a) => s + a.cents, 0);
  const pendingExpenses = expenses.filter((e) => e.status === "SUBMITTED");
  const collected30 = payments
    .filter((p) => p.paidAt >= daysAgo(30))
    .reduce((s, p) => s + p.amountCents, 0);

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Finance</h1>
          <p className="text-content-muted text-sm">
            Receivables, payment history and field expense claims.
          </p>
        </div>
        {can(principal, "report:financial") && (
          <ButtonLink href="/app/finance/reports" variant="primary" size="sm">
            Financial reports
          </ButtonLink>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Total receivable" value={<Money cents={totalReceivable} compact />} />
        <StatCard
          label="Overdue"
          value={<Money cents={overdue} compact />}
          hint={
            totalReceivable > 0
              ? `${((overdue / totalReceivable) * 100).toFixed(0)}% of book`
              : undefined
          }
          tone={overdue > 0 ? "danger" : "success"}
        />
        <StatCard label="Collected (30d)" value={<Money cents={collected30} compact />} tone="success" />
        <StatCard
          label="Claims awaiting approval"
          value={String(pendingExpenses.length)}
          hint={
            <>
              <Money cents={pendingExpenses.reduce((s, e) => s + e.amountCents, 0)} /> pending
            </>
          }
          tone={pendingExpenses.length > 0 ? "warning" : "neutral"}
        />
      </div>

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
          <div className="rounded-lg border border-border bg-surface p-5 shadow-sm">
            {topDebtors.length === 0 ? (
              <p className="text-content-muted text-sm">Nothing outstanding</p>
            ) : (
              <ul className="space-y-3">
                {topDebtors.map((c) => {
                  const overLimit =
                    c.creditLimitCents > 0 && c.balanceCents > c.creditLimitCents;
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
          <div className="rounded-lg border border-border bg-surface p-5 shadow-sm">
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
                        max={Math.max(
                          ...expenseByCategory.map((x) => x._sum.amountCents ?? 0),
                          1,
                        )}
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
        <div className="scroll-x rounded-lg border border-border bg-surface shadow-sm">
          <table className="w-full border-collapse text-base">
            <thead>
              <tr>
                <th>Number</th>
                <th>Description</th>
                <th>Category</th>
                <th>Claimed by</th>
                <th>Incurred</th>
                <th>Amount</th>
                <th>Located</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {expenses.length === 0 ? (
                <tr>
                  <td colSpan={8} className="text-content-muted py-10 text-center">
                    No expense claims
                  </td>
                </tr>
              ) : (
                expenses.map((e) => (
                  <tr key={e.id}>
                    <td className="font-medium">{e.number}</td>
                    <td>{e.description}</td>
                    <td className="text-content-muted text-xs">{e.category?.name ?? "—"}</td>
                    <td className="text-xs">{e.user?.name ?? "—"}</td>
                    <td className="text-content-muted text-xs">
                      {e.incurredAt.toLocaleDateString("en-KE")}
                    </td>
                    <td>
                      <Money cents={e.amountCents} />
                    </td>
                    <td>
                      {e.latitude != null ? (
                        <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium bg-success-bg text-success">gps</span>
                      ) : (
                        <span className="text-content-muted text-xs">—</span>
                      )}
                    </td>
                    <td>
                      <StatusBadge status={e.status} />
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div>
        <SectionHeading title="Recent payments" />
        <div className="scroll-x rounded-lg border border-border bg-surface shadow-sm">
          <table className="w-full border-collapse text-base">
            <thead>
              <tr>
                <th>Receipt</th>
                <th>Customer</th>
                <th>Method</th>
                <th>Reference</th>
                <th>Paid</th>
                <th>Amount</th>
              </tr>
            </thead>
            <tbody>
              {payments.map((p) => (
                <tr key={p.id}>
                  <td className="font-medium">{p.number}</td>
                  <td>{p.customer.name}</td>
                  <td>
                    <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium bg-surface-sunken">
                      {p.method.toLowerCase()}
                    </span>
                  </td>
                  <td className="text-content-muted text-xs">{p.reference ?? "—"}</td>
                  <td className="text-content-muted text-xs">{p.paidAt.toLocaleDateString("en-KE")}</td>
                  <td className="font-medium text-accent">
                    <Money cents={p.amountCents} />
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

