import Link from "next/link";
import type { ReactNode } from "react";

import { RANGE_PRESETS } from "@/lib/table";

import { DownloadIcon, SearchIcon } from "./icons";
import { Button, cx } from "./primitives";

/**
 * Filter row for list pages.
 *
 * A plain GET form — which keeps filters working with JS off, preserves every
 * existing query param as a hidden input, and makes each filtered view a URL
 * that can be shared or bookmarked. Sort/page params are reset by the inputs
 * the page chooses to omit from `preserve`.
 *
 * The server side of this contract is src/lib/table.ts.
 */
export function FilterBar({
  action,
  preserve = {},
  onSubmitLabel = "Apply",
  children,
}: {
  /** Path the form GETs; defaults to the current page. */
  action: string;
  /** Query params to keep: everything already in the URL except the ones this bar owns. */
  preserve?: Record<string, string | undefined>;
  onSubmitLabel?: string;
  children: ReactNode;
}) {
  return (
    <form
      action={action}
      method="get"
      className="mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-border bg-surface p-2.5 shadow-sm print:hidden"
    >
      {Object.entries(preserve).map(([key, value]) =>
        value !== undefined && value !== "" ? (
          <input key={key} type="hidden" name={key} value={value} />
        ) : null,
      )}
      {children}
      <div className="ms-auto flex items-center gap-2">
        <Button type="submit" size="sm" variant="secondary">
          {onSubmitLabel}
        </Button>
      </div>
    </form>
  );
}

export function FilterSearch({
  name = "q",
  value,
  placeholder,
  className,
}: {
  name?: string;
  value?: string;
  placeholder: string;
  className?: string;
}) {
  return (
    <div className={cx("relative", className)}>
      <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-content-muted">
        <SearchIcon size={14} />
      </span>
      <input
        type="search"
        name={name}
        defaultValue={value ?? ""}
        placeholder={placeholder}
        className="input h-8 w-full min-w-52 pl-8 text-sm"
        aria-label={placeholder}
      />
    </div>
  );
}

export interface FilterOption {
  value: string;
  label: string;
}

export function FilterSelect({
  name,
  value,
  options,
  allLabel,
  className,
}: {
  name: string;
  value?: string;
  options: FilterOption[];
  /** Label of the empty option; omit to force a choice. */
  allLabel?: string;
  className?: string;
}) {
  return (
    <select
      name={name}
      defaultValue={value ?? ""}
      className={cx("input h-8 w-auto cursor-pointer text-sm", className)}
      aria-label={name}
    >
      {allLabel ? <option value="">{allLabel}</option> : null}
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

// ── date range ─────────────────────────────────────────────────────────

/**
 * Date-range filter: preset chips plus explicit from/to. Everything stays in
 * the URL (`?range=…&from=…&to=…`) — the dashboard and every report read the
 * same range, so "July numbers" means the same thing on every screen.
 */
export function DateRangeBar({
  action,
  preserve = {},
  active,
  presets = RANGE_PRESETS,
}: {
  action: string;
  preserve?: Record<string, string | undefined>;
  /** The `range` key currently active, from rangeFromParams().*/
  active: string;
  presets?: Array<{ key: string; label: string }>;
}) {
  const presetHref = (key: string) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(preserve)) {
      if (v !== undefined && v !== "" && k !== "range" && k !== "from" && k !== "to") qs.set(k, v);
    }
    qs.set("range", key);
    return `${action}?${qs.toString()}`;
  };

  return (
    <div className="mb-4 flex flex-wrap items-center gap-1.5 print:hidden" role="group" aria-label="Date range">
      <nav className="inline-flex flex-wrap gap-1 rounded-lg border border-border bg-surface-sunken p-1">
        {presets.map((p) => {
          const isActive = p.key === active;
          return (
            <Link
              key={p.key}
              href={presetHref(p.key)}
              aria-current={isActive ? "page" : undefined}
              className={cx(
                "rounded-md px-2.5 py-1 text-sm font-medium transition-colors",
                isActive
                  ? "bg-surface text-accent shadow-sm"
                  : "text-content-secondary hover:text-content",
              )}
            >
              {p.label}
            </Link>
          );
        })}
      </nav>

      <form action={action} method="get" className="flex flex-wrap items-center gap-1.5">
        {Object.entries(preserve).map(([k, v]) =>
          v !== undefined && v !== "" && k !== "range" && k !== "from" && k !== "to" ? (
            <input key={k} type="hidden" name={k} value={v} />
          ) : null,
        )}
        <input type="hidden" name="range" value="custom" />
        <input
          type="date"
          name="from"
          aria-label="From date"
          className="input h-8 w-auto text-sm"
        />
        <span className="text-content-muted text-sm">to</span>
        <input
          type="date"
          name="to"
          aria-label="To date"
          className="input h-8 w-auto text-sm"
        />
        <Button type="submit" size="sm" variant="secondary">
          Apply
        </Button>
      </form>
    </div>
  );
}

/** CSV export link styled like the filter chips. */
export function ExportLink({ href, label = "Export CSV" }: { href: string; label?: string }) {
  return (
    <a
      href={href}
      className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-surface px-3 text-sm font-medium transition-colors hover:bg-surface-hover"
    >
      <DownloadIcon size={14} />
      {label}
    </a>
  );
}
