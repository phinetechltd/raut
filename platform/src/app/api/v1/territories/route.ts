import { z } from "zod";

import { handler, ok, parseBody } from "@/lib/api";
import { auditAs } from "@/lib/audit";
import { db } from "@/lib/db";
import { companyIdOf, scope } from "@/lib/tenant";

export const dynamic = "force-dynamic";

export const GET = handler({ permission: "customer:read" }, async ({ principal }) => {
  return db.territory.findMany({
    where: { ...scope(principal), active: true },
    include: { _count: { select: { customers: true } } },
    orderBy: { name: "asc" },
  });
});

const schema = z.object({
  name: z.string().min(2),
  code: z.string().min(1),
  colour: z.string().optional(),
  /** Closed polygon as [[lat, lng], …]. Empty falls back to centre + radius. */
  boundary: z.array(z.tuple([z.number(), z.number()])).optional(),
  centerLat: z.number().min(-90).max(90).optional(),
  centerLng: z.number().min(-180).max(180).optional(),
  radiusM: z.number().int().min(100).max(200_000).optional(),
});

export const POST = handler(
  { permission: "territory:write" },
  async ({ principal, request }) => {
    const companyId = companyIdOf(principal);
    const input = await parseBody(request, schema);

    const territory = await db.territory.create({
      data: {
        companyId,
        name: input.name,
        code: input.code,
        colour: input.colour ?? "#2f83f7",
        boundary: JSON.stringify(input.boundary ?? []),
        centerLat: input.centerLat ?? null,
        centerLng: input.centerLng ?? null,
        radiusM: input.radiusM ?? 2000,
      },
    });

    await auditAs(principal, "CREATE", "Territory", territory.id, { name: territory.name }, request);
    return ok(territory, undefined, { status: 201 });
  },
);
