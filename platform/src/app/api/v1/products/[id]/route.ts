import { z } from "zod";

import { ApiError, handler, notFound, parseBody } from "@/lib/api";
import { auditAs, diff } from "@/lib/audit";
import { db } from "@/lib/db";
import { isItemClassCode, isItemTypeCode, isTaxTypeCode } from "@/lib/etims-codes";
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
  // eTIMS classification. Null clears the override and the company default
  // applies again. Validated against the published code tables below, so a
  // typo surfaces here as a 422 rather than at KRA as a rejected sale.
  etimsItemClassCode: z.string().nullable().optional(),
  etimsTaxTypeCode: z.string().nullable().optional(),
  etimsItemTypeCode: z.string().nullable().optional(),
});

const invalidCode = (field: string, value: string, hint: string) =>
  new ApiError(422, "INVALID_ETIMS_CODE", `${field}: "${value}" is not ${hint}`, { field, value });

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

    if (data.etimsItemClassCode != null && !isItemClassCode(data.etimsItemClassCode)) {
      throw invalidCode("etimsItemClassCode", String(data.etimsItemClassCode), "an eTIMS item classification (eight digits)");
    }
    if (data.etimsTaxTypeCode != null && !isTaxTypeCode(data.etimsTaxTypeCode)) {
      throw invalidCode("etimsTaxTypeCode", String(data.etimsTaxTypeCode), "an eTIMS tax type (A–E)");
    }
    if (data.etimsItemTypeCode != null && !isItemTypeCode(data.etimsItemTypeCode)) {
      throw invalidCode("etimsItemTypeCode", String(data.etimsItemTypeCode), "an eTIMS item type (1, 2 or 3)");
    }
    // Reclassifying a product whose registration KRA refused gives it another
    // go: the refusal was about the old codes.
    const reclassified = ["etimsItemClassCode", "etimsTaxTypeCode", "etimsItemTypeCode"].some((k) => k in data);
    if (reclassified && existing.etimsStatus === "FAILED" && !existing.etimsItemCode) {
      data.etimsStatus = "UNREGISTERED";
      data.etimsError = null;
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
