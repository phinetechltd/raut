/**
 * URL state for data tables and date ranges.
 *
 * Every list page keeps its sort, direction and page in the query string so a
 * view can be shared, refreshed and back-buttoned like any other URL. Nothing
 * about the table dataset lives in component state — this module is the one
 * place that reads and writes that contract.
 */

export type SortDir = "asc" | "desc";

export interface TableState {
  page: number;
  limit: number;
  sort: string | null;
  dir: SortDir;
}

type Params = Record<string, string | undefined>;

/**
 * Reads `?sort`/`dir`/`page`/`limit` (prefixed, e.g. `cust_sort`, when a page
 * hosts more than one table). Unknown sort keys fall back to the default so a
 * hand-edited URL can never push an arbitrary field into a database order-by.
 */
export function tableState(
  params: Params,
  opts: {
    prefix?: string;
    limit?: number;
    defaultSort?: string;
    defaultDir?: SortDir;
    allowed?: string[];
  } = {},
): TableState {
  const p = opts.prefix ? `${opts.prefix}_` : "";
  const rawSort = params[`${p}sort`] ?? opts.defaultSort ?? null;
  const sort =
    rawSort && (!opts.allowed || opts.allowed.includes(rawSort)) ? rawSort : null;
  // Honour an explicit direction either way; only fall back to the default
  // when the URL says nothing. Treating anything but "asc" as the default
  // meant a table that defaults to ascending could never be flipped.
  const rawDir = params[`${p}dir`];
  const dir: SortDir =
    rawDir === "asc" || rawDir === "desc" ? rawDir : (opts.defaultDir ?? "desc");
  const page = Math.max(1, Number(params[`${p}page`]) || 1);
  const limit = Math.min(100, Math.max(5, Number(params[`${p}limit`]) || (opts.limit ?? 15)));
  return { page, limit, sort, dir };
}

/**
 * Builds a href for `path` replacing a handful of keys and preserving the
 * rest. A key set to null/"" is removed; changing sort or the page size resets
 * the page, which is the behaviour anyone paging a list expects.
 */
export function tableHref(
  path: string,
  current: Params,
  changes: Record<string, string | number | null>,
  prefix?: string,
): string {
  const next = new URLSearchParams();
  for (const [key, value] of Object.entries(current)) {
    if (value !== undefined) next.set(key, value);
  }
  const p = prefix ? `${prefix}_` : "";
  for (const [key, value] of Object.entries(changes)) {
    if (value === null || value === "") next.delete(key);
    else next.set(key, String(value));
  }
  const sortChanged = nextKeys([`${p}sort`, `${p}dir`, `${p}limit`], changes);
  if (sortChanged) next.set(`${p}page`, "1");
  const qs = next.toString();
  return qs ? `${path}?${qs}` : path;
}

function nextKeys(keys: string[], changes: Record<string, unknown>): boolean {
  return keys.some((k) => k in changes);
}

/**
 * Strips the params a filter bar owns and stringifies the rest — what you pass
 * as `preserve` to FilterBar/DateRangeBar so the GET form keeps unrelated state
 * (sort, page size) without duplicating the params the bar controls.
 */
export function preserved(
  params: Params,
  owned: string[] = [],
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || owned.includes(key)) continue;
    out[key] = value;
  }
  return out;
}

/** Inverts direction for a sort header click on the currently-sorted column. */
export function toggleSort(current: TableState, key: string): { sort: string; dir: SortDir } {
  if (current.sort === key) {
    return { sort: key, dir: current.dir === "asc" ? "desc" : "asc" };
  }
  return { sort: key, dir: "asc" };
}

// ── date ranges ────────────────────────────────────────────────────────

/** In-memory sort for tables whose rows are already loaded. Blanks sort last. */
export function sortRows<T>(
  rows: T[],
  ts: TableState,
  accessors: Record<string, (row: T) => string | number | null | undefined>,
): T[] {
  const get = ts.sort ? accessors[ts.sort] : undefined;
  if (!get) return rows;
  const dir = ts.dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = get(a);
    const y = get(b);
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    if (typeof x === "number" && typeof y === "number") return (x - y) * dir;
    return String(x).localeCompare(String(y)) * dir;
  });
}

/** The current page of rows that are already loaded. */
export function pageOf<T>(rows: T[], ts: TableState): T[] {
  return rows.slice((ts.page - 1) * ts.limit, ts.page * ts.limit);
}

export interface DateRange {
  key: string;
  label: string;
  from: Date | null;
  to: Date | null;
}

const RANGE_PRESETS: Array<{ key: string; label: string }> = [
  { key: "today", label: "Today" },
  { key: "7d", label: "7 days" },
  { key: "30d", label: "30 days" },
  { key: "90d", label: "90 days" },
  { key: "mtd", label: "Month to date" },
  { key: "all", label: "All time" },
];

export { RANGE_PRESETS };

function dayStart(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function parseISODate(raw: string | undefined): Date | null {
  if (!raw) return null;
  const d = new Date(raw.includes("T") ? raw : `${raw}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Resolves the active date range. `?range=<preset>` or `?range=custom&from=&to=`;
 * defaults to `defaultKey`. `to` is end-of-day inclusive, so a filter of
 * `issueDate <= range.to` means what a user thinks it means.
 */
export function rangeFromParams(params: Params, defaultKey = "30d"): DateRange {
  const now = new Date();
  const today = dayStart(now);
  const maxFromNow = (days: number) => new Date(today.getTime() - days * 86_400_000);
  const endOfToday = new Date(today.getTime() + 86_400_000 - 1);

  const key = params.range ?? defaultKey;

  if (key === "custom") {
    const from = parseISODate(params.from);
    const toRaw = parseISODate(params.to);
    const to = toRaw ? new Date(dayStart(toRaw).getTime() + 86_400_000 - 1) : null;
    return { key: "custom", label: from && to ? `${fmtDay(from)} – ${fmtDay(toRaw!)}` : "Custom", from, to };
  }

  switch (key) {
    case "today":
      return { key, label: "Today", from: today, to: endOfToday };
    case "7d":
      return { key, label: "Last 7 days", from: maxFromNow(6), to: endOfToday };
    case "90d":
      return { key, label: "Last 90 days", from: maxFromNow(89), to: endOfToday };
    case "mtd": {
      const first = new Date(today.getFullYear(), today.getMonth(), 1);
      return { key, label: "Month to date", from: first, to: endOfToday };
    }
    case "all":
      return { key, label: "All time", from: null, to: null };
    case "30d":
    default:
      return { key: "30d", label: "Last 30 days", from: maxFromNow(29), to: endOfToday };
  }
}

/** `datetime-local` and `<input type=date>` need ISO-shaped values. */
export function inputDate(d: Date | null): string {
  if (!d) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function fmtDay(d: Date): string {
  return d.toLocaleDateString("en-KE", { day: "2-digit", month: "short", year: "numeric" });
}

/** Human label for the active range, used beside chart titles and KPI cards. */
export function rangeLabel(range: DateRange): string {
  return range.label;
}
