import { z } from "zod";

import { handler, ok, pagination, paginationMeta, parseBody } from "@/lib/api";
import { auditAs } from "@/lib/audit";
import { db } from "@/lib/db";
import { companyIdOf, scope } from "@/lib/tenant";

export const dynamic = "force-dynamic";

export const GET = handler(
  { permission: "product:read" },
  async ({ principal, searchParams }) => {
    const page = pagination(searchParams, 100);
    const search = searchParams.get("q");
    const categoryId = searchParams.get("categoryId");

    const where = {
      ...scope(principal),
      ...(searchParams.get("includeInactive") === "true" ? {} : { active: true }),
      ...(categoryId ? { categoryId } : {}),
      ...(search
        ? {
            OR: [
              { name: { contains: search } },
              { sku: { contains: search } },
              { barcode: { contains: search } },
            ],
          }
        : {}),
    };

    const [items, total] = await Promise.all([
      db.product.findMany({
        where,
        include: {
          category: { select: { id: true, name: true } },
          stockItems: { select: { quantity: true, locationId: true } },
        },
        orderBy: { name: "asc" },
        take: page.take,
        skip: page.skip,
      }),
      db.product.count({ where }),
    ]);

    return ok(
      items.map((p) => ({
        ...p,
        stockOnHand: p.stockItems.reduce((sum, s) => sum + s.quantity, 0),
      })),
      paginationMeta(page, total),
    );
  },
);

const schema = z.object({
  sku: z.string().min(1),
  name: z.string().min(2),
  description: z.string().optional(),
  unit: z.string().optional(),
  unitsPerPack: z.number().int().positive().optional(),
  barcode: z.string().optional(),
  sellPriceCents: z.number().int().nonnegative(),
  costPriceCents: z.number().int().nonnegative().optional(),
  taxRateBp: z.number().int().min(0).max(10_000).optional(),
  reorderLevel: z.number().int().nonnegative().optional(),
  trackStock: z.boolean().optional(),
  categoryId: z.string().optional(),
});

export const POST = handler(
  { permission: "product:write" },
  async ({ principal, request }) => {
    const companyId = companyIdOf(principal);
    const input = await parseBody(request, schema);

    const product = await db.product.create({
      data: {
        companyId,
        sku: input.sku,
        name: input.name,
        description: input.description ?? null,
        unit: input.unit ?? "PC",
        unitsPerPack: input.unitsPerPack ?? 1,
        barcode: input.barcode ?? null,
        sellPriceCents: input.sellPriceCents,
        costPriceCents: input.costPriceCents ?? 0,
        taxRateBp: input.taxRateBp ?? 1600,
        reorderLevel: input.reorderLevel ?? 0,
        trackStock: input.trackStock ?? true,
        categoryId: input.categoryId ?? null,
      },
    });

    await auditAs(principal, "CREATE", "Product", product.id, { sku: product.sku }, request);
    return ok(product, undefined, { status: 201 });
  },
);
