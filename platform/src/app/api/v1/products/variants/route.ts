import { z } from "zod";

import { handler, parseBody } from "@/lib/api";
import { companyIdOf } from "@/lib/tenant";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/** Selling units for the company's products. */
export const GET = handler({ permission: "product:read" }, async ({ principal, searchParams }) => {
  const companyId = companyIdOf(principal);
  const productId = searchParams.get("productId");

  const rows = await db.productVariant.findMany({
    where: { companyId, ...(productId ? { productId } : {}), active: true },
    orderBy: [{ productId: "asc" }, { unitsPerVariant: "asc" }],
  });

  return { variants: rows };
});

const Body = z.object({
  productId: z.string().min(1),
  name: z.string().min(1),
  sku: z.string().min(1),
  barcode: z.string().optional(),
  unitsPerVariant: z.number().int().positive(),
  sellPriceCents: z.number().int().nonnegative(),
  isDefault: z.boolean().optional(),
  etimsItemClassCode: z.string().optional(),
  etimsPackageUnit: z.string().optional(),
});

export const POST = handler(
  { permission: "product:write" },
  async ({ principal, request }) => {
    const body = await parseBody(request, Body);
    const companyId = companyIdOf(principal);

    // Scoped: a product id from another tenant is simply not found.
    const product = await db.product.findFirst({
      where: { id: body.productId, companyId },
      select: { id: true },
    });
    if (!product) throw new Error("Product not found");

    const variant = await db.$transaction(async (tx) => {
      if (body.isDefault) {
        // Exactly one default. Two would leave the POS picking whichever the
        // query happened to return first, which is not the same on every run.
        await tx.productVariant.updateMany({
          where: { companyId, productId: body.productId },
          data: { isDefault: false },
        });
      }

      return tx.productVariant.create({
        data: {
          companyId,
          productId: body.productId,
          name: body.name,
          sku: body.sku,
          barcode: body.barcode ?? null,
          unitsPerVariant: body.unitsPerVariant,
          sellPriceCents: body.sellPriceCents,
          isDefault: body.isDefault ?? false,
          etimsItemClassCode: body.etimsItemClassCode ?? null,
          etimsPackageUnit: body.etimsPackageUnit ?? null,
        },
      });
    });

    return { variant };
  },
);
