import "server-only";

import { db } from "@/lib/db";
import { optimiseRoute, type LatLng, type RoutePoint } from "@/lib/geo";

import { recordActualDistance } from "./tracking";

/**
 * Module 07 · Smart Routing.
 *
 * Builds a rep's day: pick the customers, sequence them by distance, and emit
 * the itinerary the mobile app shows. Sequencing runs at build time and is
 * stored, so a rep who loses signal still holds a stable, ordered route rather
 * than one that reshuffles under them.
 */

export interface BuildRouteInput {
  companyId: string;
  repId: string;
  routeDate: Date;
  name?: string;
  territoryId?: string | null;
  /** The van the rep drives this route in. Defaults to the rep's usual vehicle. */
  vehicleId?: string | null;
  customerIds?: string[];
  /** Journey origin — usually the branch or the rep's depot. */
  start?: LatLng | null;
  /** Also create SCHEDULED visits for each stop. */
  createVisits?: boolean;
  /** Minutes between planned arrivals when spacing the itinerary. */
  serviceMinutes?: number;
  /** Local hour the day starts, 24h. */
  startHour?: number;
}

export async function buildRoute(input: BuildRouteInput) {
  const customers = await db.customer.findMany({
    where: {
      companyId: input.companyId,
      status: "ACTIVE",
      latitude: { not: null },
      longitude: { not: null },
      ...(input.customerIds?.length ? { id: { in: input.customerIds } } : {}),
      ...(input.territoryId ? { territoryId: input.territoryId } : {}),
      ...(input.customerIds?.length ? {} : { assignedRepId: input.repId }),
    },
    select: { id: true, name: true, latitude: true, longitude: true },
  });

  if (customers.length === 0) {
    throw new Error(
      "No customers with GPS pins matched this route. Capture customer locations first.",
    );
  }

  const points: RoutePoint[] = customers.map((c) => ({
    id: c.id,
    lat: c.latitude!,
    lng: c.longitude!,
  }));

  let start = input.start ?? null;
  if (!start) {
    const rep = await db.user.findUnique({
      where: { id: input.repId },
      select: { branch: { select: { latitude: true, longitude: true } } },
    });
    if (rep?.branch?.latitude != null && rep.branch.longitude != null) {
      start = { lat: rep.branch.latitude, lng: rep.branch.longitude };
    }
  }

  const optimised = optimiseRoute(start, points);
  const legByCustomer = new Map(optimised.legs.map((l) => [l.id, l]));

  const vehicleId = await resolveVehicle(input.companyId, input.repId, input.vehicleId);

  const serviceMinutes = input.serviceMinutes ?? 30;
  const startHour = input.startHour ?? 8;

  const dayStart = new Date(input.routeDate);
  dayStart.setHours(startHour, 30, 0, 0);

  const label =
    input.name ??
    `Route ${input.routeDate.toLocaleDateString("en-KE", {
      day: "2-digit",
      month: "short",
    })}`;

  return db.$transaction(async (tx) => {
    const route = await tx.route.create({
      data: {
        companyId: input.companyId,
        repId: input.repId,
        territoryId: input.territoryId ?? null,
        vehicleId,
        name: label,
        routeDate: input.routeDate,
        status: "PLANNED",
        totalDistanceM: optimised.totalDistanceM,
        estimatedMin: optimised.totalMin,
        startLat: start?.lat ?? null,
        startLng: start?.lng ?? null,
      },
    });

    let cursor = dayStart.getTime();

    for (let i = 0; i < optimised.order.length; i++) {
      const customerId = optimised.order[i];
      const leg = legByCustomer.get(customerId);
      cursor += (leg?.legMin ?? 0) * 60_000;
      const plannedAt = new Date(cursor);
      cursor += serviceMinutes * 60_000;

      await tx.routeStop.create({
        data: {
          routeId: route.id,
          customerId,
          sequence: i + 1,
          plannedAt,
          legDistanceM: leg?.legDistanceM ?? 0,
          legMin: leg?.legMin ?? 0,
        },
      });

      if (input.createVisits !== false) {
        await tx.visit.create({
          data: {
            companyId: input.companyId,
            customerId,
            repId: input.repId,
            routeId: route.id,
            status: "SCHEDULED",
            purpose: "SALES",
            scheduledAt: plannedAt,
          },
        });
      }
    }

    return tx.route.findUniqueOrThrow({
      where: { id: route.id },
      include: {
        stops: { include: { customer: true }, orderBy: { sequence: "asc" } },
        rep: { select: { id: true, name: true } },
        territory: true,
        vehicle: { select: { id: true, plate: true, make: true, model: true, type: true } },
      },
    });
  });
}

