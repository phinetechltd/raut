import "server-only";

import { db } from "@/lib/db";
import { type AccountType, type TrialBalanceRow, trialBalance } from "./ledger";

/**
 * The financial reports.
 *
 * Every one of these reads from `trialBalance` and nothing else. That is the
 * whole design: reports built from separate queries over the operational tables
 * drift apart, and the day a director notices the P&L and the balance sheet
 * disagree is the day they stop trusting all of it. Sharing one source makes
 * agreement structural rather than something to keep re-checking.
 */

export interface Period {
  from: Date;
  to: Date;
}

/** A month, in the calendar sense, from a YYYY-MM string. */
export function monthPeriod(ym: string): Period {
  const [y, m] = ym.split("-").map(Number);
  return {
    from: new Date(Date.UTC(y, m - 1, 1, 0, 0, 0, 0)),
    to: new Date(Date.UTC(y, m, 0, 23, 59, 59, 999)),
  };
}

/** The financial year to date, on a calendar year. */
export function yearToDate(now = new Date()): Period {
  return { from: new Date(Date.UTC(now.getUTCFullYear(), 0, 1)), to: now };
}

/** The equivalent stretch immediately before a period, for comparatives. */
export function priorPeriod(p: Period): Period {
  const span = p.to.getTime() - p.from.getTime();
  return {
    from: new Date(p.from.getTime() - span - 1),
    to: new Date(p.from.getTime() - 1),
  };
}

const sumOf = (rows: TrialBalanceRow[], type: AccountType) =>
  rows.filter((r) => r.type === type).reduce((n, r) => n + r.balanceCents, 0);

const nonZero = (rows: TrialBalanceRow[]) => rows.filter((r) => r.balanceCents !== 0);

export interface ReportLine {
  code: string;
  name: string;
  amountCents: number;
}

const asLine = (r: TrialBalanceRow, sign: 1 | -1 = 1): ReportLine => ({
  code: r.code,
  name: r.name,
  amountCents: sign * r.balanceCents,
});

// ---------------------------------------------------------------------------
// Profit and loss
// ---------------------------------------------------------------------------

export interface ProfitAndLoss {
  period: Period;
  revenue: ReportLine[];
  revenueTotal: number;
  costOfSales: ReportLine[];
  costOfSalesTotal: number;
  grossProfit: number;
  grossMarginBp: number;
  expenses: ReportLine[];
  expensesTotal: number;
  netProfit: number;
  netMarginBp: number;
  prior?: { revenueTotal: number; grossProfit: number; netProfit: number };
}

/**
 * Income less cost of sales less expenses, for a period.
 *
 * Cost of sales is separated from the other expenses by account code (5xxx)
 * rather than by account type, because gross margin is the number a distributor
 * actually manages and burying cost of sales in with rent makes it unreadable.
 */
export async function profitAndLoss(
  companyId: string,
  period: Period,
  opts: { comparatives?: boolean } = {},
): Promise<ProfitAndLoss> {
  const rows = await trialBalance(companyId, period);

  const isCostOfSales = (r: TrialBalanceRow) => r.type === "EXPENSE" && r.code.startsWith("5");

  const revenue = nonZero(rows.filter((r) => r.type === "INCOME"));
  const costOfSales = nonZero(rows.filter(isCostOfSales));
  const expenses = nonZero(rows.filter((r) => r.type === "EXPENSE" && !isCostOfSales(r)));

  const revenueTotal = revenue.reduce((n, r) => n + r.balanceCents, 0);
  const costOfSalesTotal = costOfSales.reduce((n, r) => n + r.balanceCents, 0);
  const expensesTotal = expenses.reduce((n, r) => n + r.balanceCents, 0);
  const grossProfit = revenueTotal - costOfSalesTotal;
  const netProfit = grossProfit - expensesTotal;

  // Basis points rather than a float: margins are shown to one decimal, and
  // rounding a float in two different places is how 60.0% on one page becomes
  // 59.9% on the next.
  const bp = (part: number, whole: number) =>
    whole === 0 ? 0 : Math.round((part / whole) * 10_000);

  let prior: ProfitAndLoss["prior"];
  if (opts.comparatives) {
    const p = await profitAndLoss(companyId, priorPeriod(period));
    prior = { revenueTotal: p.revenueTotal, grossProfit: p.grossProfit, netProfit: p.netProfit };
  }

  return {
    period,
    revenue: revenue.map((r) => asLine(r)),
    revenueTotal,
    costOfSales: costOfSales.map((r) => asLine(r)),
    costOfSalesTotal,
    grossProfit,
    grossMarginBp: bp(grossProfit, revenueTotal),
    expenses: expenses.map((r) => asLine(r)),
    expensesTotal,
    netProfit,
    netMarginBp: bp(netProfit, revenueTotal),
    prior,
  };
}

