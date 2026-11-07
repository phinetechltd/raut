import { z } from "zod";

import { handler, notFound, parseBody } from "@/lib/api";
import { auditAs } from "@/lib/audit";
import { db } from "@/lib/db";
import { scope } from "@/lib/tenant";
import { assertVehicleFree } from "@/server/trackers";

export const dynamic = "force-dynamic";

const updateSchema = z.object({
  label: z.string().trim().max(60).nullable().optional(),
  /** Null takes the tracker off its van. Stored history stays with the van. */
  vehicleId: z.string().nullable().optional(),
  /** False ignores this unit's reports without affecting the rest of the key. */
  active: z.boolean().optional(),
});

export const PATCH = handler<{ id: string }>(
  { permission: "tracker:manage" },
  async ({ principal, params, request }) => {
    const existing = await db.trackerDevice.findFirst({
      where: { id: params.id, ...scope(principal) },
      select: { id: true, companyId: true, vehicleId: true, label: true, active: true },
    });
    if (!existing) throw notFound("Tracker not found");

    const input = await parseBody(request, updateSchema);
    if (input.vehicleId) await assertVehicleFree(existing.companyId, input.vehicleId, existing.id);

    const device = await db.trackerDevice.update({
      where: { id: existing.id },
      data: {
        ...(input.label !== undefined ? { label: input.label || null } : {}),
        ...(input.vehicleId !== undefined ? { vehicleId: input.vehicleId } : {}),
        ...(input.active !== undefined ? { active: input.active } : {}),
      },
      include: { vehicle: { select: { id: true, plate: true } } },
    });

    await auditAs(
      principal,
      "UPDATE",
      "TrackerDevice",
      device.id,
      { from: { vehicleId: existing.vehicleId, active: existing.active }, to: { vehicleId: device.vehicleId, active: device.active } },
      request,
    );
    return device;
  },
);
