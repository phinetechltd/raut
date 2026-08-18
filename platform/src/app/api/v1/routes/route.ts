import { z } from "zod";

import { handler, ok, parseBody } from "@/lib/api";
import { auditAs } from "@/lib/audit";
import { db } from "@/lib/db";
import { companyIdOf, scope } from "@/lib/tenant";
import { buildRoute, todaysRoute } from "@/server/routing";

export const dynamic = "force-dynamic";

export const GET = handler(
  { permission: "route:read" },
  async ({ principal, searchParams }) => {
    // The mobile home screen asks for exactly one thing: today's itinerary.
    if (searchParams.get("today") === "true") {
      const route = await todaysRoute(
        companyIdOf(principal),
        searchParams.get("repId") && principal.role !== "FIELD_REP"
          ? searchParams.get("repId")!
          : principal.userId,
        new Date(),
      );
      return route;
    }

    const date = searchParams.get("date");
    let dateFilter = {};
    if (date) {
      const start = new Date(date);
      start.setHours(0, 0, 0, 0);
      dateFilter = { routeDate: { gte: start, lt: new Date(start.getTime() + 86_400_000) } };
    }

    return db.route.findMany({
      where: {
        ...scope(principal, { selfField: "repId" }),
        ...dateFilter,
        ...(searchParams.get("status") ? { status: searchParams.get("status")! } : {}),
      },
      include: {
        rep: { select: { id: true, name: true } },
        territory: { select: { id: true, name: true, colour: true } },
        stops: {
          include: { customer: { select: { id: true, name: true, latitude: true, longitude: true } } },
          orderBy: { sequence: "asc" },
        },
      },
      orderBy: { routeDate: "desc" },
      take: 60,
    });
  },
);

const schema = z.object({
  repId: z.string().optional(),
  routeDate: z.string(),
  name: z.string().optional(),
  territoryId: z.string().optional(),
  customerIds: z.array(z.string()).optional(),
  startLat: z.number().optional(),
  startLng: z.number().optional(),
  createVisits: z.boolean().optional(),
  serviceMinutes: z.number().int().min(5).max(180).optional(),
  startHour: z.number().int().min(0).max(23).optional(),
});

/**
 * Plans and sequences a route. The optimiser runs here, at build time — the
 * stored sequence is what the rep sees, and it does not change under them
 * mid-day unless someone explicitly re-sequences.
 */
export const POST = handler(
  { permission: "route:write" },
  async ({ principal, request }) => {
    const companyId = companyIdOf(principal);
    const input = await parseBody(request, schema);

    const repId =
      principal.role === "FIELD_REP" ? principal.userId : (input.repId ?? principal.userId);

    const route = await buildRoute({
      companyId,
      repId,
      routeDate: new Date(input.routeDate),
      name: input.name,
      territoryId: input.territoryId ?? null,
      customerIds: input.customerIds,
      start:
        input.startLat != null && input.startLng != null
          ? { lat: input.startLat, lng: input.startLng }
          : null,
      createVisits: input.createVisits,
      serviceMinutes: input.serviceMinutes,
      startHour: input.startHour,
    });

    await auditAs(
      principal,
      "CREATE",
      "Route",
      route.id,
      { stops: route.stops.length, distanceM: route.totalDistanceM },
      request,
    );

    return ok(route, undefined, { status: 201 });
  },
);