// ---------------------------------------------------------------------------
// Balance sheet
// ---------------------------------------------------------------------------

export interface BalanceSheet {
  asOf: Date;
  assets: ReportLine[];
  assetsTotal: number;
  liabilities: ReportLine[];
  liabilitiesTotal: number;
  equity: ReportLine[];
  equityTotal: number;
  /** Profit not yet closed to reserves. Part of equity. */
  currentEarnings: number;
  balanced: boolean;
  differenceCents: number;
}

/**
 * Assets, liabilities and equity as at a date.
 *
 * One subtlety carries the whole report: income and expense accounts are never
 * closed off, so profit earned to date sits in them rather than in equity. It
 * has to be carried into the equity section explicitly or the sheet does not
 * balance — the commonest bug in a hand-rolled balance sheet.
 */
export async function balanceSheet(companyId: string, asOf: Date): Promise<BalanceSheet> {
  const rows = await trialBalance(companyId, { to: asOf });

  const assets = nonZero(rows.filter((r) => r.type === "ASSET"));
  const liabilities = nonZero(rows.filter((r) => r.type === "LIABILITY"));
  const equityAccounts = nonZero(rows.filter((r) => r.type === "EQUITY"));

  const currentEarnings = sumOf(rows, "INCOME") - sumOf(rows, "EXPENSE");

  const assetsTotal = assets.reduce((n, r) => n + r.balanceCents, 0);
  const liabilitiesTotal = liabilities.reduce((n, r) => n + r.balanceCents, 0);
  const equityTotal = equityAccounts.reduce((n, r) => n + r.balanceCents, 0) + currentEarnings;
  const difference = assetsTotal - (liabilitiesTotal + equityTotal);

  return {
    asOf,
    assets: assets.map((r) => asLine(r)),
    assetsTotal,
    liabilities: liabilities.map((r) => asLine(r)),
    liabilitiesTotal,
    equity: [
      ...equityAccounts.map((r) => asLine(r)),
      { code: "3910", name: "Profit for the period", amountCents: currentEarnings },
    ],
    equityTotal,
    currentEarnings,
    balanced: difference === 0,
    differenceCents: difference,
  };
}

// ---------------------------------------------------------------------------
// Cash flow
// ---------------------------------------------------------------------------

export interface CashFlow {
  period: Period;
  netProfit: number;
  workingCapital: ReportLine[];
  workingCapitalTotal: number;
  equityMovements: ReportLine[];
  equityMovementsTotal: number;
  netMovement: number;
  /** The movement the cash accounts actually show. Must equal netMovement. */
  actualMovement: number;
  opening: number;
  closing: number;
  reconciles: boolean;
}

const CASH_CODES = ["1000", "1010", "1050"];

/**
 * Where the cash went, by the indirect method.
 *
 * Profit for the period, adjusted for the movement in everything that is not
 * cash. Because every entry balances, this identity holds exactly:
 *
 *   change in cash = profit + change in liabilities + change in equity
 *                    less change in other assets
 *
 * so `reconciles` should never be false. It is computed and shown anyway — a
 * cash flow that quietly plugs its own difference is worse than one that admits
 * it disagrees.
 */
export async function cashFlow(companyId: string, period: Period): Promise<CashFlow> {
  const movement = await trialBalance(companyId, period);
  const isCash = (r: TrialBalanceRow) => CASH_CODES.includes(r.code);

  const netProfit = sumOf(movement, "INCOME") - sumOf(movement, "EXPENSE");

  // An increase in a non-cash asset consumes cash; an increase in a liability
  // releases it. Hence the opposite signs.
  const otherAssets = nonZero(movement.filter((r) => r.type === "ASSET" && !isCash(r)));
  const liabilities = nonZero(movement.filter((r) => r.type === "LIABILITY"));

  const workingCapital = [
    ...otherAssets.map((r) => asLine(r, -1)),
    ...liabilities.map((r) => asLine(r, 1)),
  ];
  const workingCapitalTotal = workingCapital.reduce((n, r) => n + r.amountCents, 0);

  const equityMovements = nonZero(movement.filter((r) => r.type === "EQUITY")).map((r) =>
    asLine(r, 1),
  );
  const equityMovementsTotal = equityMovements.reduce((n, r) => n + r.amountCents, 0);

  const netMovement = netProfit + workingCapitalTotal + equityMovementsTotal;
  const actualMovement = movement.filter(isCash).reduce((n, r) => n + r.balanceCents, 0);

  const openingRows = await trialBalance(companyId, {
    to: new Date(period.from.getTime() - 1),
  });
  const opening = openingRows.filter(isCash).reduce((n, r) => n + r.balanceCents, 0);

  return {
    period,
    netProfit,
    workingCapital,
    workingCapitalTotal,
    equityMovements,
    equityMovementsTotal,
    netMovement,
    actualMovement,
    opening,
    closing: opening + actualMovement,
    reconciles: netMovement === actualMovement,
  };
}

