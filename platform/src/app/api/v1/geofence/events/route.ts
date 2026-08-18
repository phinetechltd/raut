import { handler, ok, pagination, paginationMeta } from "@/lib/api";
import { db } from "@/lib/db";
import { scope } from "@/lib/tenant";

export const dynamic = "force-dynamic";

/**
 * Module 08's reporting surface: the verified/rejected/out-of-zone trail.
 *
 * This is the evidence a sales manager uses when a rep disputes their visit
 * numbers, so events are read-only here — they are written by check-in, never
 * by a client that could fabricate them.
 */
export const GET = handler(
  { permission: "geofence:read" },
  async ({ principal, searchParams }) => {
    const page = pagination(searchParams);
    const where = {
      ...scope(principal, { selfField: "userId" }),
      ...(searchParams.get("type") ? { type: searchParams.get("type")! } : {}),
      ...(searchParams.get("userId") && principal.role !== "FIELD_REP"
        ? { userId: searchParams.get("userId")! }
        : {}),
    };

    const [items, total] = await Promise.all([
      db.geofenceEvent.findMany({
        where,
        include: {
          user: { select: { id: true, name: true } },
          territory: { select: { id: true, name: true, colour: true } },
        },
        orderBy: { occurredAt: "desc" },
        take: page.take,
        skip: page.skip,
      }),
      db.geofenceEvent.count({ where }),
    ]);

    const byType = await db.geofenceEvent.groupBy({
      by: ["type"],
      where: scope(principal, { selfField: "userId" }),
      _count: true,
    });

    return ok(items, {
      ...paginationMeta(page, total),
      summary: byType.map((t) => ({ type: t.type, count: t._count })),
    });
  },
);
