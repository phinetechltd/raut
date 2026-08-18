import type { ReactNode } from "react";

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
 * Deliberately server-renderable. Sorting and filtering are URL state handled
 * by the page, not client state hidden in here — that keeps rows shareable,
 * back-button-correct, and avoids shipping the whole dataset to the browser.
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
  dense = false,
  onRowHref,
}: {
  columns: Array<Column<T>>;
  rows: T[];
  getRowKey: (row: T, index: number) => string;
  empty?: { title: string; description?: ReactNode; action?: ReactNode };
  loading?: boolean;
  loadingRows?: number;
  caption?: string;
  footer?: ReactNode;
  dense?: boolean;
  /** When set, the whole row becomes a link target. */
  onRowHref?: (row: T) => string | undefined;
}) {
  const pad = dense ? "px-3 py-2" : "px-4 py-3";

  if (!loading && rows.length === 0 && empty) {
    return (
      <Card padded={false}>
        <EmptyState {...empty} />
      </Card>
    );
  }

  return (
    <Card padded={false} className="overflow-hidden">
      {/* The table scrolls inside its own box; the page body never does. */}
      <div className="scroll-x">
        <table className="w-full border-collapse text-base">
          {caption ? <caption className="sr-only">{caption}</caption> : null}

          <thead>
            <tr className="border-b border-border">
              {columns.map((c) => (
                <th
                  key={c.key}
                  scope="col"
                  style={c.width ? { width: c.width } : undefined}
                  className={cx(
                    pad,
                    "whitespace-nowrap text-xs font-semibold uppercase tracking-wide text-content-muted",
                    c.align === "right" && "text-right",
                    c.align === "center" && "text-center",
                    (!c.align || c.align === "left") && "text-left",
                    c.hideBelow && HIDE_CLASS[c.hideBelow],
                  )}
                >
                  {c.srOnlyHeader ? <span className="sr-only">{c.header}</span> : c.header}
                </th>
              ))}
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
                          {c.cell(row, i)}
                        </td>
                      ))}
                    </tr>
                  );
                })}
          </tbody>
        </table>
      </div>

      {footer ? (
        <div className="border-t border-border bg-surface-sunken px-4 py-2.5 text-sm text-content-secondary">
          {footer}
        </div>
      ) : null}
    </Card>
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
