import { handler } from "@/lib/api";
import { csvMoney, csvResponse } from "@/lib/csv";
import { companyIdOf } from "@/lib/tenant";
import { balanceSheet } from "@/server/reports";

export const dynamic = "force-dynamic";

/**
 * Assets, liabilities and equity as at a date.
 *
 * `balanced` is the field to check. Assets must equal liabilities plus equity;
 * if they do not, something was posted that this report cannot classify and the
 * figures should not be relied on.
 */
export const GET = handler({ permission: "report:financial" }, async ({ principal, searchParams }) => {
  const companyId = companyIdOf(principal);

  const asOfParam = searchParams.get("asOf");
  const asOf = asOfParam ? new Date(`${asOfParam}T23:59:59.999Z`) : new Date();

  const report = await balanceSheet(companyId, asOf);

  if (searchParams.get("format") !== "csv") return report;

  const day = asOf.toISOString().slice(0, 10);
  const rows: (string | number)[][] = [
    ["Balance sheet", `as at ${day}`],
    [],
    ["Code", "Account", "Amount"],
    ["", "ASSETS", ""],
    ...report.assets.map((l) => [l.code, l.name, csvMoney(l.amountCents)]),
    ["", "Total assets", csvMoney(report.assetsTotal)],
    [],
    ["", "LIABILITIES", ""],
    ...report.liabilities.map((l) => [l.code, l.name, csvMoney(l.amountCents)]),
    ["", "Total liabilities", csvMoney(report.liabilitiesTotal)],
    [],
    ["", "EQUITY", ""],
    ...report.equity.map((l) => [l.code, l.name, csvMoney(l.amountCents)]),
    ["", "Total equity", csvMoney(report.equityTotal)],
    [],
    ["", "Liabilities and equity", csvMoney(report.liabilitiesTotal + report.equityTotal)],
    ["", "Balanced", report.balanced ? "yes" : `NO - out by ${csvMoney(report.differenceCents)}`],
  ];

  return csvResponse(`balance-sheet-${day}.csv`, rows);
});
