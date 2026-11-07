import { ApiError, handler, notFound } from "@/lib/api";
import { auditAs } from "@/lib/audit";
import { csvResponse } from "@/lib/csv";
import { MODULE_CATALOG } from "@/lib/modules";
import { can } from "@/lib/rbac";
import { nairobiDate, reportCsvRows } from "@/lib/report-engine";
import { canRunReport, reportByKey, runReport } from "@/server/report-library";

export const dynamic = "force-dynamic";

/**
 * One report, as JSON or with `?format=csv`. Query: `range` or `month` or
 * `from`/`to`, `q`, `sort`, `dir`, `f_<field>` and `s_<select>`. Rows are the
 * whole result and not one page, so an export is never a partial copy.
 */
export const GET = handler<{ key: string }>({}, async ({ principal, params, searchParams, request }) => {
  const report = reportByKey(params.key);
  if (!report) throw notFound("Report not found");

  if (!canRunReport(principal, report)) {
    const unlicensed = report.module && !principal.enabledModules.has(report.module);
    if (unlicensed && report.permissions.every((p) => !can(principal, p) || p.startsWith("report"))) {
      throw new ApiError(402, "MODULE_NOT_LICENSED", `${MODULE_CATALOG[report.module!].name} is not part of your subscription.`);
    }
    throw new ApiError(403, "FORBIDDEN", "Your role does not permit this report.");
  }

  const run = await runReport(report, principal, Object.fromEntries(searchParams.entries()));
  const periodLabel = run.range
    ? run.range.from && run.range.to
      ? `${nairobiDate(run.range.from)} to ${nairobiDate(run.range.to)}`
      : run.range.label
    : `As at ${nairobiDate()}`;

  if (searchParams.get("format") === "csv") {
    await auditAs(principal, "EXPORT", "Report", report.key, { period: periodLabel, rows: run.rows.length }, request);
    return csvResponse(
      `${report.key}-${periodLabel.replaceAll(" ", "-")}.csv`,
      reportCsvRows(report.title, periodLabel, run.rows, report.columns, run.output.summary),
    );
  }

  return {
    key: report.key,
    title: report.title,
    period: periodLabel,
    from: run.range?.from ?? null,
    to: run.range?.to ?? null,
    columns: report.columns.map((c) => ({ key: c.key, label: c.label, kind: c.kind ?? "text", total: c.total ?? false })),
    summary: run.output.summary ?? [],
    notes: run.output.notes ?? [],
    truncated: run.output.truncated ?? false,
    totals: run.totals,
    rows: run.rows,
  };
});
