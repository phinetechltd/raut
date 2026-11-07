import Link from "next/link";
import { notFound } from "next/navigation";

import {
  ButtonLink,
  Callout,
  DataTable,
  DateRangeBar,
  ExportLink,
  FilterBar,
  FilterSearch,
  FilterSelect,
  ModuleLocked,
  PageHeader,
  StatCard,
  StatGrid,
  StatusBadge,
  type Column,
} from "@/components/ui";
import {
  REPORT_RANGE_PRESETS,
  formatCell,
  nairobiDate,
  type ReportColumn,
  type ReportRow,
} from "@/lib/report-engine";
import { requireTenant } from "@/lib/session";
import { pageOf, preserved, tableHref, tableState } from "@/lib/table";
import { canRunReport, reportByKey, runReport } from "@/server/report-library";

export const dynamic = "force-dynamic";

const NUMERIC = new Set(["money", "int", "decimal", "pct"]);

const HIDE_CLASS = {
  sm: "hidden sm:table-cell",
  md: "hidden md:table-cell",
  lg: "hidden lg:table-cell",
} as const;

function Cell({ row, column }: { row: ReportRow; column: ReportColumn }) {
  const value = row[column.key];
  if (column.kind === "status" && value) return <StatusBadge status={String(value)} />;
  const text = formatCell(value, column.kind);
  const mono = column.kind === "mono" ? "font-mono text-xs" : "";
  const href = column.hrefKey ? row[column.hrefKey] : null;
  if (typeof href === "string") {
    return (
      <Link href={href} className={`${mono} hover:underline`}>
        {text}
      </Link>
    );
  }
  return <span className={mono}>{text}</span>;
}

/** One screen for every report in the library: filters, table, totals, export, print. */
export default async function ReportPage({
  params: routeParams,
  searchParams,
}: {
  params: Promise<{ key: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { principal } = await requireTenant();
  const { key } = await routeParams;
  const report = reportByKey(key);
  if (!report) notFound();

  if (report.module && !principal.enabledModules.has(report.module) && principal.role !== "SUPER_ADMIN") {
    return <ModuleLocked module={report.module} />;
  }
  if (!canRunReport(principal, report)) notFound();

  const params = await searchParams;
  const run = await runReport(report, principal, params);
  const path = `/app/report-centre/${key}`;

  const ts = tableState(params, {
    allowed: report.columns.map((c) => c.key),
    defaultSort: run.sort.key ?? undefined,
    defaultDir: run.sort.dir,
    limit: 25,
  });

  const columns: Array<Column<ReportRow>> = report.columns.map((column) => ({
    key: column.key,
    header: column.label,
    sortKey: column.key,
    align: NUMERIC.has(column.kind ?? "text") ? "right" : "left",
    numeric: NUMERIC.has(column.kind ?? "text"),
    hideBelow: column.hideBelow,
    cell: (row) => <Cell row={row} column={column} />,
  }));

  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v && k !== "page") query.set(k, v);
  }
  const exportHref = `/api/v1/reports/library/${key}?${query.toString()}${query.size ? "&" : ""}format=csv`;
  const printHref = `/print/report/${key}?${query.toString()}`;

  const periodLabel = run.range
    ? run.range.from && run.range.to
      ? `${nairobiDate(run.range.from)} to ${nairobiDate(run.range.to)}`
      : run.range.label
    : `As at ${nairobiDate()}`;

  const hasTotals = Object.keys(run.totals).length > 0;
  const totalsRow = hasTotals ? (
    <tr className="border-t-2 border-border font-semibold">
      {report.columns.map((column, index) => (
        <td
          key={column.key}
          className={[
            "px-4 py-2.5 text-sm",
            NUMERIC.has(column.kind ?? "text") ? "tabular text-right" : "",
            column.hideBelow ? HIDE_CLASS[column.hideBelow] : "",
          ].join(" ")}
        >
          {column.key in run.totals
            ? formatCell(run.totals[column.key], column.kind)
            : index === 0
              ? `Total (${run.rows.length.toLocaleString("en-KE")})`
              : ""}
        </td>
      ))}
    </tr>
  ) : undefined;

  const filterKeys = [
    "q",
    "page",
    ...run.filterChoices.map((f) => `f_${f.key}`),
    ...run.selectChoices.map((s) => `s_${s.key}`),
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title={report.title}
        description={`${report.description} ${periodLabel}.`}
        breadcrumb={{ href: "/app/report-centre", label: "Report centre" }}
        actions={
          <>
            <ExportLink href={exportHref} />
            <ButtonLink href={printHref} variant="secondary" size="sm">
              Print
            </ButtonLink>
          </>
        }
      />

      {report.usesPeriod ? (
        <DateRangeBar
          action={path}
          active={run.range?.key ?? ""}
          presets={REPORT_RANGE_PRESETS.map((p) => ({ key: p.key, label: p.label }))}
          preserve={preserved(params, ["range", "month", "from", "to", "page"])}
        />
      ) : null}

      {(run.output.notes ?? []).map((note) => (
        <Callout key={note.text} tone={note.tone}>
          {note.text}
        </Callout>
      ))}

      {run.output.truncated ? (
        <Callout tone="danger" title="This report is incomplete">
          It reached its limit of 20,000 rows, so totals cover only part of the data. Choose a shorter period.
        </Callout>
      ) : null}

      {run.output.summary?.length ? (
        <StatGrid>
          {run.output.summary.map((item) => (
            <StatCard
              key={item.label}
              label={item.label}
              value={typeof item.value === "number" ? formatCell(item.value, item.kind ?? "int") : item.value}
              tone={item.tone ?? "neutral"}
              hint={item.hint}
            />
          ))}
        </StatGrid>
      ) : null}

      <div>
        <FilterBar action={path} preserve={preserved(params, filterKeys)}>
          <FilterSearch name="q" value={params.q} placeholder="Search this report…" />
          {run.selectChoices.map((select) => (
            <FilterSelect
              key={select.key}
              name={`s_${select.key}`}
              value={params[`s_${select.key}`]}
              allLabel={select.allLabel}
              options={select.options}
            />
          ))}
          {run.filterChoices.map((filter) => (
            <FilterSelect
              key={filter.key}
              name={`f_${filter.key}`}
              value={params[`f_${filter.key}`]}
              allLabel={filter.allLabel}
              options={filter.options}
            />
          ))}
        </FilterBar>

        <DataTable
          columns={columns}
          rows={pageOf(run.rows, ts)}
          getRowKey={(_, index) => String(index)}
          caption={report.title}
          sort={{ key: run.sort.key, dir: run.sort.dir }}
          sortHrefFor={(column) =>
            tableHref(
              path,
              params,
              { sort: column, dir: run.sort.key === column && run.sort.dir === "asc" ? "desc" : "asc" },
              "",
            )
          }
          totals={totalsRow}
          pagination={{
            page: ts.page,
            pages: Math.max(1, Math.ceil(run.rows.length / ts.limit)),
            total: run.rows.length,
            limit: ts.limit,
            hrefFor: (p) => tableHref(path, params, { page: p }, undefined),
          }}
          empty={{ title: "Nothing to report", description: "No records match this period and these filters." }}
        />
      </div>
    </div>
  );
}
