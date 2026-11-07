import { notFound } from "next/navigation";

import { PrintButton } from "@/components/print/print-button";
import { db } from "@/lib/db";
import { formatCell, nairobiDate } from "@/lib/report-engine";
import { requireTenant } from "@/lib/session";
import { canRunReport, reportByKey, runReport } from "@/server/report-library";

export const dynamic = "force-dynamic";

const NUMERIC = new Set(["money", "int", "decimal", "pct"]);

/**
 * A report on paper: every matching row and not just one page, in the company's
 * name, with the same figures as the screen because it comes from the same run.
 */
export default async function PrintReportPage({
  params: routeParams,
  searchParams,
}: {
  params: Promise<{ key: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { principal, companyId } = await requireTenant();
  const { key } = await routeParams;
  const report = reportByKey(key);
  if (!report || !canRunReport(principal, report)) notFound();

  const params = await searchParams;
  const [run, company] = await Promise.all([
    runReport(report, principal, params),
    db.company.findUniqueOrThrow({ where: { id: companyId }, select: { name: true } }),
  ]);

  const period = run.range
    ? run.range.from && run.range.to
      ? `${nairobiDate(run.range.from)} to ${nairobiDate(run.range.to)}`
      : run.range.label
    : `As at ${nairobiDate()}`;
  const hasTotals = Object.keys(run.totals).length > 0;

  return (
    <div className="print-doc mx-auto w-full px-6 py-6 print:p-0">
      <style>{`@page { size: A4 landscape; margin: 12mm; }`}</style>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3" data-print-hidden>
        <p className="text-sm text-content-muted">
          Use your browser&apos;s print dialog to print or save this report as a PDF.
        </p>
        <PrintButton auto={params.autoprint === "1"} />
      </div>

      <article className="print-paper bg-white text-[12px] leading-snug text-content">
        <header className="mb-4 border-b border-border pb-3">
          <p className="text-sm font-semibold">{company.name}</p>
          <h1 className="text-xl font-semibold">{report.title}</h1>
          <p className="text-content-secondary">{period}</p>
        </header>

        {(run.output.notes ?? []).map((note) => (
          <p key={note.text} className="mb-2 text-content-secondary">
            {note.text}
          </p>
        ))}
        {run.output.truncated ? (
          <p className="mb-2 font-semibold">Incomplete: this report reached its limit of 20,000 rows.</p>
        ) : null}

        {run.output.summary?.length ? (
          <dl className="mb-4 flex flex-wrap gap-x-8 gap-y-2">
            {run.output.summary.map((item) => (
              <div key={item.label}>
                <dt className="text-[10px] uppercase tracking-wider text-content-muted">{item.label}</dt>
                <dd className="font-semibold">
                  {typeof item.value === "number" ? formatCell(item.value, item.kind ?? "int") : item.value}
                </dd>
              </div>
            ))}
          </dl>
        ) : null}

        <table className="print-table w-full border-collapse">
          <thead>
            <tr className="border-b-2 border-border text-left">
              {report.columns.map((c) => (
                <th key={c.key} className={`px-1.5 py-1 ${NUMERIC.has(c.kind ?? "text") ? "text-right" : ""}`}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {run.rows.map((row, index) => (
              <tr key={index} className="border-b border-border">
                {report.columns.map((c) => (
                  <td key={c.key} className={`px-1.5 py-1 ${NUMERIC.has(c.kind ?? "text") ? "text-right" : ""}`}>
                    {formatCell(row[c.key], c.kind)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
          {hasTotals ? (
            <tfoot>
              <tr className="border-t-2 border-border font-semibold">
                {report.columns.map((c, index) => (
                  <td key={c.key} className={`px-1.5 py-1 ${NUMERIC.has(c.kind ?? "text") ? "text-right" : ""}`}>
                    {c.key in run.totals ? formatCell(run.totals[c.key], c.kind) : index === 0 ? "Total" : ""}
                  </td>
                ))}
              </tr>
            </tfoot>
          ) : null}
        </table>
        <p className="mt-4 text-[10px] text-content-muted">
          Printed {new Date().toLocaleString("en-KE", { timeZone: "Africa/Nairobi" })} · {run.rows.length} rows
        </p>
      </article>
    </div>
  );
}
