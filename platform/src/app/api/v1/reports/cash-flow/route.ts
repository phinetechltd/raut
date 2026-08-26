import { handler } from "@/lib/api";
import { csvMoney, csvResponse } from "@/lib/csv";
import { companyIdOf } from "@/lib/tenant";
import { cashFlow, describePeriod, periodFromParams } from "@/server/reports";

export const dynamic = "force-dynamic";

/** Where the cash went, by the indirect method. */
export const GET = handler({ permission: "report:financial" }, async ({ principal, searchParams }) => {
  const companyId = companyIdOf(principal);
  const period = periodFromParams(searchParams);

  const report = await cashFlow(companyId, period);

  if (searchParams.get("format") !== "csv") return report;

  const rows: (string | number)[][] = [
    ["Cash flow", describePeriod(period)],
    [],
    ["Code", "Item", "Amount"],
    ["", "Net profit for the period", csvMoney(report.netProfit)],
    [],
    ["", "WORKING CAPITAL", ""],
    ...report.workingCapital.map((l) => [l.code, l.name, csvMoney(l.amountCents)]),
    ["", "Net working capital movement", csvMoney(report.workingCapitalTotal)],
    ...(report.equityMovements.length > 0
      ? ([
          [],
          ["", "EQUITY", ""],
          ...report.equityMovements.map((l) => [l.code, l.name, csvMoney(l.amountCents)]),
        ] as (string | number)[][])
      : []),
    [],
    ["", "Net movement in cash", csvMoney(report.netMovement)],
    ["", "Opening cash", csvMoney(report.opening)],
    ["", "Closing cash", csvMoney(report.closing)],
    [
      "",
      "Reconciles to the cash accounts",
      report.reconciles
        ? "yes"
        : `NO - out by ${csvMoney(report.netMovement - report.actualMovement)}`,
    ],
  ];

  return csvResponse(`cash-flow-${describePeriod(period)}.csv`, rows);
});
