import "server-only";

import { createHash, randomBytes } from "node:crypto";

import { ApiError, conflict, notFound } from "@/lib/api";
import { db } from "@/lib/db";
import { isSelfScoped, type Principal } from "@/lib/rbac";
import { companyIdOf } from "@/lib/tenant";
import type { NormalisedFix } from "@/lib/tracker-ingest";
import {
  MAX_TRAIL_ACCURACY_M,
  chronological,
  dropInaccurate,
  dropTeleports,
  nairobiDay,
  nairobiDayBounds,
  pickVehicleFix,
  routeProgress,
  speedKmh,
  stalenessSeconds,
  tripSummary,
  vehicleStatus,
  type TripSummary,
  type VehicleStatus,
} from "@/lib/tracking";

/**
 * Hardware GPS trackers: the API keys that let them report, the devices behind
 * those keys, and the fleet's positions.
 *
 * Rep handsets write LocationPing under their user's session. A tracker has no
 * user, so it authenticates with a company API key instead, and the company it
 * writes to comes from that key and never from the request body.
 */

const KEY_PREFIX = "rtk_";
/** Unknown ids create device rows, so a leaked key must not be able to fill the table. */
const MAX_DEVICES_PER_COMPANY = 2000;

export interface IssuedKey {
  apiKey: string;
  keyHash: string;
  keyPrefix: string;
}

function hashKey(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex");
}

