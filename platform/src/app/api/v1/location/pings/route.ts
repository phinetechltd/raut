import { z } from "zod";

import { badRequest, handler, parseBody, parseDate } from "@/lib/api";
import { db } from "@/lib/db";
import { companyIdOf, scope } from "@/lib/tenant";
import { chronological, downsample, dropInaccurate, MAX_TRAIL_ACCURACY_M } from "@/lib/tracking";
import { storePings } from "@/server/tracking";

export const dynamic = "force-dynamic";

/** Most points a trail response carries; the console cannot draw more usefully. */
const TRAIL_MAX_POINTS = 2000;

const schema = z.object({
  pings: z
    .array(
      z.object({
        latitude: z.number().min(-90).max(90),
        longitude: z.number().min(-180).max(180),
        // `nullish`, not `optional`: a handset serialises an unknown speed or
        // heading as an explicit null, which `optional()` rejects — and the
        // whole batch with it.
        accuracyM: z.number().nonnegative().nullish(),
        speedMps: z.number().nullish(),
        heading: z.number().nullish(),
        batteryPct: z.number().min(0).max(100).nullish(),
        isMoving: z.boolean().nullish(),
        recordedAt: z.string(),
      }),
    )
    .min(1)
    .max(500),
});

/**
 * Background location breadcrumbs.
 *
 * Written in bulk because the handset buffers while offline. Each row is
 * stamped with the rep's route and vehicle for that day, and a retried batch
 * cannot double the trail: rows are unique per rep per instant and the insert
 * skips the ones already there.
 */
export const POST = handler(
  { permission: "field:self" },
  async ({ principal, request }) => {
    const companyId = companyIdOf(principal);
    const input = await parseBody(request, schema);

    const pings = input.pings.map((p) => {
      const recordedAt = new Date(p.recordedAt);
      if (Number.isNaN(recordedAt.getTime())) throw badRequest(`Invalid recordedAt: ${p.recordedAt}`);
      return { ...p, recordedAt };
    });

    const result = await storePings(companyId, principal.userId, pings);
    return { recorded: result.recorded, routeIds: result.routeIds };
  },
);

/**
 * Breadcrumb trail for the console's tracking map.
 *
 * `?userId=` / `?vehicleId=` / `?routeId=` narrow it; `?date=` picks the day
 * (today by default). Fixes worse than 100 m are dropped and the trail is
 * thinned evenly to at most 2000 points, first and last kept.
 */
export const GET = handler(
  { permission: "geofence:read" },
  async ({ principal, searchParams }) => {
    const userId = searchParams.get("userId");
    const vehicleId = searchParams.get("vehicleId");
    const routeId = searchParams.get("routeId");

    const start = parseDate(searchParams.get("date")) ?? new Date();
    start.setHours(0, 0, 0, 0);

    const rows = await db.locationPing.findMany({
      where: {
        ...scope(principal, { selfField: "userId" }),
        ...(userId && principal.role !== "FIELD_REP" ? { userId } : {}),
        ...(vehicleId ? { vehicleId } : {}),
        ...(routeId ? { routeId } : {}),
        recordedAt: { gte: start, lt: new Date(start.getTime() + 86_400_000) },
      },
      select: {
        id: true,
        userId: true,
        vehicleId: true,
        routeId: true,
        latitude: true,
        longitude: true,
        accuracyM: true,
        speedMps: true,
        heading: true,
        recordedAt: true,
        isMoving: true,
        batteryPct: true,
      },
      orderBy: { recordedAt: "asc" },
      // Generous ceiling before thinning: the thinning keeps the shape of the
      // day, a hard cut would keep only the morning.
      take: 20_000,
    });

    const usable = dropInaccurate(chronological(rows), MAX_TRAIL_ACCURACY_M);
    return downsample(usable, TRAIL_MAX_POINTS);
  },
);
