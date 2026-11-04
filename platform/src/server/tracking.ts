import "server-only";

import { db } from "@/lib/db";
import type { Principal } from "@/lib/rbac";
import { scope } from "@/lib/tenant";
import {
  chronological,
  dropInaccurate,
  routeProgress,
  speedKmh,
  stalenessSeconds,
  stalenessTone,
  trailDistanceM,
} from "@/lib/tracking";

/**
 * Module 07/08 · Vehicle tracking — the database side.
 *
 * Breadcrumbs arrive from handsets knowing nothing about routes or vehicles;
 * the server stamps them with the rep's route for that day (and so the van)
 * as they land. Stamping at write time, rather than joining on dates at read
 * time, is what lets a trail be pulled per vehicle in one indexed query and
 * keeps the day's distance attributable even after the route is edited.
 */

export interface IncomingPing {
  latitude: number;
  longitude: number;
  accuracyM?: number | null;
  speedMps?: number | null;
  heading?: number | null;
  batteryPct?: number | null;
  isMoving?: boolean | null;
  recordedAt: Date;
}

function dayStartOf(at: Date): Date {
  const d = new Date(at);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * The rep's route for the day containing `at`: the ACTIVE one if any, else
 * the most recently planned. Returns null when the rep had no route that day,
 * in which case breadcrumbs are stored unattributed — still a trail, just not
 * a route's trail.
 */
export async function activeRouteFor(
  companyId: string,
  repId: string,
  at: Date,
): Promise<{ id: string; vehicleId: string | null; status: string } | null> {
  const start = dayStartOf(at);
  const end = new Date(start.getTime() + 86_400_000);
  const routes = await db.route.findMany({
    where: {
      companyId,
      repId,
      routeDate: { gte: start, lt: end },
      status: { in: ["PLANNED", "ACTIVE", "COMPLETED"] },
    },
    select: { id: true, vehicleId: true, status: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  });
  if (routes.length === 0) return null;
  return routes.find((r) => r.status === "ACTIVE") ?? routes[0];
}

/**
 * Stores a batch of breadcrumbs for one rep, stamped with route and vehicle.
 *
 * The (userId, recordedAt) unique key is what makes a resent batch harmless:
 * the handset retries a push it never saw a reply to, and before this every
 * retry doubled the trail.
 */
export async function storePings(
  companyId: string,
  userId: string,
  pings: IncomingPing[],
): Promise<{ recorded: number; routeIds: string[] }> {
  if (pings.length === 0) return { recorded: 0, routeIds: [] };

  // One route lookup per calendar day in the batch, not one per ping.
  const byDay = new Map<number, Awaited<ReturnType<typeof activeRouteFor>>>();
  for (const ping of pings) {
    const key = dayStartOf(ping.recordedAt).getTime();
    if (!byDay.has(key)) {
      byDay.set(key, await activeRouteFor(companyId, userId, ping.recordedAt));
    }
  }

  // SQLite has no `skipDuplicates`, so the dedupe is explicit: drop the
  // instants already stored for this rep (and repeats within the batch), then
  // insert the rest. A racing second push of the same batch can still trip the
  // unique key between the read and the write; that path falls back to
  // row-by-row inserts that ignore the collisions.
  const instants = pings.map((p) => p.recordedAt.getTime());
  const existing = await db.locationPing.findMany({
    where: {
      userId,
      recordedAt: { gte: new Date(Math.min(...instants)), lte: new Date(Math.max(...instants)) },
    },
    select: { recordedAt: true },
  });
  const seen = new Set(existing.map((e) => e.recordedAt.getTime()));

  const rows = [];
  for (const p of pings) {
    const key = p.recordedAt.getTime();
    if (seen.has(key)) continue;
    seen.add(key);
    const route = byDay.get(dayStartOf(p.recordedAt).getTime()) ?? null;
    rows.push({
      companyId,
      userId,
      routeId: route?.id ?? null,
      vehicleId: route?.vehicleId ?? null,
      latitude: p.latitude,
      longitude: p.longitude,
      accuracyM: p.accuracyM != null ? Math.round(p.accuracyM) : null,
      speedMps: p.speedMps ?? null,
      heading: p.heading ?? null,
      batteryPct: p.batteryPct != null ? Math.round(p.batteryPct) : null,
      isMoving: p.isMoving ?? true,
      recordedAt: p.recordedAt,
    });
  }

  let recorded = 0;
  if (rows.length > 0) {
    try {
      recorded = (await db.locationPing.createMany({ data: rows })).count;
    } catch (error) {
      if (!(error instanceof Error && error.message.includes("Unique constraint"))) throw error;
      for (const row of rows) {
        try {
          await db.locationPing.create({ data: row });
          recorded++;
        } catch (inner) {
          if (!(inner instanceof Error && inner.message.includes("Unique constraint"))) throw inner;
        }
      }
    }
  }

  const routeIds = [...new Set([...byDay.values()].flatMap((r) => (r ? [r.id] : [])))];
  return { recorded, routeIds };
}

/**
 * Metres the rep actually drove on a route, from its breadcrumbs. Written to
 * `Route.actualDistanceM` when the route completes; callable again later if
 * a late batch of pings arrives after the day closed.
 */
export async function recordActualDistance(routeId: string): Promise<number | null> {
  const route = await db.route.findUnique({
    where: { id: routeId },
    select: { id: true, companyId: true, repId: true, routeDate: true },
  });
  if (!route) return null;

  const start = dayStartOf(route.routeDate);
  const end = new Date(start.getTime() + 86_400_000);

  // Pings stamped with the route, plus any from that rep that day which
  // landed before the route existed (planned mid-morning, say).
  const pings = await db.locationPing.findMany({
    where: {
      companyId: route.companyId,
      userId: route.repId,
      OR: [{ routeId: route.id }, { routeId: null, recordedAt: { gte: start, lt: end } }],
    },
    select: { latitude: true, longitude: true, accuracyM: true, recordedAt: true },
  });

  const trail = chronological(dropInaccurate(pings)).map((p) => ({ lat: p.latitude, lng: p.longitude }));
  const actualDistanceM = trail.length >= 2 ? trailDistanceM(trail) : 0;

  await db.route.update({ where: { id: routeId }, data: { actualDistanceM } });
  return actualDistanceM;
}

export interface LivePosition {
  userId: string;
  repName: string;
  latitude: number;
  longitude: number;
  recordedAt: Date;
  stalenessS: number;
  tone: "success" | "warning" | "danger";
  speedMps: number | null;
  speedKmh: number | null;
  heading: number | null;
  accuracyM: number | null;
  batteryPct: number | null;
  isMoving: boolean;
  vehicle: { id: string; plate: string; make: string | null; model: string | null } | null;
  route: {
    id: string;
    name: string;
    status: string;
    done: number;
    total: number;
    skipped: number;
    totalDistanceM: number;
    odometerStartKm: number | null;
  } | null;
}

/**
 * Where every rep is right now: their last fix since local midnight, with the
 * van they are in and how far through the day's route they are.
 *
 * Field reps calling this see themselves only (`selfField`), so the same
 * endpoint serves the handset's "am I being tracked" indicator and the
 * manager's live map.
 */
export async function latestPositions(
  principal: Principal,
  now: Date = new Date(),
): Promise<LivePosition[]> {
  const start = dayStartOf(now);
  const end = new Date(start.getTime() + 86_400_000);
  const where = scope(principal, { selfField: "userId" });

  // Distinct-on is not available on SQLite; the day's pings per company are
  // bounded (a few thousand), so fetch the newest first and keep one per rep.
  const pings = await db.locationPing.findMany({
    where: { ...where, recordedAt: { gte: start, lt: end } },
    orderBy: { recordedAt: "desc" },
    select: {
      userId: true,
      latitude: true,
      longitude: true,
      accuracyM: true,
      speedMps: true,
      heading: true,
      batteryPct: true,
      isMoving: true,
      recordedAt: true,
      user: { select: { name: true } },
    },
  });

  // The newest *usable* fix per rep: a kilometre-wide fix from a phone in a
  // drawer is not where the van is, and the trail already leaves those out.
  const latest = new Map<string, (typeof pings)[number]>();
  for (const p of dropInaccurate(pings)) {
    if (!latest.has(p.userId)) latest.set(p.userId, p);
  }
  if (latest.size === 0) return [];

  const routes = await db.route.findMany({
    where: {
      companyId: principal.companyId!,
      repId: { in: [...latest.keys()] },
      routeDate: { gte: start, lt: end },
      status: { in: ["PLANNED", "ACTIVE", "COMPLETED"] },
    },
    include: {
      vehicle: { select: { id: true, plate: true, make: true, model: true } },
      stops: { select: { status: true } },
    },
    orderBy: { createdAt: "desc" },
  });
  const routeByRep = new Map<string, (typeof routes)[number]>();
  for (const r of routes) {
    const current = routeByRep.get(r.repId);
    if (!current || (current.status !== "ACTIVE" && r.status === "ACTIVE")) routeByRep.set(r.repId, r);
  }

  return [...latest.values()]
    .map((p) => {
      const route = routeByRep.get(p.userId) ?? null;
      const stalenessS = stalenessSeconds(p.recordedAt, now);
      const progress = route ? routeProgress(route.stops) : null;
      return {
        userId: p.userId,
        repName: p.user.name,
        latitude: p.latitude,
        longitude: p.longitude,
        recordedAt: p.recordedAt,
        stalenessS,
        tone: stalenessTone(stalenessS),
        speedMps: p.speedMps,
        speedKmh: speedKmh(p.speedMps),
        heading: p.heading,
        accuracyM: p.accuracyM,
        batteryPct: p.batteryPct,
        isMoving: p.isMoving,
        vehicle: route?.vehicle ?? null,
        route:
          route && progress
            ? {
                id: route.id,
                name: route.name,
                status: route.status,
                done: progress.done,
                total: progress.total,
                skipped: progress.skipped,
                totalDistanceM: route.totalDistanceM,
                odometerStartKm: route.odometerStartKm,
              }
            : null,
      } satisfies LivePosition;
    })
    .sort((a, b) => a.repName.localeCompare(b.repName));
}
