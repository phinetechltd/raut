import "server-only";

import { db } from "@/lib/db";
import { isInsideTerritory, verifyVisitLocation, type LatLng } from "@/lib/geo";

/**
 * Module 06 · Field Sales, with Module 08 · Geofencing folded into check-in.
 *
 * Check-in is the hinge of the whole field product: it is the moment a claimed
 * visit becomes an evidenced one. The verification result is stored on the
 * visit rather than recomputed later, because the customer's pin may be
 * corrected afterwards and that must not retroactively rewrite history.
 */

export interface CheckInInput {
  visitId: string;
  companyId: string;
  userId: string;
  latitude: number;
  longitude: number;
  accuracyM?: number | null;
  at?: Date;
  /** Whether the company licenses GEOFENCING; unlicensed = record, don't judge. */
  geofencingEnabled: boolean;
}

export interface CheckInResult {
  visit: Awaited<ReturnType<typeof db.visit.update>>;
  verified: boolean;
  distanceM: number | null;
  reason: string;
}

export async function checkIn(input: CheckInInput): Promise<CheckInResult> {
  const visit = await db.visit.findFirst({
    where: { id: input.visitId, companyId: input.companyId },
    include: { customer: { include: { territory: true } } },
  });
  if (!visit) throw new Error("Visit not found");
  if (visit.checkInAt) throw new Error("Visit is already checked in");

  const point: LatLng = { lat: input.latitude, lng: input.longitude };
  const at = input.at ?? new Date();

  const verification = verifyVisitLocation(
    point,
    {
      latitude: visit.customer.latitude,
      longitude: visit.customer.longitude,
      geofenceRadiusM: visit.customer.geofenceRadiusM,
    },
    input.accuracyM,
  );

  // Without the Geofencing module the position is still captured (Phase One
  // promises "basic user/visit location") but it is not used to reject a visit.
  const verified = input.geofencingEnabled ? verification.verified : false;

  const updated = await db.visit.update({
    where: { id: visit.id },
    data: {
      status: "IN_PROGRESS",
      checkInAt: at,
      checkInLat: input.latitude,
      checkInLng: input.longitude,
      checkInAccuracyM: input.accuracyM ?? null,
      geofenceVerified: verified,
      distanceFromCustomerM: verification.distanceM,
    },
  });

  if (input.geofencingEnabled) {
    await db.geofenceEvent.create({
      data: {
        companyId: input.companyId,
        userId: input.userId,
        territoryId: visit.customer.territoryId,
        type: verified ? "VISIT_VERIFIED" : "VISIT_REJECTED",
        latitude: input.latitude,
        longitude: input.longitude,
        detail: verification.reason,
        refType: "VISIT",
        refId: visit.id,
        occurredAt: at,
      },
    });

    // Separate signal from the visit check: the rep may be at the right shop
    // but the shop may have been re-assigned to another territory.
    if (visit.customer.territory && !isInsideTerritory(point, visit.customer.territory)) {
      await db.geofenceEvent.create({
        data: {
          companyId: input.companyId,
          userId: input.userId,
          territoryId: visit.customer.territoryId,
          type: "OUT_OF_ZONE",
          latitude: input.latitude,
          longitude: input.longitude,
          detail: `Check-in outside ${visit.customer.territory.name}`,
          refType: "VISIT",
          refId: visit.id,
          occurredAt: at,
        },
      });
    }
  }

  await db.customerActivity.create({
    data: {
      companyId: input.companyId,
      customerId: visit.customerId,
      userId: input.userId,
      type: "VISIT",
      subject: "Checked in",
      body: verification.reason,
    },
  });

  if (visit.routeId) {
    await db.routeStop.updateMany({
      where: { routeId: visit.routeId, customerId: visit.customerId },
      data: { status: "ARRIVED" },
    });
    await db.route.updateMany({
      where: { id: visit.routeId, status: "PLANNED" },
      data: { status: "ACTIVE", startedAt: at },
    });
  }

  return {
    visit: updated,
    verified,
    distanceM: verification.distanceM,
    reason: verification.reason,
  };
}

