import Link from "next/link";
import type { ReactNode } from "react";

import {
  ArrowDownIcon,
  ArrowUpIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  SortIcon,
} from "./icons";
import { Card, EmptyState, Skeleton, cx } from "./primitives";

/**
 * The one table in the product.
 *
 * Before this existed the console had eleven hand-rolled `<table>` blocks that
 * had already drifted — different padding, different empty-state copy, some
 * with a horizontal scroll container and some without (those overflowed the
 * page on a laptop). A column-driven table fixes that by construction: pages
 * describe their data and get consistent behaviour for free.
 *
 * Deliberately server-renderable. Sorting, filtering and pagination are URL
 * state handled by the page (see src/lib/table.ts), not client state hidden in
 * here — that keeps rows shareable, back-button-correct, and avoids shipping
 * the whole dataset to the browser.
 */

export interface Column<T> {
  /** Stable key, also used as the React key for the cell. */
  key: string;
  header: ReactNode;
  /** Cell renderer. Given the row and its index. */
  cell: (row: T, index: number) => ReactNode;
  /** Right-align and tabular-figure numeric columns. */
  align?: "left" | "right" | "center";
  /** Numeric columns get tabular figures so digits line up down the column. */
  numeric?: boolean;
  /** Hide below this breakpoint — lets wide tables stay usable on a phone. */
  hideBelow?: "sm" | "md" | "lg";
  width?: string;
  /** Secondary content shown under the primary cell on small screens. */
  srOnlyHeader?: boolean;
  /**
   * When set and the table receives `sort`, the header renders as a link that
   * toggles `?sort=<sortKey>&dir=…` on the URL. Only ever whitelisted keys —
   * the page owns the actual order-by mapping, so a crafted URL cannot sort by
   * a field the query does not support.
   */
  sortKey?: string;
}

export interface TableSort {
  key: string | null;
  dir: "asc" | "desc";
}

export interface TablePagination {
  page: number;
  pages: number;
  total: number;
  limit: number;
  /** href for a given page number, produced by the page from its own params. */
  hrefFor: (page: number) => string;
}

const HIDE_CLASS = {
  sm: "hidden sm:table-cell",
  md: "hidden md:table-cell",
  lg: "hidden lg:table-cell",
} as const;

export function DataTable<T>({
  columns,
  rows,
  getRowKey,
  empty,
  loading = false,
  loadingRows = 5,
  caption,
  footer,
  totals,
  dense = false,
  onRowHref,
  sort,
  sortHrefFor,
  pagination,
}: {
  columns: Array<Column<T>>;
  rows: T[];
  getRowKey: (row: T, index: number) => string;
  empty?: { title: string; description?: ReactNode; action?: ReactNode };
  loading?: boolean;
  loadingRows?: number;
  caption?: string;
  footer?: ReactNode;
  /** A `<tr>` of column totals, kept inside the table so it lines up with the columns. */
  totals?: ReactNode;
  dense?: boolean;
  /** When set, the whole row becomes a link target. */
  onRowHref?: (row: T) => string | undefined;
  /** Active sort; enables the clickable headers on columns with a sortKey. */
  sort?: TableSort;
  /** href for a sort-header click on a given column key. */
  sortHrefFor?: (key: string) => string;
  /** Pagination footer. */
  pagination?: TablePagination;
}) {
  const pad = dense ? "px-3 py-2" : "px-4 py-3";

  const body = (
    <>
      <Card padded={false} className={cx("overflow-hidden", !(rows.length === 0 && !loading && empty) && "w-full")}>
        {/* The table scrolls inside its own box; the page body never does. */}
        <div className="scroll-x">
          <table className="w-full border-collapse text-base">
            {caption ? <caption className="sr-only">{caption}</caption> : null}

            <thead>
              <tr className="border-b border-border bg-surface-sunken/60">
                {columns.map((c) => {
                  const withSort = Boolean(sort && sortHrefFor && c.sortKey);
                  const active = withSort && sort!.key === c.sortKey;
                  const content = (
                    <span className="inline-flex items-center gap-1.5">
                      {c.srOnlyHeader ? <span className="sr-only">{c.header}</span> : c.header}
                      {withSort ? (
                        active ? (
                          sort!.dir === "asc" ? (
                            <ArrowUpIcon size={11} className="text-accent" />
                          ) : (
                            <ArrowDownIcon size={11} className="text-accent" />
                          )
                        ) : (
                          <SortIcon size={11} className="text-content-muted opacity-0 transition-opacity group-hover:opacity-70" />
                        )
                      ) : null}
                    </span>
                  );
                  return (
                    <th
                      key={c.key}
                      scope="col"
                      style={c.width ? { width: c.width } : undefined}
                      aria-sort={
                        active ? (sort!.dir === "asc" ? "ascending" : "descending") : undefined
                      }
                      className={cx(
                        pad,
                        "whitespace-nowrap text-xs font-semibold uppercase tracking-wide",
                        c.align === "right" && "text-right",
                        c.align === "center" && "text-center",
                        (!c.align || c.align === "left") && "text-left",
                        c.hideBelow && HIDE_CLASS[c.hideBelow],
                        active ? "text-accent" : "text-content-muted",
                      )}
                    >
                      {withSort ? (
                        <>
                          {/* On paper the header is a label, not a control: the
                              link and its sort glyph are dropped and the plain
                              text is printed in their place. */}
                          <Link
                            href={sortHrefFor!(c.sortKey!)}
                            className={cx("group -m-1 inline-flex p-1 hover:text-content print:hidden", active && "text-accent")}
                          >
                            {content}
                          </Link>
                          <span className="hidden print:inline">{c.header}</span>
                        </>
                      ) : (
                        content
                      )}
                    </th>
                  );
                })}
              </tr>
            </thead>

            <tbody>
              {loading
                ? Array.from({ length: loadingRows }).map((_, i) => (
                    <tr key={`skeleton-${i}`} className="border-b border-border last:border-0">
                      {columns.map((c) => (
                        <td key={c.key} className={cx(pad, c.hideBelow && HIDE_CLASS[c.hideBelow])}>
                          <Skeleton className="h-4 w-full max-w-[160px]" />
                        </td>
                      ))}
                    </tr>
                  ))
                : rows.map((row, i) => {
                    const href = onRowHref?.(row);
                    return (
                      <tr
                        key={getRowKey(row, i)}
                        className={cx(
                          "border-b border-border transition-colors last:border-0",
                          href && "cursor-pointer",
                          "hover:bg-surface-hover",
                        )}
                      >
                        {columns.map((c) => (
                          <td
                            key={c.key}
                            className={cx(
                              pad,
                              "align-middle",
                              c.numeric && "tabular",
                              c.align === "right" && "text-right",
                              c.align === "center" && "text-center",
                              c.hideBelow && HIDE_CLASS[c.hideBelow],
                            )}
                          >
                            {href && c === columns[0] ? (
                              <Link href={href} className="-m-1 block p-1 hover:text-accent">
                                {c.cell(row, i)}
                              </Link>
                            ) : (
                              c.cell(row, i)
                            )}
                          </td>
                        ))}
                      </tr>
                    );
                  })}
            </tbody>
            {totals ? <tfoot>{totals}</tfoot> : null}
          </table>
        </div>

        {footer ? (
          <div className="border-t border-border bg-surface-sunken px-4 py-2.5 text-sm text-content-secondary">
            {footer}
          </div>
        ) : null}

        {pagination && pagination.pages > 1 ? (
          <PaginationBar pagination={pagination} dense={dense} />
        ) : null}
      </Card>
    </>
  );

  if (!loading && rows.length === 0 && empty) {
    return (
      <Card padded={false} className="w-full">
        <EmptyState {...empty} />
        {pagination && pagination.pages > 1 ? (
          <div className="border-t border-border">
            <PaginationBar pagination={pagination} dense={dense} />
          </div>
        ) : null}
      </Card>
    );
  }

  return body;
}

