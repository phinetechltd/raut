import { z } from "zod";

import { handler, notFound, parseBody } from "@/lib/api";
import { auditAs, diff } from "@/lib/audit";
import { db } from "@/lib/db";
import { scope } from "@/lib/tenant";

export const dynamic = "force-dynamic";

export const GET = handler<{ id: string }>(
  { permission: "product:read" },
  async ({ principal, params }) => {
    const product = await db.product.findFirst({
      where: { id: params.id, ...scope(principal) },
      include: {
        category: { select: { id: true, name: true } },
        stockItems: { include: { location: { select: { name: true } } } },
      },
    });
    if (!product) throw notFound("Product not found");
    return product;
  },
);

const updateSchema = z.object({
  name: z.string().min(2).optional(),
  description: z.string().nullable().optional(),
  unit: z.string().optional(),
  unitsPerPack: z.number().int().positive().optional(),
  barcode: z.string().nullable().optional(),
  sellPriceCents: z.number().int().nonnegative().optional(),
  costPriceCents: z.number().int().nonnegative().optional(),
  taxRateBp: z.number().int().min(0).max(10_000).optional(),
  reorderLevel: z.number().int().nonnegative().optional(),
  trackStock: z.boolean().optional(),
  categoryId: z.string().nullable().optional(),
  active: z.boolean().optional(),
});

export const PATCH = handler<{ id: string }>(
  { permission: "product:write" },
  async ({ principal, params, request }) => {
    const existing = await db.product.findFirst({
      where: { id: params.id, ...scope(principal) },
    });
    if (!existing) throw notFound("Product not found");

    const input = await parseBody(request, updateSchema);
    const data: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
      if (value === undefined) continue;
      data[key] = value === "" ? null : value;
    }

    const product = await db.product.update({ where: { id: params.id }, data });

    await auditAs(
      principal,
      "UPDATE",
      "Product",
      product.id,
      diff(existing as unknown as Record<string, unknown>, data),
      request,
    );
    return product;
  },
);
