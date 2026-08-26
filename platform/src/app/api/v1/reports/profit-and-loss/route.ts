import { handler } from "@/lib/api";
import { csvMoney, csvResponse } from "@/lib/csv";
import { companyIdOf } from "@/lib/tenant";
import { describePeriod, periodFromParams, profitAndLoss } from "@/server/reports";

export const dynamic = "force-dynamic";

/** Income less cost of sales less expenses, from the ledger. */
export const GET = handler({ permission: "report:financial" }, async ({ principal, searchParams }) => {
  const companyId = companyIdOf(principal);
  const period = periodFromParams(searchParams);

  const report = await profitAndLoss(companyId, period, {
    comparatives: searchParams.get("comparatives") === "true",
  });

  if (searchParams.get("format") !== "csv") return report;

  const rows: (string | number)[][] = [
    ["Profit and loss", describePeriod(period)],
    [],
    ["Code", "Account", "Amount"],
    ["", "REVENUE", ""],
    ...report.revenue.map((l) => [l.code, l.name, csvMoney(l.amountCents)]),
    ["", "Total revenue", csvMoney(report.revenueTotal)],
    [],
    ["", "COST OF SALES", ""],
    ...report.costOfSales.map((l) => [l.code, l.name, csvMoney(l.amountCents)]),
    ["", "Total cost of sales", csvMoney(report.costOfSalesTotal)],
    [],
    ["", "Gross profit", csvMoney(report.grossProfit)],
    ["", "Gross margin %", (report.grossMarginBp / 100).toFixed(1)],
    [],
    ["", "EXPENSES", ""],
    ...report.expenses.map((l) => [l.code, l.name, csvMoney(l.amountCents)]),
    ["", "Total expenses", csvMoney(report.expensesTotal)],
    [],
    ["", "Net profit", csvMoney(report.netProfit)],
    ["", "Net margin %", (report.netMarginBp / 100).toFixed(1)],
  ];

  return csvResponse(`profit-and-loss-${describePeriod(period)}.csv`, rows);
});