/**
 * The vehicle a route goes out in. An explicit id must be an active vehicle
 * of the same company — a handset or a crafted request naming another
 * tenant's van is refused rather than linked. With no id, the rep's default
 * vehicle is used when they have one.
 */
export async function resolveVehicle(
  companyId: string,
  repId: string,
  vehicleId: string | null | undefined,
): Promise<string | null> {
  if (vehicleId) {
    const vehicle = await db.vehicle.findFirst({
      where: { id: vehicleId, companyId, active: true },
      select: { id: true },
    });
    if (!vehicle) throw new Error("Vehicle not found or not active");
    return vehicle.id;
  }
  const usual = await db.vehicle.findFirst({
    where: { companyId, defaultRepId: repId, active: true },
    select: { id: true },
    orderBy: { updatedAt: "desc" },
  });
  return usual?.id ?? null;
}

/**
 * Marks a stop SKIPPED with the reason, and the visit it drove MISSED. The
 * stop keeps its sequence number — the plan is history — and the caller
 * re-sequences what remains from where the rep actually is.
 */
export async function skipStop(input: {
  routeId: string;
  stopId: string;
  companyId: string;
  reason: string;
  at?: Date;
}) {
  const stop = await db.routeStop.findFirst({
    where: { id: input.stopId, routeId: input.routeId, route: { companyId: input.companyId } },
    include: { route: { select: { status: true } } },
  });
  if (!stop) throw new Error("Stop not found");
  if (stop.status === "DONE") throw new Error("A completed stop cannot be skipped");
  if (stop.status === "SKIPPED") return stop;
  if (stop.route.status === "COMPLETED" || stop.route.status === "CANCELLED") {
    throw new Error("The route is already closed");
  }

  const at = input.at ?? new Date();

  const updated = await db.$transaction(async (tx) => {
    const skipped = await tx.routeStop.update({
      where: { id: stop.id },
      data: { status: "SKIPPED", skipReason: input.reason },
    });

    // The visit this stop scheduled is MISSED, not CANCELLED: the customer
    // was due a call and did not get one, which is what the scorecard counts.
    await tx.visit.updateMany({
      where: {
        routeId: input.routeId,
        customerId: stop.customerId,
        status: { in: ["SCHEDULED", "IN_PROGRESS"] },
      },
      data: { status: "MISSED", notes: `Skipped: ${input.reason}` },
    });

    await tx.route.updateMany({
      where: { id: input.routeId, status: "PLANNED" },
      data: { status: "ACTIVE", startedAt: at },
    });

    // Skipping the last outstanding stop closes the day like a check-out does.
    const pending = await tx.routeStop.count({
      where: { routeId: input.routeId, status: { in: ["PENDING", "ARRIVED"] } },
    });
    if (pending === 0) {
      await tx.route.update({
        where: { id: input.routeId },
        data: { status: "COMPLETED", completedAt: at },
      });
    }

    return { skipped, closed: pending === 0 };
  });

  if (updated.closed) await recordActualDistance(input.routeId).catch(() => undefined);
  return updated.skipped;
}

/**
 * Odometer readings off the dash, start and/or end of day. Reported by the
 * handset (offline-safe through sync) or typed in on the console. The end
 * reading also moves the vehicle's running odometer forward.
 */
