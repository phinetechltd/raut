import type { MapPoint } from "./data-display";

/**
 * Shared by the OpenStreetMap (Leaflet) and Google Maps renderers so the two
 * draw the same pins in the same colours. Only the basemap differs — a user
 * who switches provider should recognise every marker.
 */

export interface MapTrack {
  id: string;
  colour: string;
  /** [lat, lng] breadcrumbs, oldest first. */
  coords: Array<[number, number]>;
}

export interface TileMapProps {
  points: MapPoint[];
  polygons?: Array<{ id: string; colour: string; vertices: Array<[number, number]> }>;
  /** Ids of points to connect in order — a route's stop sequence. */
  path?: string[];
  /** Driven trails (GPS breadcrumbs), drawn solid under the dashed plan. */
  tracks?: MapTrack[];
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
    surface: get("--surface") || "#FFFDF9",
    text: get("--text") || "#211A14",
    border: get("--border-strong") || "#D4C5AE",
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

/**
 * The vehicle pin: a small rounded van silhouette in the tone colour. Markup,
 * not an image, so it recolours with the theme like the other two pins.
 */
export function vehiclePinHtml(colour: string, theme: ThemeColours): string {
  return (
    `<span class="raut-vehicle-pin" style="background:${colour};border-color:${theme.surface}">` +
    `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false">` +
    `<path fill="#ffffff" d="M3 7.5A1.5 1.5 0 0 1 4.5 6H14l4.2 4.2H20a1 1 0 0 1 1 1V15a1 1 0 0 1-1 1h-1.1a2.4 2.4 0 0 1-4.8 0H9.9a2.4 2.4 0 0 1-4.8 0H4a1 1 0 0 1-1-1V7.5Zm9.6 1v2.7h3.9L13.8 8.5h-1.2Z"/>` +
    `</svg></span>`
  );
}

/** Resolves a path of ids to the points it names, dropping unknown ids. */
export function pathPointsOf(points: MapPoint[], path: string[]): MapPoint[] {
  const byId = new Map(points.map((p) => [p.id, p]));
  return path.map((id) => byId.get(id)).filter((p): p is MapPoint => Boolean(p));
}

export function allCoordinates(
  points: MapPoint[],
  polygons: NonNullable<TileMapProps["polygons"]>,
  tracks: MapTrack[] = [],
): Array<[number, number]> {
  return [
    ...points.map((p) => [p.lat, p.lng] as [number, number]),
    ...polygons.flatMap((poly) => poly.vertices),
    ...tracks.flatMap((t) => t.coords),
  ];
}

/** Popup body shared by both renderers. */
export function popupHtml(p: MapPoint): string {
  const lines = [`<strong>${escapeHtml(p.label)}</strong>`];
  if (p.sequence) lines.push(`Stop ${p.sequence}`);
  if (p.detail) lines.push(escapeHtml(p.detail));
  return lines.join("<br>");
}
