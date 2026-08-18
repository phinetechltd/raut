import { z } from "zod";

import { handler, parseBody } from "@/lib/api";
import { db } from "@/lib/db";
import { companyIdOf, scope } from "@/lib/tenant";

export const dynamic = "force-dynamic";

const schema = z.object({
  pings: z
    .array(
      z.object({
        latitude: z.number().min(-90).max(90),
        longitude: z.number().min(-180).max(180),
        accuracyM: z.number().nonnegative().optional(),
        speedMps: z.number().optional(),
        heading: z.number().optional(),
        batteryPct: z.number().min(0).max(100).optional(),
        isMoving: z.boolean().optional(),
        recordedAt: z.string(),
      }),
    )
    .min(1)
    .max(500),
});

/**
 * Background location breadcrumbs.
 *
 * Written in bulk because the handset buffers while offline. `createMany` with
 * no per-row read keeps a day's backlog cheap; these rows are analytical, not
 * transactional, so a duplicate from a retried batch is tolerable noise rather
 * than a correctness problem.
 */
export const POST = handler(
  { permission: "field:self" },
  async ({ principal, request }) => {
    const companyId = companyIdOf(principal);
    const input = await parseBody(request, schema);

    const result = await db.locationPing.createMany({
      data: input.pings.map((p) => ({
        companyId,
        userId: principal.userId,
        latitude: p.latitude,
        longitude: p.longitude,
        accuracyM: p.accuracyM != null ? Math.round(p.accuracyM) : null,
        speedMps: p.speedMps ?? null,
        heading: p.heading ?? null,
        batteryPct: p.batteryPct != null ? Math.round(p.batteryPct) : null,
        isMoving: p.isMoving ?? true,
        recordedAt: new Date(p.recordedAt),
      })),
    });

    return { recorded: result.count };
  },
);

/** Breadcrumb trail for the console's live-tracking map. */
export const GET = handler(
  { permission: "geofence:read" },
  async ({ principal, searchParams }) => {
    const userId = searchParams.get("userId");
    const date = searchParams.get("date");

    const start = date ? new Date(date) : new Date();
    start.setHours(0, 0, 0, 0);

    return db.locationPing.findMany({
      where: {
        ...scope(principal, { selfField: "userId" }),
        ...(userId && principal.role !== "FIELD_REP" ? { userId } : {}),
        recordedAt: { gte: start, lt: new Date(start.getTime() + 86_400_000) },
      },
      select: {
        id: true, userId: true, latitude: true, longitude: true,
        recordedAt: true, isMoving: true, batteryPct: true,
      },
      orderBy: { recordedAt: "asc" },
      take: 2000,
    });
  },
);
