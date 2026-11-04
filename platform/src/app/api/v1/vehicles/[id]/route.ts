import { z } from "zod";

import { badRequest, handler, notFound, parseBody } from "@/lib/api";
import { auditAs, diff } from "@/lib/audit";
import { db } from "@/lib/db";
import { scope } from "@/lib/tenant";
import { normalisePlate, VEHICLE_TYPES } from "@/lib/vehicles";

export const dynamic = "force-dynamic";

export const GET = handler<{ id: string }>(
  { permission: "vehicle:read" },
  async ({ principal, params }) => {
    const vehicle = await db.vehicle.findFirst({
      where: { id: params.id, ...scope(principal) },
      include: {
        routes: {
          select: {
            id: true,
            name: true,
            routeDate: true,
            status: true,
            totalDistanceM: true,
            actualDistanceM: true,
            odometerStartKm: true,
            odometerEndKm: true,
            rep: { select: { id: true, name: true } },
          },
          orderBy: { routeDate: "desc" },
          take: 30,
        },
      },
    });
    if (!vehicle) throw notFound("Vehicle not found");
    return vehicle;
  },
);

const updateSchema = z.object({
  plate: z.string().trim().min(3).max(16).optional(),
  make: z.string().trim().max(60).nullable().optional(),
  model: z.string().trim().max(60).nullable().optional(),
  type: z.enum(VEHICLE_TYPES).optional(),
  branchId: z.string().nullable().optional(),
  defaultRepId: z.string().nullable().optional(),
  odometerKm: z.number().int().nonnegative().nullable().optional(),
  /** Retire a van without losing the routes it drove. */
  active: z.boolean().optional(),
});

export const PATCH = handler<{ id: string }>(
  { permission: "vehicle:write" },
  async ({ principal, params, request }) => {
    const existing = await db.vehicle.findFirst({ where: { id: params.id, ...scope(principal) } });
    if (!existing) throw notFound("Vehicle not found");

    const input = await parseBody(request, updateSchema);

    if (input.branchId) {
      const branch = await db.branch.findFirst({
        where: { id: input.branchId, companyId: existing.companyId },
        select: { id: true },
      });
      if (!branch) throw badRequest("Branch not found");
    }
    if (input.defaultRepId) {
      const rep = await db.user.findFirst({
        where: { id: input.defaultRepId, companyId: existing.companyId },
        select: { id: true },
      });
      if (!rep) throw badRequest("Rep not found");
    }

    const data: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
      if (value === undefined) continue;
      data[key] = value === "" ? null : value;
    }
    if (typeof data.plate === "string") data.plate = normalisePlate(data.plate);

    const vehicle = await db.vehicle.update({ where: { id: params.id }, data });

    await auditAs(
      principal,
      "UPDATE",
      "Vehicle",
      vehicle.id,
      diff(existing as unknown as Record<string, unknown>, data),
      request,
    );
    return vehicle;
  },
);
