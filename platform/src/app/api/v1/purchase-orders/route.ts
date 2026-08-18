import { z } from "zod";

import { handler, ok, pagination, paginationMeta, parseBody } from "@/lib/api";
import { auditAs } from "@/lib/audit";
import { db } from "@/lib/db";
import { computeLine, computeTotals } from "@/lib/money";
import { nextNumber } from "@/lib/numbering";
import { companyIdOf, scope } from "@/lib/tenant";

export const dynamic = "force-dynamic";

export const GET = handler(
  { permission: "purchase:read" },
  async ({ principal, searchParams }) => {
    const page = pagination(searchParams);
    const where = {
      ...scope(principal),
      ...(searchParams.get("status") ? { status: searchParams.get("status")! } : {}),
      ...(searchParams.get("supplierId") ? { supplierId: searchParams.get("supplierId")! } : {}),
    };

    const [items, total] = await Promise.all([
      db.purchaseOrder.findMany({
        where,
        include: {
          supplier: { select: { id: true, name: true, code: true } },
          lines: { include: { product: { select: { name: true, sku: true } } } },
        },
        orderBy: { orderDate: "desc" },
        take: page.take,
        skip: page.skip,
      }),
      db.purchaseOrder.count({ where }),
    ]);

    return ok(items, paginationMeta(page, total));
  },
);

const schema = z.object({
  supplierId: z.string(),
  expectedAt: z.string().optional(),
  note: z.string().optional(),
  send: z.boolean().optional(),
  lines: z
    .array(
      z.object({
        productId: z.string(),
        quantity: z.number().int().positive(),
        unitCostCents: z.number().int().nonnegative(),
        description: z.string().optional(),
      }),
    )
    .min(1),
});

export const POST = handler(
  { permission: "purchase:write" },
  async ({ principal, request }) => {
    const companyId = companyIdOf(principal);
    const input = await parseBody(request, schema);

    const products = await db.product.findMany({
      where: { companyId, id: { in: input.lines.map((l) => l.productId) } },
      select: { id: true, name: true, taxRateBp: true },
    });
    const byId = new Map(products.map((p) => [p.id, p]));

    const lines = input.lines.map((line) => {
      const product = byId.get(line.productId);
      if (!product) throw new Error(`Unknown product ${line.productId}`);
      const totals = computeLine({
        quantity: line.quantity,
        unitPriceCents: line.unitCostCents,
        taxRateBp: product.taxRateBp,
      });
      return {
        productId: line.productId,
        description: line.description ?? product.name,
        quantity: line.quantity,
        unitCostCents: line.unitCostCents,
        taxRateBp: product.taxRateBp,
        lineTotalCents: totals.lineTotalCents,
      };
    });

    const totals = computeTotals(
      lines.map((l) => ({
        quantity: l.quantity,
        unitPriceCents: l.unitCostCents,
        taxRateBp: l.taxRateBp,
      })),
    );

    const po = await db.purchaseOrder.create({
      data: {
        companyId,
        branchId: principal.branchId ?? null,
        supplierId: input.supplierId,
        number: await nextNumber(companyId, "PO"),
        status: input.send ? "SENT" : "DRAFT",
        expectedAt: input.expectedAt ? new Date(input.expectedAt) : null,
        note: input.note ?? null,
        subtotalCents: totals.subtotalCents,
        taxCents: totals.taxCents,
        totalCents: totals.totalCents,
        createdById: principal.userId,
        lines: { create: lines },
      },
      include: { lines: true, supplier: true },
    });

    await auditAs(principal, "CREATE", "PurchaseOrder", po.id, { number: po.number }, request);
    return ok(po, undefined, { status: 201 });
  },
);
