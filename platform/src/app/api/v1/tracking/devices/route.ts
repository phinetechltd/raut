import { z } from "zod";

import { handler, ok, parseBody } from "@/lib/api";
import { auditAs } from "@/lib/audit";
import { db } from "@/lib/db";
import { companyIdOf, scope } from "@/lib/tenant";
import { assertVehicleFree } from "@/server/trackers";

export const dynamic = "force-dynamic";

export const GET = handler({ permission: "tracker:manage" }, async ({ principal, searchParams }) => {
  const q = searchParams.get("q")?.trim();
  const assigned = searchParams.get("assigned");
  return db.trackerDevice.findMany({
    where: {
      ...scope(principal),
      ...(assigned === "true" ? { vehicleId: { not: null } } : assigned === "false" ? { vehicleId: null } : {}),
      ...(q ? { OR: [{ externalId: { contains: q } }, { label: { contains: q } }] } : {}),
    },
    include: { vehicle: { select: { id: true, plate: true } } },
    orderBy: [{ lastSeenAt: "desc" }, { createdAt: "desc" }],
    take: 200,
  });
});

const createSchema = z.object({
  externalId: z.string().trim().min(3).max(64),
  label: z.string().trim().max(60).nullish(),
  vehicleId: z.string().nullish(),
});

/**
 * Registers a tracker ahead of its first report, for an admin who has the IMEI
 * to hand. Devices also register themselves on first contact, unassigned.
 */
export const POST = handler({ permission: "tracker:manage" }, async ({ principal, request }) => {
  const companyId = companyIdOf(principal);
  const input = await parseBody(request, createSchema);
  if (input.vehicleId) await assertVehicleFree(companyId, input.vehicleId, "");

  const device = await db.trackerDevice.create({
    data: {
      companyId,
      externalId: input.externalId,
      label: input.label ?? null,
      vehicleId: input.vehicleId ?? null,
    },
    include: { vehicle: { select: { id: true, plate: true } } },
  });

  await auditAs(
    principal,
    "CREATE",
    "TrackerDevice",
    device.id,
    { externalId: device.externalId, vehicleId: device.vehicleId },
    request,
  );
  return ok(device, undefined, { status: 201 });
});
