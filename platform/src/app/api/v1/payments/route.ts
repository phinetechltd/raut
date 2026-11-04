import { z } from "zod";

import { handler, ok, pagination, paginationMeta, parseBody, withIdempotency } from "@/lib/api";
import { auditAs } from "@/lib/audit";
import { db } from "@/lib/db";
import { companyIdOf, scope } from "@/lib/tenant";
import { notifyPayment, recordPayment } from "@/server/sales";

export const dynamic = "force-dynamic";

export const GET = handler(
  { permission: "payment:read" },
  async ({ principal, searchParams }) => {
    const page = pagination(searchParams);
    const customerId = searchParams.get("customerId");

    const where = {
      ...scope(principal, { selfField: "createdById" }),
      ...(customerId ? { customerId } : {}),
    };

    const [items, total] = await Promise.all([
      db.payment.findMany({
        where,
        include: {
          customer: { select: { id: true, name: true, code: true } },
          allocations: { include: { invoice: { select: { number: true } } } },
        },
        orderBy: { paidAt: "desc" },
        take: page.take,
        skip: page.skip,
      }),
      db.payment.count({ where }),
    ]);

    return ok(items, paginationMeta(page, total));
  },
);

const schema = z.object({
  customerId: z.string(),
  amountCents: z.number().int().positive(),
  // CREDIT_NOTE is deliberately absent: a credit note is a document with its
  // own route (/credit-notes), not a way money arrives. Accepting it here
  // booked phantom cash against the Cash account.
  // Gateway methods (MPESA_STK, PAYSTACK, KCB_BUNI) are deliberately absent
  // too: only settleIntent books those, after the provider confirms. Record a
  // code the customer already paid as MPESA; collect live via /payments/initiate.
  method: z.enum(["CASH", "MPESA", "BANK", "CHEQUE"]).optional(),
  reference: z.string().optional(),
  paidAt: z.string().optional(),
  note: z.string().optional(),
  visitId: z.string().optional(),
  // `intent:<id>` is the uuid shape settleIntent books under; a client may
  // not claim it.
  clientUuid: z.string().refine((v) => !v.startsWith("intent:"), "Reserved client reference").optional(),
  /** Omit to allocate oldest-due-first. */
  allocations: z
    .array(z.object({ invoiceId: z.string(), amountCents: z.number().int().positive() }))
    .optional(),
});

// Allocation validity — invoice exists, same customer, not draft, within what
// is outstanding net of credit notes, total within the payment — is enforced
// by recordPayment with a 422, never silently skipped.

export const POST = handler(
  { permission: "payment:write" },
  async ({ principal, request }) => {
    const companyId = companyIdOf(principal);
    const input = await parseBody(request, schema);

    const { data, replayed } = await withIdempotency(
      principal,
      input.clientUuid,
      "payment.create",
      async () => {
        const result = await recordPayment({
          companyId,
          customerId: input.customerId,
          amountCents: input.amountCents,
          method: input.method ?? "CASH",
          reference: input.reference ?? null,
          paidAt: input.paidAt ? new Date(input.paidAt) : undefined,
          note: input.note ?? null,
          visitId: input.visitId ?? null,
          clientUuid: input.clientUuid ?? null,
          createdById: principal.userId,
          allocations: input.allocations,
        });

        // Deliberately after the transaction: the money is already collected,
        // and a provider timeout must not roll that back.
        await notifyPayment({
          companyId,
          customerId: result.customer.id,
          amountCents: result.payment.amountCents,
          balanceCents: result.customer.balanceCents,
          phone: result.customer.phone,
          customerName: result.customer.name,
        });

        return result.payment;
      },
    );

    if (!replayed) {
      await auditAs(principal, "CREATE", "Payment", data.id, { number: data.number }, request);
    }

    return ok(data, { replayed }, { status: replayed ? 200 : 201 });
  },
);
