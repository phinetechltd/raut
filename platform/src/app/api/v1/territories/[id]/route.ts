import { z } from "zod";

import { handler, notFound, parseBody } from "@/lib/api";
import { auditAs, diff } from "@/lib/audit";
import { db } from "@/lib/db";
import { scope } from "@/lib/tenant";

export const dynamic = "force-dynamic";

const updateSchema = z.object({
  name: z.string().min(2).optional(),
  colour: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  boundary: z.array(z.object({ lat: z.number(), lng: z.number() })).optional(),
  centerLat: z.number().min(-90).max(90).nullable().optional(),
  centerLng: z.number().min(-180).max(180).nullable().optional(),
  radiusM: z.number().int().min(100).max(200_000).optional(),
  active: z.boolean().optional(),
});

export const PATCH = handler<{ id: string }>(
  { permission: "territory:write" },
  async ({ principal, params, request }) => {
    const existing = await db.territory.findFirst({
      where: { id: params.id, ...scope(principal) },
    });
    if (!existing) throw notFound("Territory not found");

    const input = await parseBody(request, updateSchema);
    const data: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
      if (value === undefined) continue;
      data[key === "boundary" ? "boundary" : key] = key === "boundary" ? JSON.stringify(value) : value;
    }

    const territory = await db.territory.update({ where: { id: params.id }, data });

    await auditAs(
      principal,
      "UPDATE",
      "Territory",
      territory.id,
      diff(existing as unknown as Record<string, unknown>, data),
      request,
    );
    return territory;
  },
);
