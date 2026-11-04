import { z } from "zod";

import { handler, notFound, ok, pagination, paginationMeta, parseBody, withIdempotency } from "@/lib/api";
import { auditAs } from "@/lib/audit";
import { db } from "@/lib/db";
import { nextNumber } from "@/lib/numbering";
import { companyIdOf, scope } from "@/lib/tenant";

export const dynamic = "force-dynamic";

export const GET = handler(
  { permission: "expense:read" },
  async ({ principal, searchParams }) => {
    const page = pagination(searchParams);
    const where = {
      ...scope(principal, { selfField: "userId" }),
      ...(searchParams.get("status") ? { status: searchParams.get("status")! } : {}),
    };

    const [items, total, categories] = await Promise.all([
      db.expense.findMany({
        where,
        include: {
          category: { select: { id: true, name: true } },
          user: { select: { id: true, name: true } },
        },
        orderBy: { incurredAt: "desc" },
        take: page.take,
        skip: page.skip,
      }),
      db.expense.count({ where }),
      db.expenseCategory.findMany({
        where: { ...scope(principal), active: true },
        orderBy: { name: "asc" },
      }),
    ]);

    return ok(items, { ...paginationMeta(page, total), categories });
  },
);

const schema = z.object({
  description: z.string().min(2),
  amountCents: z.number().int().positive(),
  categoryId: z.string().optional(),
  incurredAt: z.string().optional(),
  paymentMethod: z.enum(["CASH", "MPESA", "BANK", "PETTY_CASH"]).optional(),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
  receiptUrl: z.string().optional(),
  clientUuid: z.string().optional(),
});

/** Field expense claim — proposal p.3 lists expense claims alongside reporting. */
export const POST = handler(
  { permission: "expense:write" },
  async ({ principal, request }) => {
    const companyId = companyIdOf(principal);
    const input = await parseBody(request, schema);

    // The category decides which ledger account the claim posts to on
    // approval, so a foreign id would book this company's spend against
    // another's chart.
    if (input.categoryId) {
      const category = await db.expenseCategory.findFirst({
        where: { id: input.categoryId, companyId },
        select: { id: true },
      });
      if (!category) throw notFound("Expense category not found");
    }

    // The work takes `tx`, so the number, the row and the idempotency key are
    // one transaction: a failure burns no EXP number and leaves no key that
    // would replay a claim that was never written.
    const { data: expense, replayed } = await withIdempotency(
      principal,
      input.clientUuid,
      "expense.create",
      async (tx) =>
        tx.expense.create({
          data: {
            companyId,
            branchId: principal.branchId ?? null,
            categoryId: input.categoryId ?? null,
            userId: principal.userId,
            number: await nextNumber(companyId, "EXPENSE", tx),
            description: input.description,
            amountCents: input.amountCents,
            status: "SUBMITTED",
            incurredAt: input.incurredAt ? new Date(input.incurredAt) : new Date(),
            paymentMethod: input.paymentMethod ?? "CASH",
            latitude: input.latitude ?? null,
            longitude: input.longitude ?? null,
            receiptUrl: input.receiptUrl ?? null,
            clientUuid: input.clientUuid ?? null,
          },
        }),
    );

    if (!replayed) {
      await auditAs(principal, "CREATE", "Expense", expense.id, { number: expense.number }, request);
    }

    return ok(expense, { replayed }, { status: replayed ? 200 : 201 });
  },
);
