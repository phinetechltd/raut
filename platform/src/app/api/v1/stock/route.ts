import { z } from "zod";

import { handler, ok, parseBody } from "@/lib/api";
import { auditAs } from "@/lib/audit";
import { db } from "@/lib/db";
import { companyIdOf, scope } from "@/lib/tenant";
import { applyMovement, stockLevels } from "@/server/inventory";

export const dynamic = "force-dynamic";

export const GET = handler(
  { permission: "stock:read" },
  async ({ principal, searchParams }) => {
    const companyId = companyIdOf(principal);

    const locations = await db.stockLocation.findMany({
      where: { ...scope(principal), active: true },
      orderBy: { name: "asc" },
    });

    const levels = await stockLevels(companyId, {
      locationId: searchParams.get("locationId") ?? undefined,
      lowOnly: searchParams.get("low") === "true",
      search: searchParams.get("q") ?? undefined,
    });

    return {
      locations,
      levels,
      lowStockCount: levels.filter((l) => l.belowReorder).length,
    };
  },
);

const adjustSchema = z.object({
  productId: z.string(),
  locationId: z.string(),
  /** Signed. Negative writes stock off. */
  quantity: z.number().int().refine((n) => n !== 0, "Adjustment cannot be zero"),
  note: z.string().optional(),
});

/** Manual stock adjustment — always ledgered, never a silent balance edit. */
export const POST = handler(
  { permission: "stock:write" },
  async ({ principal, request }) => {
    const companyId = companyIdOf(principal);
    const input = await parseBody(request, adjustSchema);

    const movement = await db.$transaction((tx) =>
      applyMovement(tx, {
        companyId,
        productId: input.productId,
        locationId: input.locationId,
        type: "ADJUSTMENT",
        quantity: input.quantity,
        note: input.note,
        createdById: principal.userId,
      }),
    );

    await auditAs(principal, "CREATE", "StockMovement", movement.id, {
      productId: input.productId,
      quantity: input.quantity,
    }, request);

    return ok(movement, undefined, { status: 201 });
  },
);
