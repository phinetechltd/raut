import type { MapPoint } from "./data-display";

/**
 * Shared by the OpenStreetMap (Leaflet) and Google Maps renderers so the two
 * draw the same pins in the same colours. Only the basemap differs — a user
 * who switches provider should recognise every marker.
 */

export interface TileMapProps {
  points: MapPoint[];
  polygons?: Array<{ id: string; colour: string; vertices: Array<[number, number]> }>;
  /** Ids of points to connect in order — a route's stop sequence. */
  path?: string[];
  height?: number;
  /** Initial zoom when there are points; bounds fitting overrides it. */
  zoom?: number;
  /** Centre when there are no points to fit. Nairobi CBD. */
  emptyCenter?: { lat: number; lng: number };
  showEmptyTiles?: boolean;
}

export const DEFAULT_EMPTY_CENTER = { lat: -1.2864, lng: 36.8172 };

export const TONE_VAR: Record<string, string> = {
  neutral: "var(--chart-1)",
  success: "var(--success-fg)",
  warning: "var(--warning-fg)",
  danger: "var(--danger-fg)",
};

export interface ThemeColours {
  [cssVar: string]: string;
  surface: string;
  text: string;
  border: string;
}

/** Reads the live theme so pins follow light/dark mode. Browser only. */
export function resolveThemeColours(): ThemeColours {
  const css = getComputedStyle(document.documentElement);
  const get = (name: string) => css.getPropertyValue(name).trim();
  return {
    "var(--chart-1)": get("--chart-1") || "#076C80",
    "var(--success-fg)": get("--success-fg") || "#047857",
    "var(--warning-fg)": get("--warning-fg") || "#B45309",
    "var(--danger-fg)": get("--danger-fg") || "#B91C1C",
    surface: get("--surface") || "#FFFFFF",
    text: get("--text") || "#0F1729",
    border: get("--border-strong") || "#C2CBDA",
  };
}

export function toneColour(theme: ThemeColours, tone: MapPoint["tone"]): string {
  const v = TONE_VAR[tone ?? "neutral"];
  return theme[v] ?? v;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

/** The numbered stop pin, as markup both renderers can mount. */
export function sequencePinHtml(sequence: number, colour: string, theme: ThemeColours): string {
  return `<span class="raut-seq-pin" style="color:#ffffff;background:${colour};border-color:${theme.surface}">${sequence}</span>`;
}

/** The plain dot pin — the same two-tone marker across both renderers. */
export function dotPinHtml(colour: string, theme: ThemeColours): string {
  return `<span class="raut-dot-pin" style="background:${colour};border-color:${theme.surface}"></span>`;
}

/** Resolves a path of ids to the points it names, dropping unknown ids. */
export function pathPointsOf(points: MapPoint[], path: string[]): MapPoint[] {
  const byId = new Map(points.map((p) => [p.id, p]));
  return path.map((id) => byId.get(id)).filter((p): p is MapPoint => Boolean(p));
}

export function allCoordinates(
  points: MapPoint[],
  polygons: NonNullable<TileMapProps["polygons"]>,
): Array<[number, number]> {
  return [
    ...points.map((p) => [p.lat, p.lng] as [number, number]),
    ...polygons.flatMap((poly) => poly.vertices),
  ];
}
