import type { ReactNode } from "react";

import { formatKES, formatKESCompact } from "@/lib/money";

import { Card, EmptyState, cx, type Tone } from "./primitives";

/**
 * Data-display components.
 *
 * The chart pieces follow a few rules that are not negotiable:
 *  - one axis, never two y-scales
 *  - categorical colour assigned in fixed order, never cycled
 *  - colour never the only carrier of meaning — labels and values sit alongside
 *  - grid and axes recessive, marks prominent
 *  - text wears text tokens, never the series colour
 */

// ── numbers ────────────────────────────────────────────────────────────

export function Money({ cents, compact }: { cents: number; compact?: boolean }) {
  return <span className="tabular">{compact ? formatKESCompact(cents) : formatKES(cents)}</span>;
}

const TREND_TONE = {
  up: "text-success",
  down: "text-danger",
  flat: "text-content-muted",
} as const;

/**
 * A single figure with its label. The most-used component on the dashboards,
 * so it carries the hierarchy: label small and quiet, value large, context
 * beneath.
 */
export function StatCard({
  label,
  value,
  hint,
  tone = "neutral",
  trend,
  icon,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: Tone;
  trend?: { direction: "up" | "down" | "flat"; label: string };
  icon?: ReactNode;
}) {
  const valueTone = {
    neutral: "", accent: "text-accent", info: "text-info",
    success: "text-success", warning: "text-warning", danger: "text-danger",
  }[tone];

  return (
    <Card className="flex flex-col gap-1">
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs font-medium uppercase tracking-wide text-content-muted">
          {label}
        </p>
        {icon ? <span className="text-content-muted">{icon}</span> : null}
      </div>

      <p className={cx("text-2xl font-semibold tracking-tight tabular", valueTone)}>
        {value}
      </p>

      {trend ? (
        <p className={cx("text-sm font-medium", TREND_TONE[trend.direction])}>
          <span aria-hidden="true">
            {trend.direction === "up" ? "↑" : trend.direction === "down" ? "↓" : "→"}
          </span>{" "}
          {trend.label}
        </p>
      ) : null}

      {hint ? <p className="text-sm text-content-muted">{hint}</p> : null}
    </Card>
  );
}

/** Grid wrapper so stat rows are consistent across pages. */
export function StatGrid({ children }: { children: ReactNode }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{children}</div>
  );
}

// ── meters ─────────────────────────────────────────────────────────────

