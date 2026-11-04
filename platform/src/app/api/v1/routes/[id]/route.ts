import { z } from "zod";

import { badRequest, forbidden, handler, notFound, parseBody } from "@/lib/api";
import { auditAs, diff } from "@/lib/audit";
import { db } from "@/lib/db";
import { can } from "@/lib/rbac";
import { scope } from "@/lib/tenant";
import { recordOdometer, resolveVehicle } from "@/server/routing";

export const dynamic = "force-dynamic";

const ROUTE_INCLUDE = {
  rep: { select: { id: true, name: true } },
  territory: { select: { id: true, name: true, colour: true } },
  vehicle: { select: { id: true, plate: true, make: true, model: true, type: true } },
  stops: {
    include: { customer: { select: { id: true, name: true, latitude: true, longitude: true } } },
    orderBy: { sequence: "asc" as const },
  },
};

export const GET = handler<{ id: string }>(
  { permission: "route:read" },
  async ({ principal, params }) => {
    const route = await db.route.findFirst({
      where: { id: params.id, ...scope(principal, { selfField: "repId" }) },
      include: ROUTE_INCLUDE,
    });
    if (!route) throw notFound("Route not found");
    return route;
  },
);

const updateSchema = z.object({
  vehicleId: z.string().nullable().optional(),
  odometerStartKm: z.number().int().nonnegative().nullable().optional(),
  odometerEndKm: z.number().int().nonnegative().nullable().optional(),
});

/**
 * Edits the parts of a route that describe the vehicle, not the plan: which
 * van it went out in and the odometer readings. Managers edit any route in
 * the company; a rep only their own, and only the odometer — swapping the
 * van on a route is a dispatcher's call.
 */
export const PATCH = handler<{ id: string }>(
  { permission: "route:read" },
  async ({ principal, params, request }) => {
    const existing = await db.route.findFirst({
      where: { id: params.id, ...scope(principal, { selfField: "repId" }) },
    });
    if (!existing) throw notFound("Route not found");

    const input = await parseBody(request, updateSchema);

    // The handler gate is route:read so a rep can reach their own odometer
    // fields; everything else on a route needs route:write.
    const isRep = principal.role === "FIELD_REP";
    if (isRep && input.vehicleId !== undefined) {
      throw forbidden("Only a manager can change the vehicle on a route");
    }
    if (!isRep && !can(principal, "route:write")) {
      throw forbidden("Your role does not permit editing routes");
    }

    const data: Record<string, unknown> = {};

    // The server helpers throw plain errors with a user-facing message; here
    // they are the caller's mistake (unknown van, readings out of order), so
    // they come back as 400s rather than 500s.
    const asBadRequest = (error: unknown) =>
      badRequest(error instanceof Error ? error.message : "Could not update the route");

    if (input.vehicleId !== undefined) {
      data.vehicleId = input.vehicleId
        ? await resolveVehicle(existing.companyId, existing.repId, input.vehicleId).catch((e) => {
            throw asBadRequest(e);
          })
        : null;
      await db.route.update({ where: { id: existing.id }, data: { vehicleId: data.vehicleId as string | null } });
    }

    if (input.odometerStartKm !== undefined || input.odometerEndKm !== undefined) {
      await recordOdometer({
        routeId: existing.id,
        companyId: existing.companyId,
        ...(input.odometerStartKm !== undefined ? { odometerStartKm: input.odometerStartKm } : {}),
        ...(input.odometerEndKm !== undefined ? { odometerEndKm: input.odometerEndKm } : {}),
      }).catch((e) => {
        throw asBadRequest(e);
      });
      if (input.odometerStartKm !== undefined) data.odometerStartKm = input.odometerStartKm;
      if (input.odometerEndKm !== undefined) data.odometerEndKm = input.odometerEndKm;
    }

    const route = await db.route.findUniqueOrThrow({ where: { id: existing.id }, include: ROUTE_INCLUDE });

    await auditAs(
      principal,
      "UPDATE",
      "Route",
      route.id,
      diff(existing as unknown as Record<string, unknown>, data),
      request,
    );
    return route;
  },
);
