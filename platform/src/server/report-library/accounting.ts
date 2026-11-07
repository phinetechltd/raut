import "server-only";

import { db } from "@/lib/db";
import { outstandingCents } from "@/lib/money";
import type { Permission } from "@/lib/rbac";
import { ageColumn, basisPoints, nairobiMonth, type ReportRow } from "@/lib/report-engine";
import { systemAccounts, trialBalance } from "@/server/ledger";
import { stockValuation } from "@/server/reports";

import { capped, ROW_LIMIT, within, type ReportContext, type ReportDefinition, type ReportSelect } from "./types";

const FINANCIAL: Permission[] = ["report:financial"];

const ageingColumns = [
  { key: "currentCents", label: "Current", kind: "money", total: true },
  { key: "d1_30Cents", label: "1–30 days", kind: "money", total: true },
  { key: "d31_60Cents", label: "31–60 days", kind: "money", total: true, hideBelow: "md" },
  { key: "d61_90Cents", label: "61–90 days", kind: "money", total: true, hideBelow: "md" },
  { key: "d90PlusCents", label: "90+ days", kind: "money", total: true, hideBelow: "md" },
] as const;

const accountSelect: ReportSelect = {
  key: "account",
  allLabel: "All accounts",
  load: async (companyId) =>
    (
      await db.account.findMany({
        where: { companyId },
        select: { id: true, code: true, name: true },
        orderBy: { code: "asc" },
      })
    ).map((a) => ({ value: a.id, label: `${a.code} ${a.name}` })),
};

const CASH_KEYS = ["CASH", "BANK", "GATEWAY_CLEARING"];

const cashAccountSelect: ReportSelect = {
  key: "account",
  allLabel: "All cash and bank accounts",
  load: async (companyId) =>
    (
      await db.account.findMany({
        where: { companyId, systemKey: { in: CASH_KEYS } },
        select: { id: true, code: true, name: true },
        orderBy: { code: "asc" },
      })
    ).map((a) => ({ value: a.id, label: `${a.code} ${a.name}` })),
};

const naturalDebit = (type: string) => type === "ASSET" || type === "EXPENSE";

/** Date-ordered lines for some accounts, each with its running balance. */
async function ledgerLines(ctx: ReportContext, accountWhere: Record<string, unknown>) {
  const accounts = await db.account.findMany({
    where: { companyId: ctx.companyId, ...accountWhere },
    select: { id: true, code: true, name: true, type: true },
    orderBy: { code: "asc" },
  });
  const ids = accounts.map((a) => a.id);
  const accountById = new Map(accounts.map((a) => [a.id, a]));

  const [openings, lines] = await Promise.all([
    ctx.from
      ? db.journalLine.groupBy({
          by: ["accountId"],
          where: { accountId: { in: ids }, entry: { companyId: ctx.companyId, date: { lt: ctx.from } } },
          _sum: { debitCents: true, creditCents: true },
        })
      : Promise.resolve([]),
    db.journalLine.findMany({
      where: { accountId: { in: ids }, entry: { companyId: ctx.companyId, ...within(ctx, "date") } },
      select: {
        accountId: true,
        debitCents: true,
        creditCents: true,
        memo: true,
        entry: { select: { id: true, number: true, date: true, memo: true, sourceKind: true, refType: true } },
      },
      orderBy: [{ entry: { date: "asc" } }, { entry: { number: "asc" } }],
      take: ROW_LIMIT,
    }),
  ]);

  const running = new Map<string, number>();
  for (const o of openings) {
    const account = accountById.get(o.accountId)!;
    const debit = o._sum.debitCents ?? 0;
    const credit = o._sum.creditCents ?? 0;
    running.set(o.accountId, naturalDebit(account.type) ? debit - credit : credit - debit);
  }
  const opening = ids.reduce((n, id) => n + (running.get(id) ?? 0), 0);

  const { rows: kept, truncated } = capped(lines);
  const rows: ReportRow[] = kept.map((line) => {
    const account = accountById.get(line.accountId)!;
    const delta = naturalDebit(account.type)
      ? line.debitCents - line.creditCents
      : line.creditCents - line.debitCents;
    const balance = (running.get(line.accountId) ?? 0) + delta;
    running.set(line.accountId, balance);
    return {
      date: line.entry.date,
      number: line.entry.number,
      numberHref: `/app/finance/journal/${line.entry.id}`,
      source: line.entry.sourceKind,
      account: `${account.code} ${account.name}`,
      memo: line.memo ?? line.entry.memo ?? "",
      debitCents: line.debitCents,
      creditCents: line.creditCents,
      balanceCents: balance,
    };
  });

  const closing = ids.reduce((n, id) => n + (running.get(id) ?? 0), 0);
  return { rows, opening, closing, truncated };
}

