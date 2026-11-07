/**
 * The shape every report in the library shares, and the pure logic around it.
 *
 * A report says what its columns are and hands back rows. Searching, filtering,
 * sorting, totals, paging and CSV all live here once, so a total on screen, a
 * total in the export and a total on paper come from the same arithmetic.
 */

export type CellKind =
  | "text"
  | "mono"
  | "money"
  | "int"
  | "decimal"
  /** Stored in basis points: 1234 reads as 12.3%. */
  | "pct"
  | "date"
  | "datetime"
  | "status";

export type CellValue = string | number | boolean | Date | null | undefined;
export type ReportRow = Record<string, CellValue>;

export interface ReportColumn {
  key: string;
  label: string;
  kind?: CellKind;
  /** Sum this column across every matching row, not just the visible page. */
  total?: boolean;
  hideBelow?: "sm" | "md" | "lg";
  /** A row field holding a console link for this cell. */
  hrefKey?: string;
}

export interface ReportSummaryItem {
  label: string;
  value: number | string;
  kind?: CellKind;
  tone?: "neutral" | "success" | "warning" | "danger";
  hint?: string;
}

export interface ReportNote {
  tone: "info" | "warning" | "danger";
  text: string;
}

export interface ReportOutput {
  rows: ReportRow[];
  summary?: ReportSummaryItem[];
  notes?: ReportNote[];
  /** The query hit its row ceiling, so totals cover only part of the data. */
  truncated?: boolean;
}

/** A row-level filter whose options are read from the report's own rows. */
export interface ReportFilterField {
  key: string;
  allLabel: string;
}

/** Most rows one report loads. Past this it says so instead of under-reporting. */
export const MAX_REPORT_ROWS = 20_000;

// ── time ───────────────────────────────────────────────────────────────

/**
 * Books are kept on the Nairobi calendar. An invoice raised at half past midnight
 * on the 1st belongs to that month on a VAT return, though in UTC it is still the
 * previous one. Kenya has no daylight saving, so a fixed offset is exact.
 */
const NAIROBI_OFFSET_MS = 3 * 3_600_000;

export function nairobiDate(at: Date = new Date()): string {
  return new Date(at.getTime() + NAIROBI_OFFSET_MS).toISOString().slice(0, 10);
}

export function nairobiMonth(at: Date = new Date()): string {
  return nairobiDate(at).slice(0, 7);
}

/** The Nairobi year and month a moment falls in. */
export function nairobiYearMonth(at: Date): { year: number; month: number } {
  const [year, month] = nairobiDate(at).split("-").map(Number);
  return { year, month };
}

export function startOfNairobiDay(day: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const d = new Date(`${day}T00:00:00+03:00`);
  if (Number.isNaN(d.getTime()) || nairobiDate(d) !== day) return null;
  return d;
}

export function endOfNairobiDay(day: string): Date | null {
  const start = startOfNairobiDay(day);
  return start ? new Date(start.getTime() + 86_400_000 - 1) : null;
}

export function nairobiMonthBounds(ym: string): { from: Date; to: Date } | null {
  const match = /^(\d{4})-(\d{2})$/.exec(ym);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  return {
    from: new Date(Date.UTC(year, month - 1, 1) - NAIROBI_OFFSET_MS),
    to: new Date(Date.UTC(year, month, 1) - NAIROBI_OFFSET_MS - 1),
  };
}

/**
 * The moment to record for something entered against a calendar day. Today gets
 * the actual time, so a new entry lands at the top of a list. Any other day gets
 * midday, so the time of day can never tip it into a neighbouring month.
 */
export function momentForDay(day: string, now: Date = new Date()): Date | null {
  const start = startOfNairobiDay(day);
  if (!start) return null;
  return day === nairobiDate(now) ? now : new Date(start.getTime() + 12 * 3_600_000);
}

export const REPORT_RANGE_PRESETS = [
  { key: "this-month", label: "This month" },
  { key: "last-month", label: "Last month" },
  { key: "this-quarter", label: "This quarter" },
  { key: "ytd", label: "Year to date" },
  { key: "last-year", label: "Last year" },
  { key: "all", label: "All time" },
] as const;

export interface ReportRange {
  key: string;
  label: string;
  from: Date | null;
  to: Date | null;
}

