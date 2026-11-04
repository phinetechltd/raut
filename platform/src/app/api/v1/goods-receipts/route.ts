import { z } from "zod";

import { handler, ok, pagination, paginationMeta, parseBody, parseDate } from "@/lib/api";
import { auditAs } from "@/lib/audit";
import { db } from "@/lib/db";
import { companyIdOf, scope } from "@/lib/tenant";
import { createGoodsReceipt, postGoodsReceiptIn } from "@/server/inventory";

export const dynamic = "force-dynamic";

export const GET = handler(
  { permission: "purchase:read" },
  async ({ principal, searchParams }) => {
    const page = pagination(searchParams);
    const status = searchParams.get("status");
    const q = searchParams.get("q");
    const where = {
      ...scope(principal),
      ...(status === "DRAFT" || status === "POSTED" ? { status } : {}),
      ...(searchParams.get("poId") ? { poId: searchParams.get("poId")! } : {}),
      ...(searchParams.get("supplierId") ? { supplierId: searchParams.get("supplierId")! } : {}),
      ...(q ? { OR: [{ number: { contains: q } }, { supplier: { name: { contains: q } } }] } : {}),
    };

    const [items, total] = await Promise.all([
      db.goodsReceipt.findMany({
        where,
        include: {
          supplier: { select: { id: true, name: true } },
          location: { select: { id: true, name: true } },
          po: { select: { id: true, number: true, status: true } },
          lines: { include: { product: { select: { id: true, name: true, sku: true } } } },
        },
        orderBy: { receivedAt: "desc" },
        take: page.take,
        skip: page.skip,
      }),
      db.goodsReceipt.count({ where }),
    ]);

    return ok(items, paginationMeta(page, total));
  },
);

const schema = z.object({
  /** Required when there is no purchase order; must match the PO's supplier otherwise. */
  supplierId: z.string().optional(),
  poId: z.string().optional(),
  locationId: z.string(),
  receivedAt: z.string().optional(),
  note: z.string().max(500).optional(),
  /** Accept more than the purchase order asked for. */
  allowOver: z.boolean().optional(),
  /** Post immediately after creating. */
  post: z.boolean().optional(),
  lines: z
    .array(
      z.object({
        productId: z.string(),
        quantity: z.number().int().positive(),
        unitCostCents: z.number().int().nonnegative().optional(),
        /** Where this line lands; omit for the receipt's location. */
        locationId: z.string().optional(),
        /** The purchase order line it fulfils; omit to match by product. */
        poLineId: z.string().optional(),
      }),
    )
    .min(1),
});

/** Records goods arriving, against a purchase order or free-standing. DRAFT until posted. */
export const POST = handler(
  { permission: "grn:write" },
  async ({ principal, request }) => {
    const companyId = companyIdOf(principal);
    const input = await parseBody(request, schema);
    const receivedAt = parseDate(input.receivedAt) ?? undefined;

    const grn = await db.$transaction(
      async (tx) => {
        const created = await createGoodsReceipt(tx, {
          companyId,
          supplierId: input.supplierId,
          poId: input.poId ?? null,
          locationId: input.locationId,
          receivedAt,
          note: input.note ?? null,
          allowOver: input.allowOver,
          lines: input.lines,
          createdById: principal.userId,
        });
        if (input.post) {
          return postGoodsReceiptIn(tx, created.id, principal.userId, {
            companyId,
            allowOver: input.allowOver,
          });
        }
        return tx.goodsReceipt.findUniqueOrThrow({
          where: { id: created.id },
          include: {
            lines: { include: { product: { select: { name: true, sku: true } } } },
            supplier: { select: { id: true, name: true } },
            location: { select: { id: true, name: true } },
          },
        });
      },
      { timeout: 15_000 },
    );

    await auditAs(principal, "CREATE", "GoodsReceipt", grn.id, {
      number: grn.number,
      status: grn.status,
      poId: input.poId ?? null,
    }, request);
    return ok(grn, undefined, { status: 201 });
  },
);
