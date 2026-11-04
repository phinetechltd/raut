import { z } from "zod";

import { handler, ok, parseBody } from "@/lib/api";
import { auditAs } from "@/lib/audit";
import { db } from "@/lib/db";
import { companyIdOf, scope } from "@/lib/tenant";
import { adjustAcrossLocations, stockLevels } from "@/server/inventory";

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

const lineSchema = z.object({
  locationId: z.string(),
  /** Signed. Negative writes stock off at this location. */
  quantity: z.number().int().refine((n) => n !== 0, "Adjustment cannot be zero"),
});

/**
 * Either the single-location body the mobile app sends, or `lines` — one
 * product counted at several locations in one go.
 */
const adjustSchema = z.union([
  z.object({
    productId: z.string(),
    locationId: z.string(),
    quantity: z.number().int().refine((n) => n !== 0, "Adjustment cannot be zero"),
    note: z.string().optional(),
  }),
  z.object({
    productId: z.string(),
    lines: z.array(lineSchema).min(1),
    note: z.string().optional(),
  }),
]);

/**
 * Manual stock adjustment — always ledgered, never a silent balance edit.
 *
 * When the lines net to zero nothing was gained or lost, only found elsewhere,
 * so the count is recorded as a completed transfer between the locations
 * rather than as a write-off and a write-up that would both hit the P&L.
 */
export const POST = handler(
  { permission: "stock:write" },
  async ({ principal, request }) => {
    const companyId = companyIdOf(principal);
    const input = await parseBody(request, adjustSchema);
    const lines = "lines" in input ? input.lines : [{ locationId: input.locationId, quantity: input.quantity }];
    const note = input.note?.trim() || undefined;

    // Tenant checks and the per-location movements happen inside the one
    // transaction; a foreign product or location id is "not found" rather than
    // a stock item under our tenant.
    const result = await db.$transaction(
      (tx) =>
        adjustAcrossLocations(tx, {
          companyId,
          productId: input.productId,
          lines,
          note,
          userId: principal.userId,
        }),
      { timeout: 15_000 },
    );

    if (result.kind === "RELOCATION") {
      for (const t of result.transfers) {
        await auditAs(principal, "CREATE", "StockTransfer", t.id, {
          number: t.number,
          relocation: true,
          productId: input.productId,
        }, request);
      }
      return ok(result, undefined, { status: 201 });
    }

    for (const m of result.movements) {
      await auditAs(principal, "CREATE", "StockMovement", m.id, {
        productId: input.productId,
        locationId: m.locationId,
        quantity: m.quantity,
      }, request);
    }

    // The single-line call keeps its original shape: one movement.
    if (!("lines" in input)) return ok(result.movements[0], undefined, { status: 201 });
    return ok(result, undefined, { status: 201 });
  },
);
