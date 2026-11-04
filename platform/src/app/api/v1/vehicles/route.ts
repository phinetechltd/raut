import { z } from "zod";

import { badRequest, handler, ok, parseBody } from "@/lib/api";
import { auditAs } from "@/lib/audit";
import { db } from "@/lib/db";
import { companyIdOf, scope } from "@/lib/tenant";
import { normalisePlate, VEHICLE_TYPES } from "@/lib/vehicles";

export const dynamic = "force-dynamic";

/** `?q=` searches plate, make and model; `?active=true|false` filters. */
export const GET = handler(
  { permission: "vehicle:read" },
  async ({ principal, searchParams }) => {
    const q = searchParams.get("q")?.trim();
    const active = searchParams.get("active");

    return db.vehicle.findMany({
      where: {
        ...scope(principal),
        ...(active === "true" ? { active: true } : active === "false" ? { active: false } : {}),
        ...(q
          ? {
              OR: [
                { plate: { contains: q } },
                { make: { contains: q } },
                { model: { contains: q } },
              ],
            }
          : {}),
      },
      orderBy: [{ active: "desc" }, { plate: "asc" }],
      take: 200,
    });
  },
);

const createSchema = z.object({
  plate: z.string().trim().min(3).max(16),
  make: z.string().trim().max(60).nullish(),
  model: z.string().trim().max(60).nullish(),
  type: z.enum(VEHICLE_TYPES).optional(),
  branchId: z.string().nullish(),
  defaultRepId: z.string().nullish(),
  odometerKm: z.number().int().nonnegative().nullish(),
});

export const POST = handler(
  { permission: "vehicle:write" },
  async ({ principal, request }) => {
    const companyId = companyIdOf(principal);
    const input = await parseBody(request, createSchema);

    // References named in the body must be the company's own; a foreign id is
    // indistinguishable from a missing one.
    if (input.branchId) {
      const branch = await db.branch.findFirst({ where: { id: input.branchId, companyId }, select: { id: true } });
      if (!branch) throw badRequest("Branch not found");
    }
    if (input.defaultRepId) {
      const rep = await db.user.findFirst({ where: { id: input.defaultRepId, companyId }, select: { id: true } });
      if (!rep) throw badRequest("Rep not found");
    }

    const vehicle = await db.vehicle.create({
      data: {
        companyId,
        plate: normalisePlate(input.plate),
        make: input.make ?? null,
        model: input.model ?? null,
        type: input.type ?? "VAN",
        branchId: input.branchId ?? null,
        defaultRepId: input.defaultRepId ?? null,
        odometerKm: input.odometerKm ?? null,
      },
    });

    await auditAs(principal, "CREATE", "Vehicle", vehicle.id, { plate: vehicle.plate }, request);
    return ok(vehicle, undefined, { status: 201 });
  },
);