export function issueTrackerKey(): IssuedKey {
  const apiKey = `${KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
  return { apiKey, keyHash: hashKey(apiKey), keyPrefix: apiKey.slice(0, 12) };
}

export interface TrackerCaller {
  id: string;
  companyId: string;
  name: string;
}

/**
 * Resolves a presented key. The key is high-entropy and compared by its hash, so
 * there is nothing to brute force and no timing to learn from the lookup. A
 * suspended company or an unlicensed module is refused here, so a tracker loses
 * access at the same moment the people do.
 */
export async function authenticateTracker(apiKey: string): Promise<TrackerCaller> {
  const row = await db.trackerIntegration.findUnique({
    where: { keyHash: hashKey(apiKey) },
    select: {
      id: true,
      companyId: true,
      name: true,
      active: true,
      company: { select: { status: true } },
    },
  });
  if (!row || !row.active) throw new ApiError(401, "INVALID_API_KEY", "This API key is not valid");
  if (row.company.status !== "ACTIVE") throw new ApiError(403, "COMPANY_SUSPENDED", "This company is suspended");

  const licence = await db.companyModule.findFirst({
    where: { companyId: row.companyId, moduleKey: "ROUTING", enabled: true },
    select: { id: true },
  });
  if (!licence) {
    throw new ApiError(402, "MODULE_NOT_LICENSED", "Routing & vehicle tracking is not part of this subscription");
  }
  return { id: row.id, companyId: row.companyId, name: row.name };
}

export interface IngestResult {
  accepted: number;
  duplicates: number;
  /** Fixes for devices no vehicle is assigned to yet; not stored as history. */
  unassigned: number;
  /** Fixes for devices an admin has switched off. */
  ignored: number;
  unassignedDevices: string[];
}

/**
 * Stores a batch of fixes. A resent batch is harmless: fixes are unique per
 * device per instant, and the ones already stored are counted as duplicates so
 * the sender can stop retrying.
 */
export async function ingestFixes(caller: TrackerCaller, fixes: NormalisedFix[]): Promise<IngestResult> {
  const result: IngestResult = { accepted: 0, duplicates: 0, unassigned: 0, ignored: 0, unassignedDevices: [] };
  const now = new Date();

  if (fixes.length === 0) {
    await db.trackerIntegration.update({ where: { id: caller.id }, data: { lastUsedAt: now } });
    return result;
  }

  const externalIds = [...new Set(fixes.map((f) => f.deviceId))];
  const known = await db.trackerDevice.findMany({
    where: { companyId: caller.companyId, externalId: { in: externalIds } },
    select: { id: true, externalId: true, vehicleId: true, active: true, lastFixAt: true },
  });
  const devices = new Map(known.map((d) => [d.externalId, d]));

  const missing = externalIds.filter((id) => !devices.has(id));
  if (missing.length > 0) {
    const count = await db.trackerDevice.count({ where: { companyId: caller.companyId } });
    for (const externalId of missing.slice(0, Math.max(0, MAX_DEVICES_PER_COMPANY - count))) {
      const device = await db.trackerDevice
        .create({
          data: { companyId: caller.companyId, integrationId: caller.id, externalId },
          select: { id: true, externalId: true, vehicleId: true, active: true, lastFixAt: true },
        })
        // Two concurrent batches can both see the device as new. The loser reads
        // the winner's row rather than failing the batch.
        .catch(() =>
          db.trackerDevice.findUnique({
            where: { companyId_externalId: { companyId: caller.companyId, externalId } },
            select: { id: true, externalId: true, vehicleId: true, active: true, lastFixAt: true },
          }),
        );
      if (device) devices.set(externalId, device);
    }
  }

  const byDevice = new Map<string, NormalisedFix[]>();
  for (const fix of fixes) {
    const list = byDevice.get(fix.deviceId) ?? [];
    list.push(fix);
    byDevice.set(fix.deviceId, list);
  }

  const unassigned = new Set<string>();
  for (const [externalId, deviceFixes] of byDevice) {
    const device = devices.get(externalId);
    if (!device) {
      // Past the device cap: reported back as unassigned, nothing stored.
      result.unassigned += deviceFixes.length;
      unassigned.add(externalId);
      continue;
    }
    if (!device.active) {
      result.ignored += deviceFixes.length;
      continue;
    }

    const newest = deviceFixes.reduce((a, b) => (b.recordedAt > a.recordedAt ? b : a));
    const isNewer = !device.lastFixAt || newest.recordedAt >= device.lastFixAt;
    await db.trackerDevice.update({
      where: { id: device.id },
      data: {
        lastSeenAt: now,
        integrationId: caller.id,
        ...(isNewer
          ? { lastFixAt: newest.recordedAt, lastLatitude: newest.latitude, lastLongitude: newest.longitude }
          : {}),
      },
    });

    if (!device.vehicleId) {
      result.unassigned += deviceFixes.length;
      unassigned.add(externalId);
      continue;
    }

    const { inserted, duplicates } = await insertPositions(caller.companyId, device.id, device.vehicleId, deviceFixes);
    result.accepted += inserted;
    result.duplicates += duplicates;
    await advanceOdometer(device.vehicleId, deviceFixes);
  }

  result.unassignedDevices = [...unassigned];
  await db.trackerIntegration.update({ where: { id: caller.id }, data: { lastUsedAt: now } });
  return result;
}

async function insertPositions(
  companyId: string,
  deviceId: string,
  vehicleId: string,
  fixes: NormalisedFix[],
): Promise<{ inserted: number; duplicates: number }> {
  const instants = fixes.map((f) => f.recordedAt.getTime());
  const existing = await db.vehiclePosition.findMany({
    where: {
      deviceId,
      recordedAt: { gte: new Date(Math.min(...instants)), lte: new Date(Math.max(...instants)) },
    },
    select: { recordedAt: true },
  });
  const seen = new Set(existing.map((e) => e.recordedAt.getTime()));

  const rows = [];
  for (const fix of fixes) {
    const instant = fix.recordedAt.getTime();
    if (seen.has(instant)) continue;
    seen.add(instant);
    rows.push({
      companyId,
      deviceId,
      vehicleId,
      latitude: fix.latitude,
      longitude: fix.longitude,
      accuracyM: fix.accuracyM,
      speedMps: fix.speedMps,
      heading: fix.heading,
      ignition: fix.ignition,
      odometerKm: fix.odometerKm,
      batteryPct: fix.batteryPct,
      recordedAt: fix.recordedAt,
    });
  }

  let inserted = 0;
  if (rows.length > 0) {
    try {
      inserted = (await db.vehiclePosition.createMany({ data: rows })).count;
    } catch (error) {
      // A racing resend of the same batch got in between the read and the write.
      if (!(error instanceof Error && error.message.includes("Unique constraint"))) throw error;
      for (const row of rows) {
        try {
          await db.vehiclePosition.create({ data: row });
          inserted++;
        } catch (inner) {
          if (!(inner instanceof Error && inner.message.includes("Unique constraint"))) throw inner;
        }
      }
    }
  }
  return { inserted, duplicates: fixes.length - inserted };
}

/**
 * An odometer only runs forwards. A lower reading is a replaced unit or a
 * tracker that counts from its own install, and must not wind the van back.
 */
async function advanceOdometer(vehicleId: string, fixes: NormalisedFix[]): Promise<void> {
  const readings = fixes.map((f) => f.odometerKm).filter((k): k is number => k !== null);
  if (readings.length === 0) return;
  const reading = Math.floor(Math.max(...readings));
  await db.vehicle.updateMany({
    where: { id: vehicleId, OR: [{ odometerKm: null }, { odometerKm: { lt: reading } }] },
    data: { odometerKm: reading },
  });
}

// ── reading the fleet ──────────────────────────────────────────────────

export interface VehicleFix {
  latitude: number;
  longitude: number;
  recordedAt: Date;
  speedKmh: number | null;
  heading: number | null;
  accuracyM: number | null;
  ignition: boolean | null;
  batteryPct: number | null;
  source: "TRACKER" | "PHONE";
}

export interface FleetVehicle {
  id: string;
  plate: string;
  make: string | null;
  model: string | null;
  type: string;
  active: boolean;
  driver: { id: string; name: string } | null;
  route: { id: string; name: string; status: string; done: number; total: number } | null;
  tracker: { id: string; externalId: string; lastSeenAt: Date | null } | null;
  fix: VehicleFix | null;
  status: VehicleStatus;
  stalenessS: number | null;
}

interface RawFix {
  latitude: number;
  longitude: number;
  recordedAt: Date;
  speedMps: number | null;
  heading: number | null;
  accuracyM: number | null;
  ignition: boolean | null;
  batteryPct: number | null;
  isMoving: boolean | null;
}

const USABLE_ACCURACY = {
  OR: [{ accuracyM: null }, { accuracyM: { lte: MAX_TRAIL_ACCURACY_M } }],
};

/** Vehicles a self-scoped role may follow: the one they usually drive, or are out in today. */
async function vehicleIdsForRep(companyId: string, userId: string, now: Date): Promise<string[]> {
  const today = nairobiDayBounds(nairobiDay(now))!;
  const [usual, routes] = await Promise.all([
    db.vehicle.findMany({ where: { companyId, defaultRepId: userId, active: true }, select: { id: true } }),
    db.route.findMany({
      where: { companyId, repId: userId, routeDate: { gte: today.start, lt: today.end }, vehicleId: { not: null } },
      select: { vehicleId: true },
    }),
  ]);
  return [...new Set([...usual.map((v) => v.id), ...routes.flatMap((r) => (r.vehicleId ? [r.vehicleId] : []))])];
}

/**
 * Every vehicle's last known position, newest source chosen per van, with its
 * driver and today's route. A van with no recent fix still appears, because a
 * vehicle that has dropped off the map is the one the office most needs to see.
 */
export async function fleetPositions(principal: Principal, now: Date = new Date()): Promise<FleetVehicle[]> {
  const companyId = companyIdOf(principal);
  const today = nairobiDayBounds(nairobiDay(now))!;
  const repVehicles = isSelfScoped(principal) ? await vehicleIdsForRep(companyId, principal.userId, now) : null;

  const vehicles = await db.vehicle.findMany({
    where: {
      companyId,
      active: true,
      ...(repVehicles ? { id: { in: repVehicles } } : {}),
    },
    include: {
      tracker: { select: { id: true, externalId: true, active: true, lastSeenAt: true } },
      routes: {
        where: { routeDate: { gte: today.start, lt: today.end }, status: { in: ["PLANNED", "ACTIVE", "COMPLETED"] } },
        select: {
          id: true,
          name: true,
          status: true,
          createdAt: true,
          rep: { select: { id: true, name: true } },
          stops: { select: { status: true } },
        },
        orderBy: { createdAt: "desc" },
      },
    },
    orderBy: { plate: "asc" },
    take: 200,
  });

  const defaultRepIds = [...new Set(vehicles.flatMap((v) => (v.defaultRepId ? [v.defaultRepId] : [])))];
  const defaultReps = await db.user.findMany({
    where: { id: { in: defaultRepIds }, companyId },
    select: { id: true, name: true },
  });
  const repById = new Map(defaultReps.map((r) => [r.id, r]));

  // One indexed newest-row lookup per van. The fleet is capped above and a
  // day's rows for a chatty tracker run to thousands, so this beats scanning.
  const phoneCutoff = new Date(now.getTime() - 86_400_000);
  return Promise.all(
    vehicles.map(async (vehicle) => {
      const route = vehicle.routes.find((r) => r.status === "ACTIVE") ?? vehicle.routes[0] ?? null;
      const driver = route?.rep ?? (vehicle.defaultRepId ? repById.get(vehicle.defaultRepId) ?? null : null);

      const hardware = await db.vehiclePosition.findFirst({
        where: { companyId, vehicleId: vehicle.id, ...USABLE_ACCURACY },
        orderBy: { recordedAt: "desc" },
      });
      const phone = await db.locationPing.findFirst({
        where: {
          companyId,
          ...USABLE_ACCURACY,
          OR: [
            { vehicleId: vehicle.id },
            // No route planned on the van today: its usual driver's phone is
            // still the best evidence of where it is, if nothing better exists.
            ...(driver && !route ? [{ userId: driver.id, recordedAt: { gte: phoneCutoff } }] : []),
          ],
        },
        orderBy: { recordedAt: "desc" },
      });

      const picked = pickVehicleFix<RawFix>(
        hardware ? { ...hardware, isMoving: null } : null,
        phone ? { ...phone, ignition: null } : null,
      );

      return {
        id: vehicle.id,
        plate: vehicle.plate,
        make: vehicle.make,
        model: vehicle.model,
        type: vehicle.type,
        active: vehicle.active,
        driver,
        route: route
          ? { id: route.id, name: route.name, status: route.status, ...pickProgress(route.stops) }
          : null,
        tracker:
          vehicle.tracker && vehicle.tracker.active
            ? {
                id: vehicle.tracker.id,
                externalId: vehicle.tracker.externalId,
                lastSeenAt: vehicle.tracker.lastSeenAt,
              }
            : null,
        fix: picked
          ? {
              latitude: picked.fix.latitude,
              longitude: picked.fix.longitude,
              recordedAt: picked.fix.recordedAt,
              speedKmh: speedKmh(picked.fix.speedMps),
              heading: picked.fix.heading,
              accuracyM: picked.fix.accuracyM,
              ignition: picked.fix.ignition,
              batteryPct: picked.fix.batteryPct,
              source: picked.source,
            }
          : null,
        status: vehicleStatus(picked?.fix ?? null, now),
        stalenessS: picked ? stalenessSeconds(picked.fix.recordedAt, now) : null,
      } satisfies FleetVehicle;
    }),
  );
}

function pickProgress(stops: Array<{ status: string }>): { done: number; total: number } {
  const { done, total } = routeProgress(stops);
  return { done, total };
}

export interface TrackPoint {
  latitude: number;
  longitude: number;
  recordedAt: Date;
  speedKmh: number | null;
  heading: number | null;
  ignition: boolean | null;
}

export interface VehicleTrack {
  vehicle: { id: string; plate: string; make: string | null; model: string | null; odometerKm: number | null };
  date: string;
  source: "TRACKER" | "PHONE" | null;
  points: TrackPoint[];
  summary: TripSummary;
}

/**
 * One van's day: the tracker's fixes if it reported, otherwise the phone trail
 * stamped with the van. Never the two merged, because two sources side by side
 * zigzag between each other and inflate the distance.
 */
export async function vehicleTrack(principal: Principal, vehicleId: string, date: string): Promise<VehicleTrack> {
  const companyId = companyIdOf(principal);
  const bounds = nairobiDayBounds(date);
  if (!bounds) throw new ApiError(400, "BAD_REQUEST", "date must be a real calendar day, as YYYY-MM-DD");

  const vehicle = await db.vehicle.findFirst({
    where: { id: vehicleId, companyId },
    select: { id: true, plate: true, make: true, model: true, odometerKm: true },
  });
  if (!vehicle) throw notFound("Vehicle not found");
  if (isSelfScoped(principal)) {
    const mine = await vehicleIdsForRep(companyId, principal.userId, new Date());
    if (!mine.includes(vehicleId)) throw notFound("Vehicle not found");
  }

  const window = { gte: bounds.start, lt: bounds.end };
  const hardware = await db.vehiclePosition.findMany({
    where: { companyId, vehicleId, recordedAt: window },
    orderBy: { recordedAt: "asc" },
    take: 50_000,
  });

  let source: VehicleTrack["source"] = null;
  let raw: Array<Omit<TrackPoint, "speedKmh"> & { speedMps: number | null; accuracyM: number | null }> = [];
  if (hardware.length > 0) {
    source = "TRACKER";
    raw = hardware;
  } else {
    const phone = await db.locationPing.findMany({
      where: { companyId, vehicleId, recordedAt: window },
      orderBy: { recordedAt: "asc" },
      take: 50_000,
    });
    if (phone.length > 0) source = "PHONE";
    raw = phone.map((p) => ({ ...p, ignition: null }));
  }

  const usable = dropInaccurate(chronological(raw)).map((p) => ({ ...p, lat: p.latitude, lng: p.longitude }));
  const clean = dropTeleports(usable);

  return {
    vehicle,
    date,
    source,
    points: clean.map((p) => ({
      latitude: p.latitude,
      longitude: p.longitude,
      recordedAt: p.recordedAt,
      speedKmh: speedKmh(p.speedMps),
      heading: p.heading,
      ignition: p.ignition,
    })),
    summary: tripSummary(clean),
  };
}

/**
 * Metres the van drove on a day according to its tracker, for a route whose
 * driver's phone reported too little to measure. Null when there is no tracker
 * data, so the caller can tell "no evidence" from "did not move".
 */
export async function trackerDistanceFor(companyId: string, vehicleId: string, start: Date, end: Date): Promise<number | null> {
  const rows = await db.vehiclePosition.findMany({
    where: { companyId, vehicleId, recordedAt: { gte: start, lt: end } },
    select: { latitude: true, longitude: true, accuracyM: true, recordedAt: true },
    orderBy: { recordedAt: "asc" },
    take: 50_000,
  });
  if (rows.length < 2) return null;
  const points = dropInaccurate(rows).map((r) => ({ lat: r.latitude, lng: r.longitude, recordedAt: r.recordedAt }));
  return tripSummary(points).distanceM;
}

// ── assignment ─────────────────────────────────────────────────────────

/** One tracker per van. A second would have two sources fighting over one pin. */
export async function assertVehicleFree(companyId: string, vehicleId: string, deviceId: string): Promise<void> {
  const vehicle = await db.vehicle.findFirst({
    where: { id: vehicleId, companyId },
    select: { plate: true, tracker: { select: { id: true, externalId: true } } },
  });
  if (!vehicle) throw new ApiError(400, "BAD_REQUEST", "Vehicle not found");
  if (vehicle.tracker && vehicle.tracker.id !== deviceId) {
    throw conflict(`${vehicle.plate} already has tracker ${vehicle.tracker.externalId}. Unassign it first.`);
  }
}