export async function recordOdometer(input: {
  routeId: string;
  companyId: string;
  odometerStartKm?: number | null;
  odometerEndKm?: number | null;
}) {
  const route = await db.route.findFirst({
    where: { id: input.routeId, companyId: input.companyId },
    select: { id: true, vehicleId: true, odometerStartKm: true, odometerEndKm: true },
  });
  if (!route) throw new Error("Route not found");

  const start = input.odometerStartKm === undefined ? route.odometerStartKm : input.odometerStartKm;
  const end = input.odometerEndKm === undefined ? route.odometerEndKm : input.odometerEndKm;
  if (start != null && end != null && end < start) {
    throw new Error("The finishing odometer reading cannot be below the starting one");
  }

  const updated = await db.route.update({
    where: { id: route.id },
    data: {
      ...(input.odometerStartKm !== undefined ? { odometerStartKm: input.odometerStartKm } : {}),
      ...(input.odometerEndKm !== undefined ? { odometerEndKm: input.odometerEndKm } : {}),
    },
  });

  const latest = end ?? start;
  if (route.vehicleId && latest != null) {
    await db.vehicle.updateMany({
      where: { id: route.vehicleId, OR: [{ odometerKm: null }, { odometerKm: { lt: latest } }] },
      data: { odometerKm: latest },
    });
  }

  return updated;
}

/**
 * Re-sequences an existing route's remaining stops — used when a rep skips a
 * stop or a customer is added mid-day. Completed stops keep their sequence so
 * the audit trail of what actually happened stays intact.
 */
export async function resequenceRoute(routeId: string, from?: LatLng | null) {
  const route = await db.route.findUnique({
    where: { id: routeId },
    include: { stops: { include: { customer: true }, orderBy: { sequence: "asc" } } },
  });
  if (!route) throw new Error("Route not found");

  const done = route.stops.filter((s) => s.status === "DONE" || s.status === "SKIPPED");
  const pending = route.stops.filter((s) => s.status === "PENDING" || s.status === "ARRIVED");

  const points: RoutePoint[] = pending
    .filter((s) => s.customer.latitude != null && s.customer.longitude != null)
    .map((s) => ({ id: s.customerId, lat: s.customer.latitude!, lng: s.customer.longitude! }));

  if (points.length === 0) return route;

  const origin =
    from ??
    (route.startLat != null && route.startLng != null
      ? { lat: route.startLat, lng: route.startLng }
      : null);

  const optimised = optimiseRoute(origin, points);
  const legByCustomer = new Map(optimised.legs.map((l) => [l.id, l]));

  await db.$transaction(async (tx) => {
    // Done and skipped stops keep their relative order but close up to 1..k,
    // so a skipped stop #2 and the re-sequenced pending stops cannot share a
    // number — the handset sorts by sequence and would show them interleaved.
    let sequence = 0;
    for (const stop of done) {
      sequence++;
      if (stop.sequence !== sequence) {
        await tx.routeStop.update({ where: { id: stop.id }, data: { sequence } });
      }
    }
    for (const customerId of optimised.order) {
      sequence++;
      const leg = legByCustomer.get(customerId);
      await tx.routeStop.updateMany({
        where: { routeId, customerId },
        data: {
          sequence,
          legDistanceM: leg?.legDistanceM ?? 0,
          legMin: leg?.legMin ?? 0,
        },
      });
    }

    const doneDistance = done.reduce((sum, s) => sum + s.legDistanceM, 0);
    await tx.route.update({
      where: { id: routeId },
      data: {
        totalDistanceM: doneDistance + optimised.totalDistanceM,
        estimatedMin:
          done.reduce((sum, s) => sum + s.legMin, 0) + optimised.totalMin,
      },
    });
  });

  return db.route.findUniqueOrThrow({
    where: { id: routeId },
    include: {
      stops: { include: { customer: true }, orderBy: { sequence: "asc" } },
      rep: { select: { id: true, name: true } },
      vehicle: { select: { id: true, plate: true, make: true, model: true, type: true } },
    },
  });
}

/** The rep's itinerary for a given day, as the mobile home screen renders it. */
export async function todaysRoute(companyId: string, repId: string, date: Date) {
  const dayStart = new Date(date);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart);
  dayEnd.setDate(dayEnd.getDate() + 1);

  return db.route.findFirst({
    where: {
      companyId,
      repId,
      routeDate: { gte: dayStart, lt: dayEnd },
      status: { in: ["PLANNED", "ACTIVE"] },
    },
    include: {
      stops: { include: { customer: true }, orderBy: { sequence: "asc" } },
      visits: { orderBy: { scheduledAt: "asc" } },
      territory: true,
      vehicle: { select: { id: true, plate: true, make: true, model: true, type: true } },
    },
    orderBy: { createdAt: "desc" },
  });
}
