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

// ── fleet view ─────────────────────────────────────────────────────────

/** Faster than a walk: the van is driving, whatever ignition says. */
export const MOVING_SPEED_MPS = 1.5;

/**
 * A running van reports every few seconds, so an hour of silence means trouble.
 * A van with its ignition off may only send a heartbeat a few times a day to
 * save its battery, so the same silence there is normal.
 */
export const OFFLINE_AFTER_S = 60 * 60;
export const OFFLINE_AFTER_PARKED_S = 24 * 60 * 60;

export const VEHICLE_STATUSES = ["MOVING", "IDLE", "PARKED", "OFFLINE", "NO_SIGNAL"] as const;
export type VehicleStatus = (typeof VEHICLE_STATUSES)[number];

export const VEHICLE_STATUS_LABELS: Record<VehicleStatus, string> = {
  MOVING: "Moving",
  IDLE: "Idling",
  PARKED: "Parked",
  OFFLINE: "Offline",
  NO_SIGNAL: "No signal yet",
};

export const VEHICLE_STATUS_TONES: Record<VehicleStatus, StalenessTone | "neutral"> = {
  MOVING: "success",
  IDLE: "warning",
  PARKED: "neutral",
  OFFLINE: "danger",
  NO_SIGNAL: "neutral",
};

export interface FixState {
  recordedAt: Date;
  speedMps?: number | null;
  ignition?: boolean | null;
  /** The handset's own motion flag; trackers leave it out. */
  isMoving?: boolean | null;
}

export function vehicleStatus(fix: FixState | null | undefined, now: Date = new Date()): VehicleStatus {
  if (!fix) return "NO_SIGNAL";
  const age = stalenessSeconds(fix.recordedAt, now);
  if (age >= (fix.ignition === false ? OFFLINE_AFTER_PARKED_S : OFFLINE_AFTER_S)) return "OFFLINE";
  if (fix.speedMps != null && fix.speedMps > MOVING_SPEED_MPS) return "MOVING";
  if (fix.ignition === true) return "IDLE";
  if (fix.ignition === false) return "PARKED";
  // Phones have no ignition line, so this is the only other evidence of motion.
  if (fix.speedMps == null && fix.isMoving === true) return "MOVING";
  return "PARKED";
}

/**
 * Which fix to believe when a van has both a tracker and a driver's phone. The
 * tracker is bolted to the van and the phone can walk off with the driver, so
 * the tracker wins unless it has gone quiet while the phone kept reporting.
 */
export function pickVehicleFix<T extends { recordedAt: Date }>(
  tracker: T | null | undefined,
  phone: T | null | undefined,
  quietAfterMs: number = STALE_WARNING_S * 1000,
): { fix: T; source: "TRACKER" | "PHONE" } | null {
  if (tracker && phone) {
    const phoneLead = phone.recordedAt.getTime() - tracker.recordedAt.getTime();
    return phoneLead > quietAfterMs ? { fix: phone, source: "PHONE" } : { fix: tracker, source: "TRACKER" };
  }
  if (tracker) return { fix: tracker, source: "TRACKER" };
  if (phone) return { fix: phone, source: "PHONE" };
  return null;
}

/** A hop implying more than this is a bad fix, not a very fast van. */
export const MAX_TRAIL_SPEED_MPS = 83;
/** Stopped this long in one place counts as a stop on the day's trip. */
export const STOP_MIN_S = 5 * 60;
export const STOP_RADIUS_M = 50;
/** No fix for this long is a gap in the data, not time spent driving. */
const MAX_GAP_S = 10 * 60;

export interface TripPoint extends LatLng {
  recordedAt: Date;
  speedMps?: number | null;
}

export interface TripStop extends LatLng {
  arrivedAt: Date;
  departedAt: Date;
  durationS: number;
}

export interface TripSummary {
  distanceM: number;
  movingS: number;
  maxSpeedKmh: number | null;
  firstFixAt: Date | null;
  lastFixAt: Date | null;
  stops: TripStop[];
  fixCount: number;
}

/** Removes single-fix jumps across town. Expects oldest-first points. */
export function dropTeleports<T extends TripPoint>(points: T[], maxSpeedMps: number = MAX_TRAIL_SPEED_MPS): T[] {
  const kept: T[] = [];
  for (const point of points) {
    const previous = kept[kept.length - 1];
    if (previous) {
      const seconds = (point.recordedAt.getTime() - previous.recordedAt.getTime()) / 1000;
      if (seconds > 0 && haversineM(previous, point) / seconds > maxSpeedMps) continue;
    }
    kept.push(point);
  }
  return kept;
}

/** A day's driving from its fixes: distance, time moving, top speed and stops. */
export function tripSummary(rawPoints: TripPoint[]): TripSummary {
  const points = dropTeleports(chronological(rawPoints));
  const reported = points.map((p) => speedKmh(p.speedMps)).filter((s): s is number => s !== null);

  let movingS = 0;
  for (let i = 1; i < points.length; i++) {
    const seconds = (points[i].recordedAt.getTime() - points[i - 1].recordedAt.getTime()) / 1000;
    if (seconds <= 0 || seconds > MAX_GAP_S) continue;
    if (haversineM(points[i - 1], points[i]) / seconds > MOVING_SPEED_MPS) movingS += seconds;
  }

  const stops: TripStop[] = [];
  let anchor = 0;
  const closeStop = (end: number) => {
    const from = points[anchor];
    const to = points[end];
    const durationS = (to.recordedAt.getTime() - from.recordedAt.getTime()) / 1000;
    if (durationS >= STOP_MIN_S) {
      stops.push({
        lat: from.lat,
        lng: from.lng,
        arrivedAt: from.recordedAt,
        departedAt: to.recordedAt,
        durationS: Math.round(durationS),
      });
    }
  };
  for (let i = 1; i < points.length; i++) {
    if (haversineM(points[anchor], points[i]) > STOP_RADIUS_M) {
      closeStop(i - 1);
      anchor = i;
    }
  }
  if (points.length > 0) closeStop(points.length - 1);

  return {
    distanceM: points.length >= 2 ? trailDistanceM(points) : 0,
    movingS: Math.round(movingS),
    maxSpeedKmh: reported.length ? Math.max(...reported) : null,
    firstFixAt: points[0]?.recordedAt ?? null,
    lastFixAt: points[points.length - 1]?.recordedAt ?? null,
    stops,
    fixCount: points.length,
  };
}

/** "2 h 05 min", "12 min", "45 s". */
export function durationLabel(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} min`;
}

/** The calendar day in Nairobi, as YYYY-MM-DD. Kenya has no daylight saving. */
export function nairobiDay(at: Date = new Date()): string {
  return new Date(at.getTime() + 3 * 3_600_000).toISOString().slice(0, 10);
}

/** Bounds of a Nairobi calendar day, or null for anything that is not a date. */
export function nairobiDayBounds(day: string): { start: Date; end: Date } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const start = new Date(`${day}T00:00:00+03:00`);
  if (Number.isNaN(start.getTime())) return null;
  // `2026-02-31` parses forward into March; that is not the day that was asked for.
  if (nairobiDay(start) !== day) return null;
  return { start, end: new Date(start.getTime() + 86_400_000) };
}