// ---------------------------------------------------------------------------
// VAT
// ---------------------------------------------------------------------------

export interface VatSummary {
  period: Period;
  outputCents: number;
  inputCents: number;
  payableCents: number;
  salesCents: number;
  /** True when more VAT was reclaimed than charged — a refund, not a payment. */
  refundDue: boolean;
}

/**
 * Output tax less input tax for a period — the figures an eTIMS return is built
 * from. Taken from the ledger rather than re-summed off the invoices, so it can
 * never disagree with the VAT liability on the balance sheet.
 */
export async function vatSummary(companyId: string, period: Period): Promise<VatSummary> {
  const rows = await trialBalance(companyId, period);
  const at = (code: string) => rows.find((r) => r.code === code)?.balanceCents ?? 0;

  const outputCents = at("2100");
  const inputCents = at("2110");
  const payableCents = outputCents - inputCents;

  return {
    period,
    outputCents,
    inputCents,
    payableCents,
    salesCents: sumOf(rows, "INCOME"),
    refundDue: payableCents < 0,
  };
}

// ---------------------------------------------------------------------------
// Stock valuation
// ---------------------------------------------------------------------------

export interface StockValuationRow {
  locationId: string;
  locationName: string;
  productId: string;
  sku: string;
  name: string;
  quantity: number;
  unitCostCents: number;
  valueCents: number;
}

export interface StockValuation {
  rows: StockValuationRow[];
  totalCents: number;
  /** The inventory account balance, which this should equal. */
  ledgerCents: number;
  variesBy: number;
}

/**
 * What the stock on hand is worth, and whether the ledger agrees.
 *
 * The two are computed from different places on purpose — quantities from
 * StockItem, the ledger from posted movements — so a difference is a real
 * signal that stock moved without being booked. Reporting only one of them
 * would hide exactly the problem this exists to catch.
 */
export async function stockValuation(companyId: string): Promise<StockValuation> {
  const items = await db.stockItem.findMany({
    where: { companyId, quantity: { not: 0 } },
    include: {
      product: { select: { sku: true, name: true, costPriceCents: true, trackStock: true } },
      location: { select: { name: true } },
    },
    orderBy: [{ locationId: "asc" }, { productId: "asc" }],
  });

  const rows = items
    .filter((i) => i.product.trackStock)
    .map((i) => ({
      locationId: i.locationId,
      locationName: i.location.name,
      productId: i.productId,
      sku: i.product.sku,
      name: i.product.name,
      quantity: i.quantity,
      unitCostCents: i.product.costPriceCents,
      valueCents: i.quantity * i.product.costPriceCents,
    }));

  const totalCents = rows.reduce((n, r) => n + r.valueCents, 0);

  const tb = await trialBalance(companyId);
  const ledgerCents = tb.find((r) => r.code === "1300")?.balanceCents ?? 0;

  return { rows, totalCents, ledgerCents, variesBy: totalCents - ledgerCents };
}

// ---------------------------------------------------------------------------
// Request plumbing
// ---------------------------------------------------------------------------

/**
 * Reads a period off a query string.
 *
 * Accepts `?month=2026-08`, an explicit `?from=&to=`, or nothing at all, which
 * means the year to date. Dates are parsed as UTC days and the end is pushed to
 * the last millisecond, because `to=2026-08-31` parsed as midnight silently
 * excludes everything that happened on the 31st.
 */
export function periodFromParams(sp: URLSearchParams): Period {
  const month = sp.get("month");
  if (month && /^\d{4}-\d{2}$/.test(month)) return monthPeriod(month);

  const from = sp.get("from");
  const to = sp.get("to");
  if (from || to) {
    return {
      from: from ? new Date(`${from}T00:00:00.000Z`) : new Date(Date.UTC(1970, 0, 1)),
      to: to ? new Date(`${to}T23:59:59.999Z`) : new Date(),
    };
  }
  return yearToDate();
}

/** `2026-08-01 to 2026-08-31`, for a report header or a filename. */
export function describePeriod(p: Period): string {
  const d = (x: Date) => x.toISOString().slice(0, 10);
  return `${d(p.from)} to ${d(p.to)}`;
}