function PaginationBar({
  pagination,
  dense,
}: {
  pagination: TablePagination;
  dense?: boolean;
}) {
  const { page, pages, total, limit, hrefFor } = pagination;
  const from = total === 0 ? 0 : (page - 1) * limit + 1;
  const to = Math.min(total, page * limit);

  // A window of page numbers around the current page, with the ends always
  // visible — enough to orient without listing hundreds of pages.
  const window: Array<number | "…"> = [];
  const push = (n: number | "…") => {
    if (window[window.length - 1] !== n) window.push(n);
  };
  for (let n = 1; n <= pages; n++) {
    if (n === 1 || n === pages || Math.abs(n - page) <= 2) push(n);
    else push("…");
  }

  return (
    <div
      className={cx(
        "flex flex-wrap items-center justify-between gap-3 border-t border-border bg-surface print:hidden",
        dense ? "px-3 py-2" : "px-4 py-2.5",
      )}
      data-print-hidden
    >
      <p className="text-xs text-content-muted">
        {from}–{to} of {total.toLocaleString("en-KE")}
      </p>

      <nav className="flex items-center gap-1" aria-label="Pagination">
        <PagerLink href={hrefFor(page - 1)} disabled={page <= 1} label="Previous page">
          <ChevronLeftIcon />
        </PagerLink>
        {window.map((n, i) =>
          n === "…" ? (
            <span key={`e${i}`} className="px-1 text-xs text-content-muted">
              …
            </span>
          ) : (
            <PagerLink key={n} href={hrefFor(n)} current={n === page} label={`Page ${n}`}>
              <span className="tabular text-xs">{n}</span>
            </PagerLink>
          ),
        )}
        <PagerLink href={hrefFor(page + 1)} disabled={page >= pages} label="Next page">
          <ChevronRightIcon />
        </PagerLink>
      </nav>
    </div>
  );
}

function PagerLink({
  href,
  current,
  disabled,
  label,
  children,
}: {
  href: string;
  current?: boolean;
  disabled?: boolean;
  label: string;
  children: ReactNode;
}) {
  const cls = cx(
    "grid h-7 min-w-7 place-items-center rounded px-1.5 text-sm transition-colors",
    current
      ? "bg-accent text-white"
      : disabled
        ? "pointer-events-none text-content-muted opacity-40"
        : "text-content-secondary hover:bg-surface-hover hover:text-content",
  );
  if (disabled) {
    return (
      <span className={cls} aria-disabled="true" aria-label={label}>
        {children}
      </span>
    );
  }
  return (
    <Link href={href} className={cls} aria-label={label} aria-current={current ? "page" : undefined}>
      {children}
    </Link>
  );
}

/**
 * Two-line cell: a strong primary line with a quieter secondary beneath.
 * Used constantly — customer + code, invoice + date, user + email — so it is
 * shared rather than re-expressed per table.
 */
export function CellStack({
  primary,
  secondary,
}: {
  primary: ReactNode;
  secondary?: ReactNode;
}) {
  return (
    <div className="min-w-0">
      <div className="truncate font-medium">{primary}</div>
      {secondary ? (
        <div className="truncate text-sm text-content-muted">{secondary}</div>
      ) : null}
    </div>
  );
}
