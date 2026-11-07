/**
 * Hardware tracker payloads → one normalised fix shape.
 *
 * Pure so every format and every rejection can be unit tested. Three shapes are
 * accepted, recognised by their structure:
 *
 *   - Raut's own: `{ "positions": [ { "deviceId": "...", ... } ] }`, or a bare
 *     array, or one flat position object.
 *   - Traccar's position forwarding: `{ "position": { ... }, "device": { ... } }`.
 *     Traccar speaks over 200 device protocols, so this is the route for
 *     hardware that cannot make HTTP calls of its own.
 *
 * One bad fix never loses the batch. Trackers buffer through dead zones and
 * resend, so a batch that failed whole would be retried, and failed, forever.
 */

export interface NormalisedFix {
  deviceId: string;
  latitude: number;
  longitude: number;
  accuracyM: number | null;
  speedMps: number | null;
  heading: number | null;
  ignition: boolean | null;
  odometerKm: number | null;
  batteryPct: number | null;
  recordedAt: Date;
}

export type RejectReason =
  | "NOT_AN_OBJECT"
  | "MISSING_DEVICE_ID"
  | "INVALID_COORDINATES"
  | "NO_GPS_FIX"
  | "INVALID_TIMESTAMP"
  | "TIMESTAMP_IN_FUTURE"
  | "TIMESTAMP_TOO_OLD";

export interface RejectedFix {
  index: number;
  deviceId?: string;
  reason: RejectReason;
}

/** Most fixes one request may carry; a larger buffer should be sent in parts. */
export const MAX_FIXES_PER_REQUEST = 1000;

/** Device clocks drift, so a little future is tolerated; more means a bad clock. */
export const MAX_FUTURE_SKEW_MS = 5 * 60_000;
/** A van out of signal for a month is the longest buffer worth replaying. */
export const MAX_FIX_AGE_MS = 30 * 86_400_000;
/** Above this a reported speed is a glitch. The fix is kept, the speed is not. */
export const MAX_PLAUSIBLE_SPEED_MPS = 83; // 300 km/h

const KNOTS_TO_MPS = 0.514444;
const KMH_TO_MPS = 1 / 3.6;

type Raw = Record<string, unknown>;

