import { z } from "zod";

import { handler, notFound, parseBody } from "@/lib/api";
import { auditAs } from "@/lib/audit";
import { db } from "@/lib/db";
import { scope } from "@/lib/tenant";
import { issueTrackerKey } from "@/server/trackers";

export const dynamic = "force-dynamic";

const updateSchema = z.object({
  name: z.string().trim().min(2).max(60).optional(),
  provider: z.enum(["GENERIC", "TRACCAR"]).optional(),
  /** False revokes the key at once; true restores it. */
  active: z.boolean().optional(),
  /** Replaces the key. The old one stops working immediately. */
  rotate: z.literal(true).optional(),
});

export const PATCH = handler<{ id: string }>(
  { permission: "tracker:manage" },
  async ({ principal, params, request }) => {
    const existing = await db.trackerIntegration.findFirst({
      where: { id: params.id, ...scope(principal) },
      select: { id: true },
    });
    if (!existing) throw notFound("Integration not found");

    const input = await parseBody(request, updateSchema);
    const issued = input.rotate ? issueTrackerKey() : null;

    const integration = await db.trackerIntegration.update({
      where: { id: existing.id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.provider !== undefined ? { provider: input.provider } : {}),
        ...(input.active !== undefined ? { active: input.active } : {}),
        ...(issued ? { keyHash: issued.keyHash, keyPrefix: issued.keyPrefix, active: true } : {}),
      },
      select: { id: true, name: true, provider: true, keyPrefix: true, active: true, lastUsedAt: true },
    });

    // The audit trail records that a key changed and which one, never its value.
    await auditAs(
      principal,
      "UPDATE",
      "TrackerIntegration",
      integration.id,
      {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.active !== undefined ? { active: input.active } : {}),
        ...(issued ? { rotated: true, keyPrefix: issued.keyPrefix } : {}),
      },
      request,
    );

    return { ...integration, ...(issued ? { apiKey: issued.apiKey } : {}) };
  },
);
