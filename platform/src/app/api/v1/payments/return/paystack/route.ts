import { NextResponse } from "next/server";

import { handler } from "@/lib/api";
import { db } from "@/lib/db";
import { rateLimiter } from "@/lib/payments";
import { settleIntent } from "@/server/collections";

export const dynamic = "force-dynamic";

const allowReturn = rateLimiter(20, 0.5);

/**
 * Where Paystack sends the payer's browser after the hosted checkout.
 *
 * `callback_url` on the initialize call points here, with `?reference=` (Paystack
 * also appends `trxref`). This is a convenience for the payer, not the source
 * of truth: the webhook (`/payments/callbacks/paystack`, configured once on the
 * Paystack dashboard) and reconciliation settle the intent whether or not the
 * payer's browser ever comes back. Landing here simply triggers the same
 * verify-and-settle and then shows a plain page saying what the provider said.
 *
 * It is a GET with no session, so it reveals nothing beyond a status word and
 * the receipt reference, and it only ever looks up intents by the Paystack
 * reference we issued.
 */
export const GET = handler({ public: true }, async ({ request, searchParams }) => {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? request.headers.get("x-real-ip") ?? "unknown";
  const statusPage = new URL("/api/v1/payments/return/status", request.url);

  if (!allowReturn(ip)) {
    statusPage.searchParams.set("s", "pending");
    return NextResponse.redirect(statusPage, 303);
  }

  const reference = searchParams.get("reference") ?? searchParams.get("trxref");
  if (!reference || reference.length > 200) {
    statusPage.searchParams.set("s", "unknown");
    return NextResponse.redirect(statusPage, 303);
  }

  const intent = await db.paymentIntent.findFirst({
    where: { provider: "PAYSTACK", OR: [{ providerRef: reference }, { id: reference }] },
    select: { id: true },
  });
  if (!intent) {
    statusPage.searchParams.set("s", "unknown");
    return NextResponse.redirect(statusPage, 303);
  }

  let status = "pending";
  let receipt: string | null = null;
  let amount: string | null = null;
  try {
    const settled = await settleIntent(intent.id);
    receipt = settled.receiptRef ?? settled.id;
    amount = `${settled.currency} ${(settled.amountCents / 100).toFixed(2)}`;
    status =
      settled.status === "SUCCEEDED" || settled.status === "REVERSED"
        ? "succeeded"
        : settled.status === "FAILED" || settled.status === "EXPIRED" || settled.status === "CANCELLED"
          ? "failed"
          : "pending";
  } catch (error) {
    console.error("[payments] return/paystack settle failed", error);
  }

  statusPage.searchParams.set("s", status);
  if (receipt) statusPage.searchParams.set("ref", receipt);
  if (amount) statusPage.searchParams.set("amount", amount);
  return NextResponse.redirect(statusPage, 303);
});
