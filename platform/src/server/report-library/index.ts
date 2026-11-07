import "server-only";

import type { Principal } from "@/lib/rbac";
import {
  applyRowFilters,
  filterOptions,
  reportRange,
  searchRows,
  sortReportRows,
  totalsFor,
  type ReportOutput,
  type ReportRange,
  type ReportRow,
} from "@/lib/report-engine";

import { accountingReports } from "./accounting";
import { customerReports, salesReports } from "./commerce";
import { fieldReports, financeReports, inventoryReports, procurementReports, routingReports, smsReports } from "./operations";
import { taxReports } from "./tax";
import { canRunReport, type ReportDefinition, type ReportLink } from "./types";

export { REPORT_GROUPS, canRunReport } from "./types";
export type { ReportDefinition, ReportLink, ReportGroup } from "./types";

export const REPORTS: ReportDefinition[] = [
  ...accountingReports,
  ...taxReports,
  ...salesReports,
  ...customerReports,
  ...inventoryReports,
  ...procurementReports,
  ...financeReports,
  ...fieldReports,
  ...routingReports,
  ...smsReports,
];

/** Full statements with their own layout, listed beside the tabular reports. */
export const REPORT_LINKS: ReportLink[] = [
  {
    key: "profit-and-loss",
    title: "Profit and loss statement",
    description: "Revenue less cost of sales and expenses, with comparatives.",
    group: "accounting",
    module: "FINANCE",
    permissions: ["report:financial"],
    href: "/app/finance/reports?report=pl",
  },
  {
    key: "balance-sheet",
    title: "Balance sheet",
    description: "Assets, liabilities and equity as they stand, checked to balance.",
    group: "accounting",
    module: "FINANCE",
    permissions: ["report:financial"],
    href: "/app/finance/reports?report=balance",
  },
  {
    key: "cash-flow",
    title: "Cash flow statement",
    description: "Where the cash went, reconciled to the movement in cash and bank.",
    group: "accounting",
    module: "FINANCE",
    permissions: ["report:financial"],
    href: "/app/finance/reports?report=cash",
  },
  {
    key: "stock-valuation",
    title: "Stock valuation",
    description: "Stock on hand at cost, compared with the inventory account.",
    group: "inventory",
    module: "INVENTORY",
    permissions: ["report:financial"],
    href: "/app/finance/reports?report=stock",
  },
];

const byKey = new Map(REPORTS.map((r) => [r.key, r]));

export function reportByKey(key: string): ReportDefinition | undefined {
  return byKey.get(key);
}

export interface ReportRun {
  report: ReportDefinition;
  range: ReportRange | null;
  output: ReportOutput;
  /** After the search and row filters, before paging. */
  rows: ReportRow[];
  totals: Record<string, number>;
  filterChoices: Array<{ key: string; allLabel: string; options: Array<{ value: string; label: string }> }>;
  selectChoices: Array<{ key: string; allLabel: string; options: Array<{ value: string; label: string }> }>;
  sort: { key: string | null; dir: "asc" | "desc" };
}

/**
 * Runs a report for one person. The console page, the CSV export and the printed
 * copy all come through here, so they cannot show different figures.
 */
export async function runReport(
  report: ReportDefinition,
  principal: Principal,
  params: Record<string, string | undefined>,
  now: Date = new Date(),
): Promise<ReportRun> {
  const range = report.usesPeriod ? reportRange(params, now, report.defaultRange ?? "this-month") : null;
  const output = await report.run({
    companyId: principal.companyId!,
    principal,
    from: range?.from ?? null,
    to: range?.to ?? null,
    now,
    params,
  });

  const filters = report.filters ?? [];
  const filtered = applyRowFilters(searchRows(output.rows, report.columns, params.q), filters, params);

  const allowed = new Set(report.columns.map((c) => c.key));
  const sortKey = params.sort && allowed.has(params.sort) ? params.sort : report.defaultSort?.key ?? null;
  const dir = params.dir === "asc" || params.dir === "desc" ? params.dir : report.defaultSort?.dir ?? "asc";

  const selectChoices = await Promise.all(
    (report.selects ?? []).map(async (s) => ({
      key: s.key,
      allLabel: s.allLabel,
      options: await s.load(principal.companyId!),
    })),
  );

  return {
    report,
    range,
    output,
    rows: sortReportRows(filtered, sortKey, dir),
    totals: totalsFor(filtered, report.columns),
    filterChoices: filters.map((f) => ({
      key: f.key,
      allLabel: f.allLabel,
      options: filterOptions(output.rows, f.key),
    })),
    selectChoices,
    sort: { key: sortKey, dir },
  };
}

export function visibleCatalogue(principal: Principal) {
  return {
    reports: REPORTS.filter((r) => canRunReport(principal, r)),
    links: REPORT_LINKS.filter((l) => canRunReport(principal, l)),
  };
}
