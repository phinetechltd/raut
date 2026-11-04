import { haversineM, type LatLng } from "./geo";

/**
 * Vehicle tracking helpers — Module 07/08.
 *
 * Pure functions over breadcrumb rows, shared by the live-tracking endpoint,
 * the console page and the unit tests. Nothing here touches the database; the
 * server module (src/server/tracking.ts) does the reading and hands rows in.
 */

/** A GPS fix as both the API and the console consume it. */
export interface TrailPoint extends LatLng {
  recordedAt: Date;
  accuracyM?: number | null;
  speedMps?: number | null;
}

/**
 * Fixes worse than this are noise, not position. A phone indoors or in a
 * pocket often reports a kilometre-wide circle; drawing those drags a trail
 * across town and inflates the distance driven.
 */
export const MAX_TRAIL_ACCURACY_M = 100;

/** A rep is "live" under this; "quiet" under the next; "offline" beyond. */
export const STALE_WARNING_S = 15 * 60;
export const STALE_DANGER_S = 60 * 60;

export type StalenessTone = "success" | "warning" | "danger";

/** Seconds since the fix, never negative — a fast handset clock is not "future". */
export function stalenessSeconds(recordedAt: Date, now: Date = new Date()): number {
  return Math.max(0, Math.round((now.getTime() - recordedAt.getTime()) / 1000));
}

/**
 * Colour for a rep's last-seen marker. Under 15 minutes the office can act on
 * the position; under an hour it is a guide; past that the van may be anywhere.
 */
export function stalenessTone(seconds: number): StalenessTone {
  if (seconds < STALE_WARNING_S) return "success";
  if (seconds < STALE_DANGER_S) return "warning";
  return "danger";
}

/** "just now", "12 min ago", "3 h ago" — for the live table. */
export function stalenessLabel(seconds: number): string {
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h ago`;
  return `${Math.round(seconds / 86_400)} d ago`;
}

/** Drops fixes with no usable accuracy. Unknown accuracy is kept: old handsets omit it. */
export function dropInaccurate<T extends { accuracyM?: number | null }>(
  points: T[],
  maxAccuracyM: number = MAX_TRAIL_ACCURACY_M,
): T[] {
  return points.filter((p) => p.accuracyM == null || p.accuracyM <= maxAccuracyM);
}

/**
 * Evenly thins a trail to at most `max` points, always keeping the first and
 * last so the trail still starts and ends where the day did. A day at a
 * 60-second heartbeat is ~600 fixes; a busy rep with the distance filter can
 * produce several thousand, more than a browser needs to draw a line.
 */
export function downsample<T>(points: T[], max: number): T[] {
  if (max < 2) return points.slice(0, Math.max(0, max));
  if (points.length <= max) return points;

  const out: T[] = [];
  const step = (points.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) {
    out.push(points[Math.round(i * step)]);
  }
  return out;
}

/**
 * Metres driven along a trail — the haversine sum of consecutive fixes.
 *
 * Accuracy filtering happens first and jitter below `minStepM` is ignored,
 * otherwise a van parked for an hour "drives" a few hundred metres standing
 * still as the fix wanders. Returned rounded to the metre.
 */
export function trailDistanceM(points: LatLng[], minStepM = 5): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const d = haversineM(points[i - 1], points[i]);
    if (d >= minStepM) total += d;
  }
  return Math.round(total);
}

/** Sorts breadcrumbs oldest-first without mutating the input. */
export function chronological<T extends { recordedAt: Date }>(points: T[]): T[] {
  return [...points].sort((a, b) => a.recordedAt.getTime() - b.recordedAt.getTime());
}

/** km/h for display, from the m/s the handset reports; null stays null. */
export function speedKmh(speedMps: number | null | undefined): number | null {
  if (speedMps == null || !Number.isFinite(speedMps) || speedMps < 0) return null;
  return Math.round(speedMps * 3.6);
}

/** Plan vs. GPS: how far off the planned distance the day actually ran. */
export function distanceVariance(
  plannedM: number,
  actualM: number | null | undefined,
): { deltaM: number; pct: number } | null {
  if (actualM == null || plannedM <= 0) return null;
  const deltaM = actualM - plannedM;
  return { deltaM, pct: Math.round((deltaM / plannedM) * 100) };
}

/** Progress label for a route: done stops over the stops that still count. */
export function routeProgress(
  stops: Array<{ status: string }>,
): { done: number; total: number; skipped: number } {
  const skipped = stops.filter((s) => s.status === "SKIPPED").length;
  const done = stops.filter((s) => s.status === "DONE").length;
  return { done, total: stops.length - skipped, skipped };
}

/**
 * Colour per rep for the live map, stable across refreshes: the same rep gets
 * the same colour whichever order the rows arrive in.
 */
export const TRACK_COLOURS = [
  "#076C80", "#B45309", "#6D28D9", "#047857", "#BE185D", "#1D4ED8", "#9A3412", "#0F766E",
] as const;

export function trackColour(key: string): string {
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  return TRACK_COLOURS[hash % TRACK_COLOURS.length];
}
