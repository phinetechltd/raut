import { z } from "zod";

import { handler, ok, pagination, paginationMeta, parseBody, withIdempotency } from "@/lib/api";
import { auditAs } from "@/lib/audit";
import { db } from "@/lib/db";
import { companyIdOf, scope } from "@/lib/tenant";
import { createSalesOrder } from "@/server/sales";

export const dynamic = "force-dynamic";

export const GET = handler(
  { permission: "order:read" },
  async ({ principal, searchParams }) => {
    const page = pagination(searchParams);
    const status = searchParams.get("status");
    const customerId = searchParams.get("customerId");

    const where = {
      ...scope(principal, { selfField: "createdById" }),
      ...(status ? { status } : {}),
      ...(customerId ? { customerId } : {}),
    };

    const [items, total] = await Promise.all([
      db.salesOrder.findMany({
        where,
        include: {
          customer: { select: { id: true, name: true, code: true } },
          lines: true,
          _count: { select: { invoices: true } },
        },
        orderBy: { orderDate: "desc" },
        take: page.take,
        skip: page.skip,
      }),
      db.salesOrder.count({ where }),
    ]);

    return ok(items, paginationMeta(page, total));
  },
);

const schema = z.object({
  customerId: z.string(),
  lines: z
    .array(
      z.object({
        productId: z.string(),
        quantity: z.number().int().positive(),
        unitPriceCents: z.number().int().nonnegative().optional(),
        discountCents: z.number().int().nonnegative().optional(),
        description: z.string().optional(),
      }),
    )
    .min(1),
  channel: z.enum(["CONSOLE", "POS", "FIELD"]).optional(),
  visitId: z.string().optional(),
  note: z.string().optional(),
  deliveryDate: z.string().optional(),
  confirm: z.boolean().optional(),
  /** Client UUID from the mobile app; makes the write replay-safe. */
  clientUuid: z.string().optional(),
});

export const POST = handler(
  { permission: "order:write" },
  async ({ principal, request }) => {
    const companyId = companyIdOf(principal);
    const input = await parseBody(request, schema);

    const customer = await db.customer.findFirst({
      where: { id: input.customerId, companyId },
    });
    if (!customer) throw new Error("Customer not found");

    const { data: order, replayed } = await withIdempotency(
      principal,
      input.clientUuid,
      "order.create",
      () =>
        createSalesOrder({
          companyId,
          customerId: input.customerId,
          branchId: principal.branchId ?? null,
          lines: input.lines,
          channel: input.channel ?? "CONSOLE",
          visitId: input.visitId ?? null,
          note: input.note ?? null,
          deliveryDate: input.deliveryDate ? new Date(input.deliveryDate) : null,
          clientUuid: input.clientUuid ?? null,
          createdById: principal.userId,
          confirm: input.confirm,
        }),
    );

    if (!replayed) {
      await auditAs(principal, "CREATE", "SalesOrder", order.id, { number: order.number }, request);
    }

    return ok(order, { replayed }, { status: replayed ? 200 : 201 });
  },
);