export interface CheckOutInput {
  visitId: string;
  companyId: string;
  userId: string;
  latitude?: number | null;
  longitude?: number | null;
  outcome?: string | null;
  notes?: string | null;
  at?: Date;
}

export async function checkOut(input: CheckOutInput) {
  const visit = await db.visit.findFirst({
    where: { id: input.visitId, companyId: input.companyId },
  });
  if (!visit) throw new Error("Visit not found");
  if (!visit.checkInAt) throw new Error("Visit has not been checked in");
  if (visit.checkOutAt) throw new Error("Visit is already checked out");

  const at = input.at ?? new Date();
  const durationMin = Math.max(
    0,
    Math.round((at.getTime() - visit.checkInAt.getTime()) / 60_000),
  );

  const updated = await db.visit.update({
    where: { id: visit.id },
    data: {
      status: "COMPLETED",
      checkOutAt: at,
      checkOutLat: input.latitude ?? null,
      checkOutLng: input.longitude ?? null,
      durationMin,
      outcome: input.outcome ?? visit.outcome,
      notes: input.notes ?? visit.notes,
    },
  });

  if (visit.routeId) {
    await db.routeStop.updateMany({
      where: { routeId: visit.routeId, customerId: visit.customerId },
      data: { status: "DONE" },
    });

    // Close the route once no stop is still outstanding.
    const pending = await db.routeStop.count({
      where: { routeId: visit.routeId, status: { in: ["PENDING", "ARRIVED"] } },
    });
    if (pending === 0) {
      await db.route.update({
        where: { id: visit.routeId },
        data: { status: "COMPLETED", completedAt: at },
      });
    }
  }

  return updated;
}

/** Marks scheduled visits that were never attended. Run at end of day. */
export async function markMissedVisits(companyId: string, before: Date): Promise<number> {
  const result = await db.visit.updateMany({
    where: { companyId, status: "SCHEDULED", scheduledAt: { lt: before } },
    data: { status: "MISSED" },
  });
  return result.count;
}

export interface RepPerformance {
  repId: string;
  repName: string;
  visitsPlanned: number;
  visitsCompleted: number;
  visitsVerified: number;
  ordersCount: number;
  salesCents: number;
  collectionsCents: number;
  /** Completed ÷ planned, 0–1 */
  completionRate: number;
  /** Verified ÷ completed, 0–1 — the number that makes GPS worth paying for */
  verificationRate: number;
}

/**
 * Rep scorecard for the field dashboard and Module 10's staff reporting.
 */
export async function repPerformance(
  companyId: string,
  from: Date,
  to: Date,
): Promise<RepPerformance[]> {
  const reps = await db.user.findMany({
    where: { companyId, role: "FIELD_REP", status: "ACTIVE" },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });

  const results: RepPerformance[] = [];

  for (const rep of reps) {
    const visits = await db.visit.findMany({
      where: { companyId, repId: rep.id, scheduledAt: { gte: from, lte: to } },
      select: { status: true, geofenceVerified: true, customerId: true },
    });

    const completed = visits.filter((v) => v.status === "COMPLETED");
    const verified = completed.filter((v) => v.geofenceVerified);

    const orders = await db.salesOrder.aggregate({
      where: {
        companyId,
        createdById: rep.id,
        orderDate: { gte: from, lte: to },
        status: { not: "CANCELLED" },
      },
      _sum: { totalCents: true },
      _count: true,
    });

    const payments = await db.payment.aggregate({
      where: { companyId, createdById: rep.id, paidAt: { gte: from, lte: to } },
      _sum: { amountCents: true },
    });

    results.push({
      repId: rep.id,
      repName: rep.name,
      visitsPlanned: visits.length,
      visitsCompleted: completed.length,
      visitsVerified: verified.length,
      ordersCount: orders._count,
      salesCents: orders._sum.totalCents ?? 0,
      collectionsCents: payments._sum.amountCents ?? 0,
      completionRate: visits.length ? completed.length / visits.length : 0,
      verificationRate: completed.length ? verified.length / completed.length : 0,
    });
  }

  return results;
}