export function Meter({
  value,
  max,
  tone = "accent",
  label,
  showValue = false,
}: {
  value: number;
  max: number;
  tone?: "accent" | "success" | "warning" | "danger";
  label?: string;
  showValue?: boolean;
}) {
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  const fill = {
    accent: "bg-accent", success: "bg-success",
    warning: "bg-warning", danger: "bg-danger",
  }[tone];

  return (
    <div>
      {label || showValue ? (
        <div className="mb-1 flex items-baseline justify-between gap-2 text-sm">
          {label ? <span className="truncate text-content-secondary">{label}</span> : null}
          {showValue ? (
            <span className="shrink-0 tabular text-content-muted">{pct.toFixed(0)}%</span>
          ) : null}
        </div>
      ) : null}
      <div
        className="h-1.5 w-full overflow-hidden rounded-full bg-surface-sunken"
        role="progressbar"
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
      >
        <div className={cx("h-full rounded-full transition-all", fill)} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

// ── charts ─────────────────────────────────────────────────────────────

export interface BarDatum {
  label: string;
  value: number;
}

/**
 * Single-series column chart.
 *
 * No legend — a lone series is named by the section heading, so a legend box
 * would be noise. Values are direct-labelled on hover via the title element and
 * the peak is stated beneath, which keeps the reading accessible without
 * printing a number on every bar.
 */
export function BarChart({
  data,
  height = 180,
  format = "money",
  emptyMessage = "No data for this period",
}: {
  data: BarDatum[];
  height?: number;
  format?: "money" | "count";
  emptyMessage?: string;
}) {
  if (data.length === 0) return <EmptyState title={emptyMessage} />;

  const max = Math.max(...data.map((d) => d.value), 1);
  const fmt = (v: number) =>
    format === "money" ? formatKESCompact(v) : v.toLocaleString("en-KE");

  const plot = height - 26;

  return (
    <figure className="m-0">
      <div
        className="flex items-end gap-1.5"
        style={{ height }}
        role="img"
        aria-label={`Bar chart. ${data.map((d) => `${d.label}: ${fmt(d.value)}`).join(", ")}`}
      >
        {data.map((d) => {
          const h = Math.max((d.value / max) * plot, 2);
          return (
            <div key={d.label} className="flex min-w-0 flex-1 flex-col items-center gap-1.5">
              <div className="flex w-full flex-1 items-end">
                <div
                  // 4px rounded top, anchored to the baseline — the data end is
                  // rounded, the baseline end is not.
                  className="w-full rounded-t bg-chart-1 transition-[height]"
                  style={{ height: h }}
                  title={`${d.label}: ${fmt(d.value)}`}
                />
              </div>
              <span className="w-full truncate text-center text-xs text-content-muted">
                {d.label}
              </span>
            </div>
          );
        })}
      </div>
      <figcaption className="mt-2 text-sm text-content-muted">
        Peak {fmt(max)}
      </figcaption>
    </figure>
  );
}

export interface SeriesDatum {
  label: string;
  value: number;
}

/**
 * Horizontal ranked bars — for "top N" lists where the label matters as much
 * as the magnitude. Direct-labelled, so no legend and no colour dependence.
 */
export function RankedBars({
  data,
  format = "money",
  emptyMessage = "Nothing to rank yet",
  max: explicitMax,
}: {
  data: SeriesDatum[];
  format?: "money" | "count";
  emptyMessage?: string;
  max?: number;
}) {
  if (data.length === 0) return <EmptyState title={emptyMessage} />;

  const max = explicitMax ?? Math.max(...data.map((d) => d.value), 1);
  const fmt = (v: number) =>
    format === "money" ? formatKESCompact(v) : v.toLocaleString("en-KE");

  return (
    <ul className="space-y-3">
      {data.map((d) => (
        <li key={d.label}>
          <div className="mb-1 flex items-baseline justify-between gap-3 text-sm">
            <span className="truncate font-medium">{d.label}</span>
            <span className="shrink-0 tabular text-content-secondary">{fmt(d.value)}</span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-sunken">
            <div
              className="h-full rounded-full bg-chart-1"
              style={{ width: `${max > 0 ? (d.value / max) * 100 : 0}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

/**
 * Categorical breakdown. Series colours are assigned in fixed order from the
 * validated palette and every row is direct-labelled, so identity never rests
 * on colour alone.
 */
export function CategoryBreakdown({
  data,
  format = "money",
  emptyMessage = "No breakdown available",
}: {
  data: SeriesDatum[];
  format?: "money" | "count";
  emptyMessage?: string;
}) {
  if (data.length === 0) return <EmptyState title={emptyMessage} />;

  const total = data.reduce((s, d) => s + d.value, 0);
  const fmt = (v: number) =>
    format === "money" ? formatKESCompact(v) : v.toLocaleString("en-KE");

  // Fixed order, never cycled. Beyond six the tail folds into one row rather
  // than inventing a seventh hue.
  const shown = data.slice(0, 6);
  const rest = data.slice(6);
  if (rest.length > 0) {
    shown.push({
      label: `Other (${rest.length})`,
      value: rest.reduce((s, d) => s + d.value, 0),
    });
  }

  return (
    <div>
      {/* Stacked ratio bar, with a surface gap between segments. */}
      <div className="mb-4 flex h-2 gap-0.5 overflow-hidden rounded-full">
        {shown.map((d, i) => (
          <div
            key={d.label}
            className="h-full first:rounded-l-full last:rounded-r-full"
            style={{
              width: `${total > 0 ? (d.value / total) * 100 : 0}%`,
              background: i < 6 ? `var(--chart-${i + 1})` : "var(--border-strong)",
            }}
            title={`${d.label}: ${fmt(d.value)}`}
          />
        ))}
      </div>

      <ul className="space-y-2">
        {shown.map((d, i) => (
          <li key={d.label} className="flex items-baseline gap-2 text-sm">
            <span
              className="mt-1.5 h-2 w-2 shrink-0 rounded-full"
              style={{ background: i < 6 ? `var(--chart-${i + 1})` : "var(--border-strong)" }}
              aria-hidden="true"
            />
            <span className="min-w-0 flex-1 truncate">{d.label}</span>
            <span className="shrink-0 tabular text-content-secondary">{fmt(d.value)}</span>
            <span className="w-11 shrink-0 text-right tabular text-content-muted">
              {total > 0 ? `${((d.value / total) * 100).toFixed(0)}%` : "0%"}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── map ────────────────────────────────────────────────────────────────

export interface MapPoint {
  id: string;
  lat: number;
  lng: number;
  label: string;
  /** Same vocabulary as every other component — one tone language, not two. */
  tone?: "neutral" | "success" | "warning" | "danger";
  sequence?: number;
}

/**
 * Coordinate plot, not a tile map.
 *
 * Basemap tiles need a Google or Mapbox contract, which the proposal excludes
 * from the platform price. This renders pins, territory fences and route legs
 * from stored coordinates on an equirectangular projection — accurate for
 * spatial relationships at city scale, and honest about being a plot.
 */
export function GeoMap({
  points,
  polygons = [],
  path = [],
  height = 360,
}: {
  points: MapPoint[];
  polygons?: Array<{ id: string; colour: string; vertices: Array<[number, number]> }>;
  path?: string[];
  height?: number;
}) {
  const all = [
    ...points.map((p) => ({ lat: p.lat, lng: p.lng })),
    ...polygons.flatMap((poly) => poly.vertices.map(([lat, lng]) => ({ lat, lng }))),
  ];

  if (all.length === 0) {
    return (
      <Card padded={false} className="grid place-items-center" >
        <div style={{ height }} className="grid w-full place-items-center">
          <EmptyState
            title="No mapped locations"
            description="Capture customer GPS pins in the field app to populate this map."
          />
        </div>
      </Card>
    );
  }

  const lats = all.map((p) => p.lat);
  const lngs = all.map((p) => p.lng);
  const pad = 0.14;
  const latSpan = Math.max(Math.max(...lats) - Math.min(...lats), 0.01);
  const lngSpan = Math.max(Math.max(...lngs) - Math.min(...lngs), 0.01);
  const north = Math.max(...lats) + latSpan * pad;
  const south = Math.min(...lats) - latSpan * pad;
  const east = Math.max(...lngs) + lngSpan * pad;
  const west = Math.min(...lngs) - lngSpan * pad;

  const W = 1000;
  const H = 560;
  const x = (lng: number) => ((lng - west) / (east - west)) * W;
  const y = (lat: number) => ((north - lat) / (north - south)) * H;

  const byId = new Map(points.map((p) => [p.id, p]));
  const pathPoints = path.map((id) => byId.get(id)).filter(Boolean) as MapPoint[];

  const TONE_VAR = {
    neutral: "var(--chart-1)",
    success: "var(--success-fg)",
    warning: "var(--warning-fg)",
    danger: "var(--danger-fg)",
  };

  return (
    <Card padded={false} className="overflow-hidden">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        style={{ height, width: "100%" }}
        role="img"
        aria-label={`Map of ${points.length} location(s)`}
      >
        <defs>
          <pattern id="xosGrid" width="48" height="48" patternUnits="userSpaceOnUse">
            <path
              d="M 48 0 L 0 0 0 48"
              fill="none"
              stroke="var(--chart-grid)"
              strokeWidth="1"
            />
          </pattern>
        </defs>
        <rect width={W} height={H} fill="url(#xosGrid)" />

        {polygons.map((poly) => (
          <polygon
            key={poly.id}
            points={poly.vertices.map(([la, ln]) => `${x(ln)},${y(la)}`).join(" ")}
            fill={poly.colour}
            fillOpacity="0.08"
            stroke={poly.colour}
            strokeWidth="2"
            strokeDasharray="7 5"
          />
        ))}

        {pathPoints.length > 1 ? (
          <polyline
            points={pathPoints.map((p) => `${x(p.lng)},${y(p.lat)}`).join(" ")}
            fill="none"
            stroke="var(--chart-1)"
            strokeWidth="2.5"
            strokeDasharray="9 6"
            strokeLinecap="round"
          />
        ) : null}

        {points.map((p) => {
          const fill = TONE_VAR[p.tone ?? "neutral"];
          return (
            <g key={p.id}>
              <circle cx={x(p.lng)} cy={y(p.lat)} r="13" fill={fill} fillOpacity="0.16" />
              {/* 2px surface ring keeps overlapping pins readable */}
              <circle
                cx={x(p.lng)}
                cy={y(p.lat)}
                r="6.5"
                fill={fill}
                stroke="var(--surface)"
                strokeWidth="2"
              />
              {p.sequence ? (
                <text
                  x={x(p.lng)}
                  y={y(p.lat) + 3.4}
                  textAnchor="middle"
                  fill="#fff"
                  style={{ fontSize: 8, fontWeight: 700 }}
                >
                  {p.sequence}
                </text>
              ) : null}
              <text
                x={x(p.lng)}
                y={y(p.lat) - 17}
                textAnchor="middle"
                fill="var(--text-secondary)"
                style={{ fontSize: 12 }}
              >
                {p.label}
              </text>
            </g>
          );
        })}
      </svg>
    </Card>
  );
}
