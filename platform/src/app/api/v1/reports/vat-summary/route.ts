import { handler } from "@/lib/api";
import { csvMoney, csvResponse } from "@/lib/csv";
import { companyIdOf } from "@/lib/tenant";
import { describePeriod, periodFromParams, vatSummary } from "@/server/reports";

export const dynamic = "force-dynamic";

/**
 * Output tax less input tax for a period.
 *
 * These are the figures a KRA return is built from, so they come off the ledger
 * rather than being re-summed from the invoices. Two independent sums of the
 * same tax is how a return ends up disagreeing with the balance sheet.
 */
export const GET = handler({ permission: "report:financial" }, async ({ principal, searchParams }) => {
  const companyId = companyIdOf(principal);
  const period = periodFromParams(searchParams);

  const report = await vatSummary(companyId, period);

  if (searchParams.get("format") !== "csv") return report;

  const rows: (string | number)[][] = [
    ["VAT summary", describePeriod(period)],
    [],
    ["Item", "Amount"],
    ["Taxable sales (excluding VAT)", csvMoney(report.salesCents)],
    ["Output VAT charged", csvMoney(report.outputCents)],
    ["Input VAT recoverable", csvMoney(report.inputCents)],
    [
      report.refundDue ? "VAT refundable" : "VAT payable",
      csvMoney(Math.abs(report.payableCents)),
    ],
  ];

  return csvResponse(`vat-summary-${describePeriod(period)}.csv`, rows);
});
