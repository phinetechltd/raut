import { handler } from "@/lib/api";
import { csvMoney, csvResponse } from "@/lib/csv";
import { companyIdOf } from "@/lib/tenant";
import { stockValuation } from "@/server/reports";

export const dynamic = "force-dynamic";

/**
 * What the stock on hand is worth, and whether the inventory account agrees.
 *
 * `variesBy` is the point of the report. The two figures are computed from
 * different places — quantities from stock, the balance from posted movements —
 * so any difference means goods moved without being booked.
 */
export const GET = handler(
  { permission: "report:financial" },
  async ({ principal, searchParams }) => {
    const companyId = companyIdOf(principal);
    const report = await stockValuation(companyId);

    if (searchParams.get("format") !== "csv") return report;

    const rows: (string | number)[][] = [
      ["Stock valuation", new Date().toISOString().slice(0, 10)],
      [],
      ["Location", "SKU", "Product", "Quantity", "Unit cost", "Value"],
      ...report.rows.map((r) => [
        r.locationName,
        r.sku,
        r.name,
        r.quantity,
        csvMoney(r.unitCostCents),
        csvMoney(r.valueCents),
      ]),
      [],
      ["", "", "", "", "Total at cost", csvMoney(report.totalCents)],
      ["", "", "", "", "Inventory account (1300)", csvMoney(report.ledgerCents)],
      [
        "",
        "",
        "",
        "",
        "Difference",
        report.variesBy === 0 ? "none" : csvMoney(report.variesBy),
      ],
    ];

    return csvResponse(
      `stock-valuation-${new Date().toISOString().slice(0, 10)}.csv`,
      rows,
    );
  },
);
