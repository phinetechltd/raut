import "server-only";

import { db } from "@/lib/db";
import { optimiseRoute, type LatLng, type RoutePoint } from "@/lib/geo";

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
      },
    });
  });
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
    let sequence = done.length;
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
    },
    orderBy: { createdAt: "desc" },
  });
}
