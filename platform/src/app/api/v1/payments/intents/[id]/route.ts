import { handler, fail } from "@/lib/api";
import { db } from "@/lib/db";
import { companyIdOf } from "@/lib/tenant";
import { settleIntent } from "@/server/collections";

export const dynamic = "force-dynamic";

/**
 * Poll a collection.
 *
 * Every read re-asks the provider while the intent is live, so the answer is
 * the gateway's, not a cached guess. Once terminal, settleIntent short-circuits
 * and this is a plain database read.
 */
export const GET = handler<{ id: string }>(
  { permission: "payment:read" },
  async ({ principal, params }) => {
    const companyId = companyIdOf(principal);

    // Scoped by company first: an id from another tenant must be indistinguishable
    // from one that does not exist.
    const existing = await db.paymentIntent.findFirst({
      where: { id: params.id, companyId },
      select: { id: true },
    });
    if (!existing) return fail(404, "NOT_FOUND", "Payment not found");

    const intent = await settleIntent(params.id);
    return {
      id: intent.id,
      provider: intent.provider,
      status: intent.status,
      amountCents: intent.amountCents,
      receiptRef: intent.receiptRef,
      failureReason: intent.failureReason,
      paymentId: intent.paymentId,
      completedAt: intent.completedAt,
    };
  },
);
