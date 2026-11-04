import { z } from "zod";

import { handler, ok, parseBody } from "@/lib/api";
import { auditAs } from "@/lib/audit";
import { db } from "@/lib/db";
import { companyIdOf } from "@/lib/tenant";
import { repackStock } from "@/server/inventory";

export const dynamic = "force-dynamic";

const schema = z.object({
  locationId: z.string(),
  fromProductId: z.string(),
  fromQuantity: z.number().int().positive(),
  toProductId: z.string(),
  /** Omit to use fromQuantity × the source product's unitsPerPack. */
  toQuantity: z.number().int().positive().optional(),
  note: z.string().max(500).optional(),
});

/**
 * Split or repack stock: one product becomes another at the same location.
 *
 * Both legs are written in one transaction and share a REPACK reference, and
 * the source's value is carried into the target so the inventory account and
 * the shelf agree afterwards. Tenant checks happen inside repackStock, so a
 * product or location id from another company is simply not found.
 */
export const POST = handler(
  { permission: "stock:write" },
  async ({ principal, request }) => {
    const companyId = companyIdOf(principal);
    const input = await parseBody(request, schema);

    const result = await db.$transaction(
      (tx) =>
        repackStock(tx, {
          companyId,
          locationId: input.locationId,
          fromProductId: input.fromProductId,
          fromQuantity: input.fromQuantity,
          toProductId: input.toProductId,
          toQuantity: input.toQuantity,
          note: input.note,
          userId: principal.userId,
        }),
      { timeout: 15_000 },
    );

    await auditAs(
      principal,
      "CREATE",
      "StockRepack",
      result.refId,
      {
        fromProductId: input.fromProductId,
        fromQuantity: input.fromQuantity,
        toProductId: input.toProductId,
        toQuantity: result.in.quantity,
        valueCents: result.valueCents,
        remainderCents: result.remainderCents,
      },
      request,
    );

    return ok(result, undefined, { status: 201 });
  },
);