const ledgerColumns: ReportDefinition["columns"] = [
  { key: "date", label: "Date", kind: "date" },
  { key: "number", label: "Journal", kind: "mono", hrefKey: "numberHref" },
  { key: "account", label: "Account" },
  { key: "memo", label: "Narration", hideBelow: "lg" },
  { key: "source", label: "Source", kind: "status", hideBelow: "md" },
  { key: "debitCents", label: "Debit", kind: "money", total: true },
  { key: "creditCents", label: "Credit", kind: "money", total: true },
  { key: "balanceCents", label: "Balance", kind: "money" },
];

export const accountingReports: ReportDefinition[] = [
  {
    key: "trial-balance",
    title: "Trial balance",
    description: "Every account's opening balance, movement and closing balance. Debits must equal credits.",
    group: "accounting",
    module: "FINANCE",
    permissions: FINANCIAL,
    usesPeriod: true,
    defaultRange: "ytd",
    columns: [
      { key: "code", label: "Code", kind: "mono", hrefKey: "codeHref" },
      { key: "name", label: "Account" },
      { key: "type", label: "Type", kind: "status", hideBelow: "md" },
      { key: "openingCents", label: "Opening", kind: "money", hideBelow: "lg" },
      { key: "debitCents", label: "Period debits", kind: "money", total: true, hideBelow: "md" },
      { key: "creditCents", label: "Period credits", kind: "money", total: true, hideBelow: "md" },
      { key: "closingDebitCents", label: "Closing debit", kind: "money", total: true },
      { key: "closingCreditCents", label: "Closing credit", kind: "money", total: true },
    ],
    filters: [{ key: "type", allLabel: "All account types" }],
    defaultSort: { key: "code", dir: "asc" },
    async run(ctx) {
      const to = ctx.to ?? ctx.now;
      const [movement, closing, opening] = await Promise.all([
        trialBalance(ctx.companyId, { from: ctx.from ?? undefined, to }),
        trialBalance(ctx.companyId, { to }),
        ctx.from ? trialBalance(ctx.companyId, { to: new Date(ctx.from.getTime() - 1) }) : Promise.resolve([]),
      ]);
      const openingBy = new Map(opening.map((r) => [r.accountId, r.balanceCents]));
      const movementBy = new Map(movement.map((r) => [r.accountId, r]));

      const rows = closing
        .map((r) => {
          const moved = movementBy.get(r.accountId);
          const net = r.debitCents - r.creditCents;
          return {
            code: r.code,
            codeHref: `/app/report-centre/general-ledger?s_account=${r.accountId}`,
            name: r.name,
            type: r.type,
            openingCents: openingBy.get(r.accountId) ?? 0,
            debitCents: moved?.debitCents ?? 0,
            creditCents: moved?.creditCents ?? 0,
            closingDebitCents: net > 0 ? net : 0,
            closingCreditCents: net < 0 ? -net : 0,
          };
        })
        .filter((r) => r.debitCents || r.creditCents || r.closingDebitCents || r.closingCreditCents);

      const debit = rows.reduce((n, r) => n + r.closingDebitCents, 0);
      const credit = rows.reduce((n, r) => n + r.closingCreditCents, 0);
      return {
        rows,
        summary: [
          { label: "Total debits", value: debit, kind: "money" },
          { label: "Total credits", value: credit, kind: "money" },
          {
            label: "Difference",
            value: debit - credit,
            kind: "money",
            tone: debit === credit ? "success" : "danger",
            hint: debit === credit ? "The books balance" : "The books do not balance",
          },
        ],
      };
    },
  },
  {
    key: "general-ledger",
    title: "General ledger",
    description: "Every line posted to an account, with its running balance. Choose an account to follow one.",
    group: "accounting",
    module: "FINANCE",
    permissions: FINANCIAL,
    usesPeriod: true,
    columns: ledgerColumns,
    filters: [{ key: "source", allLabel: "All sources" }],
    selects: [accountSelect],
    async run(ctx) {
      const account = ctx.params.s_account;
      const { rows, opening, closing, truncated } = await ledgerLines(ctx, account ? { id: account } : {});
      return {
        rows,
        truncated,
        summary: account
          ? [
              { label: "Opening balance", value: opening, kind: "money" },
              { label: "Closing balance", value: closing, kind: "money" },
              { label: "Net movement", value: closing - opening, kind: "money" },
            ]
          : undefined,
      };
    },
  },
  {
    key: "cash-book",
    title: "Cash book",
    description: "Money through cash, bank and the payment gateway, line by line, with a running balance.",
    group: "accounting",
    module: "FINANCE",
    permissions: FINANCIAL,
    usesPeriod: true,
    columns: ledgerColumns,
    filters: [{ key: "source", allLabel: "All sources" }],
    selects: [cashAccountSelect],
    async run(ctx) {
      const account = ctx.params.s_account;
      const { rows, opening, closing, truncated } = await ledgerLines(
        ctx,
        account ? { id: account, systemKey: { in: CASH_KEYS } } : { systemKey: { in: CASH_KEYS } },
      );
      const inflow = rows.reduce((n, r) => n + (r.debitCents as number), 0);
      const outflow = rows.reduce((n, r) => n + (r.creditCents as number), 0);
      return {
        rows,
        truncated,
        summary: [
          { label: "Opening balance", value: opening, kind: "money" },
          { label: "Money in", value: inflow, kind: "money", tone: "success" },
          { label: "Money out", value: outflow, kind: "money" },
          { label: "Closing balance", value: closing, kind: "money" },
        ],
      };
    },
  },
  {
    key: "journal-register",
    title: "Journal register",
    description: "Every journal line in order, whichever document or person posted it.",
    group: "accounting",
    module: "FINANCE",
    permissions: FINANCIAL,
    usesPeriod: true,
    columns: ledgerColumns.filter((c) => c.key !== "balanceCents"),
    filters: [{ key: "source", allLabel: "All sources" }],
    async run(ctx) {
      const { rows, truncated } = await ledgerLines(ctx, {});
      return { rows, truncated };
    },
  },
  {
    key: "pl-by-month",
    title: "Profit and loss by month",
    description: "Revenue, cost of sales, expenses and profit month by month, from the ledger.",
    group: "accounting",
    module: "FINANCE",
    permissions: FINANCIAL,
    usesPeriod: true,
    defaultRange: "ytd",
    columns: [
      { key: "month", label: "Month", kind: "mono" },
      { key: "revenueCents", label: "Revenue", kind: "money", total: true },
      { key: "cosCents", label: "Cost of sales", kind: "money", total: true },
      { key: "grossCents", label: "Gross profit", kind: "money", total: true },
      { key: "marginBp", label: "Gross margin", kind: "pct", hideBelow: "md" },
      { key: "expensesCents", label: "Expenses", kind: "money", total: true, hideBelow: "md" },
      { key: "netCents", label: "Net profit", kind: "money", total: true },
    ],
    defaultSort: { key: "month", dir: "asc" },
    async run(ctx) {
      const lines = await db.journalLine.findMany({
        where: {
          account: { type: { in: ["INCOME", "EXPENSE"] } },
          entry: { companyId: ctx.companyId, ...within(ctx, "date") },
        },
        select: {
          debitCents: true,
          creditCents: true,
          account: { select: { type: true, code: true } },
          entry: { select: { date: true } },
        },
        take: 500_000,
      });
      const months = new Map<string, { revenue: number; cos: number; expenses: number }>();
      for (const line of lines) {
        const month = nairobiMonth(line.entry.date);
        const m = months.get(month) ?? { revenue: 0, cos: 0, expenses: 0 };
        if (line.account.type === "INCOME") m.revenue += line.creditCents - line.debitCents;
        else if (line.account.code.startsWith("5")) m.cos += line.debitCents - line.creditCents;
        else m.expenses += line.debitCents - line.creditCents;
        months.set(month, m);
      }
      const rows = [...months.entries()].map(([month, m]) => {
        const gross = m.revenue - m.cos;
        return {
          month,
          revenueCents: m.revenue,
          cosCents: m.cos,
          grossCents: gross,
          marginBp: basisPoints(gross, m.revenue),
          expensesCents: m.expenses,
          netCents: gross - m.expenses,
        };
      });
      return { rows };
    },
  },
  {
    key: "ar-ageing",
    title: "Receivables ageing",
    description: "What each customer owes today, by how long it has been overdue.",
    group: "accounting",
    module: "FINANCE",
    permissions: FINANCIAL,
    usesPeriod: false,
    columns: [
      { key: "code", label: "Code", kind: "mono", hideBelow: "lg" },
      { key: "customer", label: "Customer", hrefKey: "statementHref" },
      ...ageingColumns,
      { key: "unallocatedCents", label: "Unallocated", kind: "money", total: true, hideBelow: "lg" },
      { key: "totalCents", label: "Balance", kind: "money", total: true },
    ],
    defaultSort: { key: "totalCents", dir: "desc" },
    async run(ctx) {
      const [customers, invoices, control] = await Promise.all([
        db.customer.findMany({
          where: { companyId: ctx.companyId, balanceCents: { not: 0 } },
          select: { id: true, code: true, name: true, balanceCents: true },
        }),
        db.invoice.findMany({
          where: { companyId: ctx.companyId, status: { notIn: ["DRAFT", "CANCELLED"] } },
          select: {
            customerId: true,
            totalCents: true,
            paidCents: true,
            dueDate: true,
            creditNotes: { where: { status: { not: "CANCELLED" } }, select: { totalCents: true } },
          },
        }),
        trialBalance(ctx.companyId),
      ]);

      const buckets = new Map<string, Record<string, number>>();
      for (const inv of invoices) {
        const due = outstandingCents({
          ...inv,
          creditedCents: inv.creditNotes.reduce((n, c) => n + c.totalCents, 0),
        });
        if (due === 0) continue;
        const row = buckets.get(inv.customerId) ?? {};
        const column = ageColumn(inv.dueDate, ctx.now);
        row[column] = (row[column] ?? 0) + due;
        buckets.set(inv.customerId, row);
      }

      const rows = customers.map((c) => {
        const b = buckets.get(c.id) ?? {};
        const aged = Object.values(b).reduce((n, v) => n + v, 0);
        return {
          code: c.code,
          customer: c.name,
          statementHref: `/print/statement/${c.id}`,
          currentCents: b.currentCents ?? 0,
          d1_30Cents: b.d1_30Cents ?? 0,
          d31_60Cents: b.d31_60Cents ?? 0,
          d61_90Cents: b.d61_90Cents ?? 0,
          d90PlusCents: b.d90PlusCents ?? 0,
          // Money received but not matched to an invoice. It lowers the balance
          // without touching any one invoice, so it needs its own column to add up.
          unallocatedCents: c.balanceCents - aged,
          totalCents: c.balanceCents,
        };
      });

      const total = rows.reduce((n, r) => n + r.totalCents, 0);
      const ledger = control.find((r) => r.code === "1200")?.balanceCents ?? 0;
      return {
        rows,
        summary: [
          { label: "Total receivable", value: total, kind: "money" },
          { label: "Accounts receivable in the ledger", value: ledger, kind: "money" },
          {
            label: "Difference",
            value: total - ledger,
            kind: "money",
            tone: total === ledger ? "success" : "danger",
            hint: total === ledger ? "Agrees with the ledger" : "See the control account reconciliation",
          },
        ],
      };
    },
  },
  {
    key: "ap-ageing",
    title: "Payables ageing",
    description: "What is owed to each supplier today, by how long it has been overdue.",
    group: "accounting",
    module: "FINANCE",
    permissions: FINANCIAL,
    usesPeriod: false,
    columns: [
      { key: "code", label: "Code", kind: "mono", hideBelow: "lg" },
      { key: "supplier", label: "Supplier" },
      ...ageingColumns,
      { key: "totalCents", label: "Balance", kind: "money", total: true },
    ],
    defaultSort: { key: "totalCents", dir: "desc" },
    async run(ctx) {
      const [bills, control] = await Promise.all([
        db.supplierInvoice.findMany({
          where: { companyId: ctx.companyId, status: { in: ["UNPAID", "PARTIALLY_PAID"] } },
          select: {
            totalCents: true,
            paidCents: true,
            dueDate: true,
            supplier: { select: { id: true, code: true, name: true } },
          },
        }),
        trialBalance(ctx.companyId),
      ]);

      const bySupplier = new Map<string, ReportRow & Record<string, number | string>>();
      for (const bill of bills) {
        const row =
          bySupplier.get(bill.supplier.id) ??
          ({
            code: bill.supplier.code,
            supplier: bill.supplier.name,
            currentCents: 0,
            d1_30Cents: 0,
            d31_60Cents: 0,
            d61_90Cents: 0,
            d90PlusCents: 0,
            totalCents: 0,
          } as ReportRow & Record<string, number | string>);
        const due = bill.totalCents - bill.paidCents;
        const column = ageColumn(bill.dueDate, ctx.now);
        row[column] = (row[column] as number) + due;
        row.totalCents = (row.totalCents as number) + due;
        bySupplier.set(bill.supplier.id, row);
      }

      const rows = [...bySupplier.values()];
      const total = rows.reduce((n, r) => n + (r.totalCents as number), 0);
      const ledger = control.find((r) => r.code === "2000")?.balanceCents ?? 0;
      return {
        rows,
        summary: [
          { label: "Total payable", value: total, kind: "money" },
          { label: "Accounts payable in the ledger", value: ledger, kind: "money" },
          {
            label: "Difference",
            value: total - ledger,
            kind: "money",
            tone: total === ledger ? "success" : "danger",
            hint: total === ledger ? "Agrees with the ledger" : "See the control account reconciliation",
          },
        ],
      };
    },
  },
  {
    key: "control-reconciliation",
    title: "Control account reconciliation",
    description: "Whether receivables, payables and stock agree with the detail behind them.",
    group: "accounting",
    module: "FINANCE",
    permissions: FINANCIAL,
    usesPeriod: false,
    columns: [
      { key: "control", label: "Control account" },
      { key: "detail", label: "Compared with", hideBelow: "md" },
      { key: "ledgerCents", label: "Ledger", kind: "money" },
      { key: "detailCents", label: "Detail", kind: "money" },
      { key: "differenceCents", label: "Difference", kind: "money" },
      { key: "state", label: "State", kind: "status" },
    ],
    async run(ctx) {
      const [tb, customers, suppliers, stock] = await Promise.all([
        trialBalance(ctx.companyId),
        db.customer.aggregate({ where: { companyId: ctx.companyId }, _sum: { balanceCents: true } }),
        db.supplierInvoice.findMany({
          where: { companyId: ctx.companyId, status: { in: ["UNPAID", "PARTIALLY_PAID"] } },
          select: { totalCents: true, paidCents: true },
        }),
        stockValuation(ctx.companyId),
      ]);
      await systemAccounts(ctx.companyId, ["ACCOUNTS_RECEIVABLE"]);
      const at = (code: string) => tb.find((r) => r.code === code)?.balanceCents ?? 0;
      const row = (control: string, detail: string, ledgerCents: number, detailCents: number) => ({
        control,
        detail,
        ledgerCents,
        detailCents,
        differenceCents: ledgerCents - detailCents,
        state: ledgerCents === detailCents ? "AGREES" : "DIFFERS",
      });
      const rows = [
        row("1200 Accounts receivable", "Customer balances", at("1200"), customers._sum.balanceCents ?? 0),
        row(
          "2000 Accounts payable",
          "Unpaid supplier bills",
          at("2000"),
          suppliers.reduce((n, b) => n + b.totalCents - b.paidCents, 0),
        ),
        row("1300 Inventory", "Stock on hand at current cost", at("1300"), stock.totalCents),
      ];
      const differing = rows.filter((r) => r.state !== "AGREES");
      return {
        rows,
        summary: [
          {
            label: "Accounts that differ",
            value: differing.length,
            kind: "int",
            tone: differing.length === 0 ? "success" : "danger",
          },
          {
            label: "Goods received, not yet billed",
            value: at("2200"),
            kind: "money",
            hint: "Stock received with no supplier bill entered yet",
          },
        ],
      };
    },
  },
];
