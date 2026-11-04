import { z } from "zod";

import { handler, ok, pagination, paginationMeta, parseBody } from "@/lib/api";
import { auditAs } from "@/lib/audit";
import { db } from "@/lib/db";
import { companyIdOf, scope } from "@/lib/tenant";
import { TRANSFER_STATUSES, createTransfer, dispatchTransferIn } from "@/server/inventory";

export const dynamic = "force-dynamic";

export const GET = handler(
  { permission: "stock:read" },
  async ({ principal, searchParams }) => {
    const page = pagination(searchParams);
    const status = searchParams.get("status");
    const q = searchParams.get("q");
    const where = {
      ...scope(principal),
      ...(status && (TRANSFER_STATUSES as string[]).includes(status) ? { status } : {}),
      ...(searchParams.get("fromLocationId") ? { fromLocationId: searchParams.get("fromLocationId")! } : {}),
      ...(searchParams.get("toLocationId") ? { toLocationId: searchParams.get("toLocationId")! } : {}),
      ...(q
        ? {
            OR: [
              { number: { contains: q } },
              { note: { contains: q } },
              { lines: { some: { product: { OR: [{ name: { contains: q } }, { sku: { contains: q } }] } } } },
            ],
          }
        : {}),
    };

    const [items, total] = await Promise.all([
      db.stockTransfer.findMany({
        where,
        include: {
          fromLocation: { select: { id: true, name: true } },
          toLocation: { select: { id: true, name: true } },
          lines: { include: { product: { select: { id: true, name: true, sku: true } } } },
        },
        orderBy: { createdAt: "desc" },
        take: page.take,
        skip: page.skip,
      }),
      db.stockTransfer.count({ where }),
    ]);

    return ok(items, paginationMeta(page, total));
  },
);

const schema = z.object({
  fromLocationId: z.string(),
  toLocationId: z.string(),
  note: z.string().max(500).optional(),
  lines: z
    .array(z.object({ productId: z.string(), quantity: z.number().int().positive() }))
    .min(1),
  /** Dispatch everything immediately after creating. */
  dispatch: z.boolean().optional(),
});

/** Creates a DRAFT transfer between two of this company's locations. */
export const POST = handler(
  { permission: "stock:write" },
  async ({ principal, request }) => {
    const companyId = companyIdOf(principal);
    const input = await parseBody(request, schema);

    const transfer = await db.$transaction(
      async (tx) => {
        const created = await createTransfer(tx, {
          companyId,
          fromLocationId: input.fromLocationId,
          toLocationId: input.toLocationId,
          note: input.note ?? null,
          lines: input.lines,
          createdById: principal.userId,
        });
        if (!input.dispatch) {
          return tx.stockTransfer.findUniqueOrThrow({
            where: { id: created.id },
            include: {
              lines: { include: { product: { select: { name: true, sku: true } } } },
              fromLocation: { select: { id: true, name: true } },
              toLocation: { select: { id: true, name: true } },
            },
          });
        }
        return dispatchTransferIn(tx, created.id, principal.userId, { companyId });
      },
      { timeout: 15_000 },
    );

    await auditAs(principal, "CREATE", "StockTransfer", transfer.id, { number: transfer.number }, request);
    return ok(transfer, undefined, { status: 201 });
  },
);
