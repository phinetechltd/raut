import { z } from "zod";

import { handler, notFound, ok, parseBody } from "@/lib/api";
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

    // Both ids come from the client. Resolved against this company first, so
    // a foreign id is "not found" rather than a stock item under our tenant —
    // and the product's cost is what values the adjustment.
    const [product, location] = await Promise.all([
      db.product.findFirst({
        where: { id: input.productId, companyId },
        select: { id: true, costPriceCents: true },
      }),
      db.stockLocation.findFirst({
        where: { id: input.locationId, companyId },
        select: { id: true },
      }),
    ]);
    if (!product) throw notFound("Product not found");
    if (!location) throw notFound("Stock location not found");

    const movement = await db.$transaction(
      (tx) =>
        applyMovement(tx, {
          companyId,
          productId: product.id,
          locationId: location.id,
          type: "ADJUSTMENT",
          quantity: input.quantity,
          // Valued at the product's cost, so the inventory account moves with
          // the shelf. An adjustment with no cost changes the quantity report
          // and leaves the balance sheet behind.
          unitCostCents: product.costPriceCents,
          note: input.note,
          createdById: principal.userId,
        }),
      { timeout: 15_000 },
    );

    await auditAs(principal, "CREATE", "StockMovement", movement.id, {
      productId: input.productId,
      quantity: input.quantity,
    }, request);

    return ok(movement, undefined, { status: 201 });
  },
);