function shiftMonth(ym: string, by: number): string {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * Resolves `?range=` or `?month=` or `?from=&to=` to Nairobi bounds. A date that
 * does not exist falls back to the default rather than to an unbounded query,
 * which would quietly report on all time under a heading naming one month.
 */
export function reportRange(
  params: Record<string, string | undefined>,
  now: Date = new Date(),
  defaultKey = "this-month",
): ReportRange {
  const thisMonth = nairobiMonth(now);
  const year = Number(thisMonth.slice(0, 4));
  const monthNumber = Number(thisMonth.slice(5, 7));

  if (params.month) {
    const bounds = nairobiMonthBounds(params.month);
    if (bounds) return { key: "month", label: params.month, ...bounds };
  }

  if (params.from || params.to) {
    const from = params.from ? startOfNairobiDay(params.from) : null;
    const to = params.to ? endOfNairobiDay(params.to) : null;
    const fromOk = !params.from || from;
    const toOk = !params.to || to;
    if (fromOk && toOk) {
      const label = `${params.from ?? "Start"} to ${params.to ?? "today"}`;
      return { key: "custom", label, from, to: to ?? (params.to ? null : now) };
    }
  }

  const key = params.range ?? defaultKey;
  const month = (ym: string) => nairobiMonthBounds(ym)!;
  switch (key) {
    case "last-month":
      return { key, label: "Last month", ...month(shiftMonth(thisMonth, -1)) };
    case "this-quarter": {
      const firstMonth = monthNumber - ((monthNumber - 1) % 3);
      const first = `${year}-${String(firstMonth).padStart(2, "0")}`;
      return { key, label: "This quarter", from: month(first).from, to: month(thisMonth).to };
    }
    case "ytd":
      return { key, label: "Year to date", from: month(`${year}-01`).from, to: month(thisMonth).to };
    case "last-year":
      return {
        key,
        label: `${year - 1}`,
        from: month(`${year - 1}-01`).from,
        to: month(`${year - 1}-12`).to,
      };
    case "all":
      return { key, label: "All time", from: null, to: null };
    case "this-month":
    default:
      return { key: "this-month", label: "This month", ...month(thisMonth) };
  }
}

// ── rows ───────────────────────────────────────────────────────────────

function asSearchText(value: CellValue): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return nairobiDate(value);
  return String(value).toLowerCase();
}

/** Every text-like column is searched, so search needs no per-report setup. */
export function searchRows(rows: ReportRow[], columns: ReportColumn[], query?: string): ReportRow[] {
  const q = query?.trim().toLowerCase();
  if (!q) return rows;
  const fields = columns
    .filter((c) => (c.kind ?? "text") === "text" || c.kind === "mono" || c.kind === "status")
    .map((c) => c.key);
  return rows.filter((row) => fields.some((f) => asSearchText(row[f]).includes(q)));
}

export function applyRowFilters(
  rows: ReportRow[],
  fields: ReportFilterField[],
  params: Record<string, string | undefined>,
): ReportRow[] {
  return rows.filter((row) =>
    fields.every((f) => {
      const wanted = params[`f_${f.key}`];
      return !wanted || String(row[f.key] ?? "") === wanted;
    }),
  );
}

/** Status codes read as words. Names, which are not all capitals, are left alone. */
function readableOption(value: string): string {
  if (!/^[A-Z0-9_ ]+$/.test(value)) return value;
  const words = value.replaceAll("_", " ").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Distinct values for a filter dropdown, read from the unfiltered rows. */
export function filterOptions(rows: ReportRow[], key: string): Array<{ value: string; label: string }> {
  const values = new Set<string>();
  for (const row of rows) {
    const value = row[key];
    if (value !== null && value !== undefined && value !== "") values.add(String(value));
  }
  return [...values].sort().map((value) => ({ value, label: readableOption(value) }));
}

export function compareCells(a: CellValue, b: CellValue): number {
  const blankA = a === null || a === undefined || a === "";
  const blankB = b === null || b === undefined || b === "";
  if (blankA || blankB) return blankA === blankB ? 0 : blankA ? 1 : -1;
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b));
}

/** Blanks stay at the bottom whichever way the column is sorted. */
export function sortReportRows(rows: ReportRow[], key: string | null, dir: "asc" | "desc"): ReportRow[] {
  if (!key) return rows;
  const sign = dir === "asc" ? 1 : -1;
  return [...rows].sort((x, y) => {
    const a = x[key];
    const b = y[key];
    const blankA = a === null || a === undefined || a === "";
    const blankB = b === null || b === undefined || b === "";
    if (blankA || blankB) return compareCells(a, b);
    return compareCells(a, b) * sign;
  });
}

export function totalsFor(rows: ReportRow[], columns: ReportColumn[]): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const column of columns) {
    if (!column.total) continue;
    totals[column.key] = rows.reduce((sum, row) => {
      const value = row[column.key];
      return sum + (typeof value === "number" && Number.isFinite(value) ? value : 0);
    }, 0);
  }
  return totals;
}