function isObject(value: unknown): value is Raw {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Numbers often arrive as strings from device gateways; both are accepted. */
function num(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function first(raw: Raw, keys: string[]): unknown {
  for (const key of keys) {
    if (raw[key] !== undefined && raw[key] !== null) return raw[key];
  }
  return undefined;
}

function bool(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (value === 1 || value === "1" || value === "true") return true;
  if (value === 0 || value === "0" || value === "false") return false;
  return null;
}

/**
 * ISO strings, or Unix time as a number. Seconds and milliseconds are told apart
 * by size: 10^11 seconds is the year 5138, 10^11 milliseconds is 1973.
 */
export function parseFixTime(value: unknown): Date | null {
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+(\.\d+)?$/.test(value.trim())
        ? Number(value)
        : null;
  if (numeric !== null) {
    if (!Number.isFinite(numeric) || numeric <= 0) return null;
    return new Date(numeric < 1e11 ? numeric * 1000 : numeric);
  }
  if (typeof value !== "string" || value.trim() === "") return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function clampSpeed(mps: number | null): number | null {
  if (mps === null || mps < 0 || mps > MAX_PLAUSIBLE_SPEED_MPS) return null;
  return mps;
}

/** `speed` alone means km/h, the unit nearly every vendor dashboard reports. */
function speedOf(raw: Raw): number | null {
  const mps = num(first(raw, ["speedMps", "speed_mps"]));
  if (mps !== null) return clampSpeed(mps);
  const knots = num(first(raw, ["speedKnots", "speed_knots"]));
  if (knots !== null) return clampSpeed(knots * KNOTS_TO_MPS);
  const kmh = num(first(raw, ["speedKmh", "speed_kmh", "speed"]));
  return kmh !== null ? clampSpeed(kmh * KMH_TO_MPS) : null;
}

function odometerOf(raw: Raw): number | null {
  const km = num(first(raw, ["odometerKm", "odometer_km"]));
  if (km !== null) return km >= 0 ? km : null;
  const metres = num(first(raw, ["odometerM", "odometer_m"]));
  return metres !== null && metres >= 0 ? metres / 1000 : null;
}

function headingOf(value: unknown): number | null {
  const n = num(value);
  return n !== null && n >= 0 && n <= 360 ? n : null;
}

function percent(value: unknown): number | null {
  const n = num(value);
  return n !== null && n >= 0 && n <= 100 ? Math.round(n) : null;
}

function accuracy(value: unknown): number | null {
  const n = num(value);
  return n !== null && n >= 0 ? Math.round(n) : null;
}

/** Traccar nests a position and its device, in knots, with `attributes`. */
function fromTraccar(body: Raw): Raw {
  const position = body.position as Raw;
  const device = isObject(body.device) ? body.device : {};
  const attrs = isObject(position.attributes) ? position.attributes : {};
  return {
    deviceId: device.uniqueId ?? position.deviceId,
    latitude: position.latitude,
    longitude: position.longitude,
    accuracyM: position.accuracy,
    // Traccar always reports knots, whatever the protocol underneath used.
    speedKnots: position.speed,
    heading: position.course,
    valid: position.valid,
    recordedAt: position.fixTime ?? position.deviceTime ?? position.serverTime,
    ignition: attrs.ignition,
    batteryPct: attrs.batteryLevel,
    // `odometer` is what the vehicle reports. Traccar's `totalDistance` is only
    // its own running sum since the device was added, so it is left out.
    odometerM: attrs.odometer,
  };
}

/** Flattens any accepted body into a list of raw position objects. */
export function rawPositionsOf(body: unknown): unknown[] | null {
  if (Array.isArray(body)) return body;
  if (!isObject(body)) return null;
  if (isObject(body.position)) return [fromTraccar(body)];
  if (Array.isArray(body.positions)) return body.positions;
  return [body];
}

export function normaliseFix(
  raw: unknown,
  index: number,
  now: Date,
): { fix: NormalisedFix } | { rejected: RejectedFix } {
  if (!isObject(raw)) return { rejected: { index, reason: "NOT_AN_OBJECT" } };

  const idValue = first(raw, ["deviceId", "device_id", "imei", "uniqueId"]);
  const deviceId =
    typeof idValue === "string" || typeof idValue === "number" ? String(idValue).trim().slice(0, 64) : "";
  if (!deviceId) return { rejected: { index, reason: "MISSING_DEVICE_ID" } };

  if (raw.valid === false) return { rejected: { index, deviceId, reason: "NO_GPS_FIX" } };

  const latitude = num(first(raw, ["latitude", "lat"]));
  const longitude = num(first(raw, ["longitude", "lng", "lon"]));
  if (
    latitude === null ||
    longitude === null ||
    Math.abs(latitude) > 90 ||
    Math.abs(longitude) > 180 ||
    // 0,0 is what most units report before their first satellite lock. It is a
    // point in the Gulf of Guinea, not a van.
    (latitude === 0 && longitude === 0)
  ) {
    return { rejected: { index, deviceId, reason: "INVALID_COORDINATES" } };
  }

  const recordedAt = parseFixTime(first(raw, ["recordedAt", "timestamp", "fixTime", "time"]));
  if (!recordedAt) return { rejected: { index, deviceId, reason: "INVALID_TIMESTAMP" } };
  const age = now.getTime() - recordedAt.getTime();
  if (age < -MAX_FUTURE_SKEW_MS) return { rejected: { index, deviceId, reason: "TIMESTAMP_IN_FUTURE" } };
  if (age > MAX_FIX_AGE_MS) return { rejected: { index, deviceId, reason: "TIMESTAMP_TOO_OLD" } };

  return {
    fix: {
      deviceId,
      latitude,
      longitude,
      accuracyM: accuracy(first(raw, ["accuracyM", "accuracy"])),
      speedMps: speedOf(raw),
      heading: headingOf(first(raw, ["heading", "course", "bearing"])),
      ignition: bool(first(raw, ["ignition", "acc"])),
      odometerKm: odometerOf(raw),
      batteryPct: percent(first(raw, ["batteryPct", "battery", "batteryLevel"])),
      recordedAt,
    },
  };
}

export function normalisePayload(
  body: unknown,
  now: Date = new Date(),
): { fixes: NormalisedFix[]; rejected: RejectedFix[]; tooMany: boolean; unreadable: boolean } {
  const raws = rawPositionsOf(body);
  if (!raws) return { fixes: [], rejected: [], tooMany: false, unreadable: true };
  if (raws.length > MAX_FIXES_PER_REQUEST) return { fixes: [], rejected: [], tooMany: true, unreadable: false };

  const fixes: NormalisedFix[] = [];
  const rejected: RejectedFix[] = [];
  raws.forEach((raw, index) => {
    const result = normaliseFix(raw, index, now);
    if ("fix" in result) fixes.push(result.fix);
    else rejected.push(result.rejected);
  });
  return { fixes, rejected, tooMany: false, unreadable: false };
}

/** Key from either header. Never the query string: URLs end up in access logs. */
export function trackerKeyFrom(headers: { get(name: string): string | null }): string | null {
  const direct = headers.get("x-api-key")?.trim();
  if (direct) return direct;
  const auth = headers.get("authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim() || null;
  return null;
}
