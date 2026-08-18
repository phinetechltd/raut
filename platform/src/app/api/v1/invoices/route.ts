import { z } from "zod";

import { handler, ok, pagination, paginationMeta, parseBody, withIdempotency } from "@/lib/api";
import { auditAs } from "@/lib/audit";
import { db } from "@/lib/db";
import { companyIdOf, scope } from "@/lib/tenant";
import { createInvoice, refreshOverdueStatuses } from "@/server/sales";

export const dynamic = "force-dynamic";

export const GET = handler(
  { permission: "invoice:read" },
  async ({ principal, searchParams }) => {
    const companyId = companyIdOf(principal);
    // Statuses only change when money moves, so a due date that passed
    // overnight needs sweeping before the list is rendered.
    await refreshOverdueStatuses(companyId);

    const page = pagination(searchParams);
    const status = searchParams.get("status");
    const customerId = searchParams.get("customerId");
    const unpaidOnly = searchParams.get("unpaid") === "true";

    const where = {
      ...scope(principal, { selfField: "createdById" }),
      ...(status ? { status } : {}),
      ...(customerId ? { customerId } : {}),
      ...(unpaidOnly ? { status: { in: ["ISSUED", "PARTIALLY_PAID", "OVERDUE"] } } : {}),
    };

    const [items, total] = await Promise.all([
      db.invoice.findMany({
        where,
        include: {
          customer: { select: { id: true, name: true, code: true, phone: true } },
          lines: true,
        },
        orderBy: { issueDate: "desc" },
        take: page.take,
        skip: page.skip,
      }),
      db.invoice.count({ where }),
    ]);

    return ok(
      items.map((i) => ({ ...i, outstandingCents: i.totalCents - i.paidCents })),
      paginationMeta(page, total),
    );
  },
);

const schema = z.object({
  customerId: z.string(),
  orderId: z.string().optional(),
  locationId: z.string().optional(),
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
  dueDate: z.string().optional(),
  issue: z.boolean().optional(),
  clientUuid: z.string().optional(),
});

export const POST = handler(
  { permission: "invoice:write" },
  async ({ principal, request }) => {
    const companyId = companyIdOf(principal);
    const input = await parseBody(request, schema);

    const { data: invoice, replayed } = await withIdempotency(
      principal,
      input.clientUuid,
      "invoice.create",
      () =>
        createInvoice({
          companyId,
          customerId: input.customerId,
          branchId: principal.branchId ?? null,
          locationId: input.locationId ?? null,
          orderId: input.orderId ?? null,
          lines: input.lines,
          channel: input.channel ?? "CONSOLE",
          visitId: input.visitId ?? null,
          note: input.note ?? null,
          dueDate: input.dueDate ? new Date(input.dueDate) : null,
          clientUuid: input.clientUuid ?? null,
          createdById: principal.userId,
          issue: input.issue,
        }),
    );

    if (!replayed) {
      await auditAs(principal, "CREATE", "Invoice", invoice.id, { number: invoice.number }, request);
    }

    return ok(invoice, { replayed }, { status: replayed ? 200 : 201 });
  },
);