// ── formatting ─────────────────────────────────────────────────────────

const moneyFormat = new Intl.NumberFormat("en-KE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const intFormat = new Intl.NumberFormat("en-KE");

export function formatCell(value: CellValue, kind: CellKind = "text"): string {
  if (value === null || value === undefined || value === "") return "—";
  switch (kind) {
    case "money":
      return typeof value === "number" ? moneyFormat.format(value / 100) : String(value);
    case "int":
      return typeof value === "number" ? intFormat.format(value) : String(value);
    case "decimal":
      return typeof value === "number" ? value.toFixed(1) : String(value);
    case "pct":
      return typeof value === "number" ? `${(value / 100).toFixed(1)}%` : String(value);
    case "date":
      return value instanceof Date ? nairobiDate(value) : String(value);
    case "datetime":
      return value instanceof Date
        ? value.toLocaleString("en-KE", {
            timeZone: "Africa/Nairobi",
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
          })
        : String(value);
    case "status":
      return String(value).replaceAll("_", " ").toLowerCase();
    default:
      return typeof value === "boolean" ? (value ? "Yes" : "No") : String(value);
  }
}

/** Plain numbers for a spreadsheet: money without separators, dates as ISO days. */
export function csvCell(value: CellValue, kind: CellKind = "text"): string | number | null {
  if (value === null || value === undefined) return null;
  if (kind === "money" && typeof value === "number") return (value / 100).toFixed(2);
  if (kind === "pct" && typeof value === "number") return (value / 100).toFixed(1);
  if (value instanceof Date) return kind === "datetime" ? value.toISOString() : nairobiDate(value);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return value;
}

export function reportCsvRows(
  title: string,
  periodLabel: string,
  rows: ReportRow[],
  columns: ReportColumn[],
  summary: ReportSummaryItem[] = [],
): Array<Array<string | number | null>> {
  const out: Array<Array<string | number | null>> = [[title], [periodLabel], []];
  if (summary.length > 0) {
    for (const item of summary) out.push([item.label, csvCell(item.value, item.kind)]);
    out.push([]);
  }
  out.push(columns.map((c) => c.label));
  for (const row of rows) out.push(columns.map((c) => csvCell(row[c.key], c.kind)));
  const totals = totalsFor(rows, columns);
  if (Object.keys(totals).length > 0) {
    out.push(
      columns.map((c, index) =>
        c.key in totals ? csvCell(totals[c.key], c.kind) : index === 0 ? "Total" : null,
      ),
    );
  }
  return out;
}

// ── shared arithmetic ──────────────────────────────────────────────────

export const AGE_COLUMNS = ["currentCents", "d1_30Cents", "d31_60Cents", "d61_90Cents", "d90PlusCents"] as const;
export type AgeColumn = (typeof AGE_COLUMNS)[number];

/** Which ageing column an unpaid amount belongs in. No due date counts as current. */
export function ageColumn(dueDate: Date | null, now: Date = new Date()): AgeColumn {
  if (!dueDate || dueDate >= now) return "currentCents";
  const days = Math.floor((now.getTime() - dueDate.getTime()) / 86_400_000);
  if (days <= 30) return "d1_30Cents";
  if (days <= 60) return "d31_60Cents";
  if (days <= 90) return "d61_90Cents";
  return "d90PlusCents";
}

export function basisPoints(part: number, whole: number): number | null {
  return whole === 0 ? null : Math.round((part / whole) * 10_000);
}

export type VatClass = "STANDARD" | "REDUCED" | "ZERO" | "EXEMPT";

export const VAT_CLASS_LABELS: Record<VatClass, string> = {
  STANDARD: "Standard rated (16%)",
  REDUCED: "Reduced rate (8%)",
  ZERO: "Zero rated",
  EXEMPT: "Exempt",
};

/**
 * Which part of a VAT return a line belongs in. A 0% rate alone cannot say: a
 * zero-rated supply and an exempt one both charge nothing, but they go in
 * different boxes and only one lets the seller reclaim input VAT. The product's
 * eTIMS tax type settles it, and matches what was filed with KRA.
 */
export function vatClass(taxRateBp: number, etimsTaxTypeCode?: string | null): VatClass {
  if (etimsTaxTypeCode === "A") return "EXEMPT";
  if (etimsTaxTypeCode === "C") return "ZERO";
  if (etimsTaxTypeCode === "E" || taxRateBp === 800) return "REDUCED";
  if (taxRateBp === 0) return "ZERO";
  return "STANDARD";
}
