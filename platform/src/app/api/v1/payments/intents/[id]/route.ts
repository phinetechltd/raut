import { handler, fail } from "@/lib/api";
import { db } from "@/lib/db";
import { companyIdOf } from "@/lib/tenant";
import { settleIntent, toPublicIntent } from "@/server/collections";

export const dynamic = "force-dynamic";

/**
 * Poll a collection.
 *
 * Every read re-asks the provider while the intent is live, so the answer is
 * the gateway's, not a cached guess. Once terminal, settleIntent short-circuits
 * and this is a plain database read — unless `?recheck=1`, which the console's
 * "Re-check" button sends so a Paystack charge reversed after settlement is
 * noticed and marked REVERSED.
 *
 * Returns the public view only: no provider payload, no company id.
 */
export const GET = handler<{ id: string }>(
  { permission: "payment:read" },
  async ({ principal, params, searchParams }) => {
    const companyId = companyIdOf(principal);

    // Scoped by company first: an id from another tenant must be indistinguishable
    // from one that does not exist.
    const existing = await db.paymentIntent.findFirst({
      where: { id: params.id, companyId },
      select: { id: true },
    });
    if (!existing) return fail(404, "NOT_FOUND", "Payment not found");

    try {
      const intent = await settleIntent(params.id, {
        recheckSettled: searchParams.get("recheck") === "1",
      });
      return toPublicIntent(intent);
    } catch (error) {
      // A poll is a read as far as the caller is concerned. A transient
      // failure inside settlement (the provider down, a locked database while
      // the callback books the same intent) has already released any claim;
      // the handset gets the row as it stands and polls again, not a 500.
      console.warn(`[payments] poll of ${params.id} could not settle:`, error instanceof Error ? error.message : error);
      return toPublicIntent(await db.paymentIntent.findUniqueOrThrow({ where: { id: params.id } }));
    }
  },
);
