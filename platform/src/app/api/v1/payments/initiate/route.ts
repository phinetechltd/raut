import { z } from "zod";

import { handler, parseBody } from "@/lib/api";
import { auditAs } from "@/lib/audit";
import { companyIdOf } from "@/lib/tenant";
import { initiateCollection } from "@/server/collections";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  customerId: z.string().min(1),
  provider: z.enum(["PAYSTACK", "MPESA_DARAJA", "KCB_BUNI"]),
  amountCents: z.number().int().positive(),
  payerPhone: z.string().optional(),
  payerEmail: z.string().email().optional(),
  visitId: z.string().optional(),
  /** Idempotency key, same contract as the offline outbox. */
  clientUuid: z.string().min(8).optional(),
});

/**
 * Starts a gateway collection.
 *
 * Returns the intent rather than a bare success flag: the caller polls
 * /payments/intents/{id} until it reaches a terminal state, because an STK push
 * lives for minutes while the customer finds their phone and enters a PIN.
 */
export const POST = handler(
  { permission: "payment:write" },
  async ({ principal, request }) => {
    const body = await parseBody(request, bodySchema);

    // The callback has to be an address the provider can reach, which rules out
    // deriving it from the request when that request came from a handset on a
    // mobile network. It is configuration, not inference.
    const baseUrl =
      process.env.PUBLIC_BASE_URL ??
      process.env.NEXT_PUBLIC_APP_URL ??
      new URL(request.url).origin;

    const intent = await initiateCollection({
      companyId: companyIdOf(principal),
      customerId: body.customerId,
      provider: body.provider,
      amountCents: body.amountCents,
      payerPhone: body.payerPhone ?? null,
      payerEmail: body.payerEmail ?? null,
      visitId: body.visitId ?? null,
      clientUuid: body.clientUuid ?? null,
      createdById: principal.userId,
      baseUrl,
    });

    await auditAs(
      principal,
      "PAYMENT_INITIATE",
      "PaymentIntent",
      intent.id,
      {
        provider: intent.provider,
        amountCents: intent.amountCents,
        status: intent.status,
      },
      request,
    );

    return intent;
  },
);
