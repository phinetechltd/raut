import { NextResponse } from "next/server";

import { handler } from "@/lib/api";
import { audit } from "@/lib/audit";
import {
  parseDarajaCallback,
  paystackEventKind,
  providerFor,
  rateLimiter,
  type PaymentProvider,
  type PaymentProviderName,
} from "@/lib/payments";
import {
  intentForCallback,
  referenceFromCallback,
  settleIntent,
  type SettleHint,
} from "@/server/collections";
import { resolveCredentials } from "@/server/credentials";

export const dynamic = "force-dynamic";

const SLUGS: Record<string, PaymentProviderName> = {
  paystack: "PAYSTACK",
  mpesa_daraja: "MPESA_DARAJA",
  kcb_buni: "KCB_BUNI",
};

// Thirty callbacks in a burst, then one a second, per source address. Real
// providers send one or two per collection; anything beyond this is a replay
// storm or a probe, and every accepted callback costs a provider round trip.
const allowCallback = rateLimiter(30, 1);

const acknowledged = (ignored?: string) => NextResponse.json({ ok: true, ...(ignored ? { ignored } : {}) });

/**
 * Gateway callbacks.
 *
 * Public by necessity — the provider has no session — which makes four things
 * non-negotiable:
 *
 *   1. **The body is never believed.** It identifies *which* collection changed;
 *      whether money moved is decided by `settleIntent`, which asks the provider
 *      directly. A forged callback therefore cannot conjure a payment: at worst
 *      it triggers a verification that returns PENDING. The one field taken
 *      from the body is the M-Pesa receipt number, and only once verify agrees.
 *   2. **Signatures are checked where the provider offers them.** Paystack signs
 *      with HMAC-SHA512, KCB with a shared secret when configured. Daraja does
 *      not sign at all, which is precisely why rule 1 exists.
 *   3. **Always 200.** Paystack and Daraja retry on any non-2xx, so an error for
 *      an unknown reference — or for our own bug — earns an escalating retry
 *      storm for a callback we were never going to act on differently. Internal
 *      failures are logged and acknowledged. The single exception is a bad
 *      signature, which is hostile and gets a 401 a retry cannot fix.
 *   4. **Rate limited per source**, so a flood cannot turn into a flood of
 *      verify calls against the provider.
 */
export const POST = handler<{ provider: string }>(
  { public: true },
  async ({ request, params }) => {
    if (!allowCallback(clientIp(request))) {
      return NextResponse.json(
        { ok: false, error: { code: "RATE_LIMITED", message: "Too many callbacks; slow down" } },
        { status: 429, headers: { "Retry-After": "10" } },
      );
    }

    const provider = SLUGS[params.provider?.toLowerCase() ?? ""];
    if (!provider) return acknowledged("unknown provider");

    const adapter = providerFor(provider);
    if (!adapter) return acknowledged("no adapter");

    // The raw text, not the parsed object: signatures are computed over the
    // exact bytes, and re-serialising JSON changes them.
    const raw = await request.text();

    try {
      return await handleCallback(provider, adapter, raw, request);
    } catch (error) {
      console.error(`[payments] callback for ${provider} failed:`, error);
      return acknowledged("internal error");
    }
  },
);

async function handleCallback(
  provider: PaymentProviderName,
  adapter: PaymentProvider,
  raw: string,
  request: Request,
) {
  let body: unknown = null;
  try {
    body = JSON.parse(raw);
  } catch {
    return acknowledged("unparseable body");
  }

  // Paystack sends every event on the account — transfers, subscriptions,
  // customer updates. Only the charge and refund events concern a collection.
  const paystackKind = provider === "PAYSTACK" ? paystackEventKind(body) : null;
  if (provider === "PAYSTACK" && !paystackKind) return acknowledged("event not handled");

  // The intent is resolved *before* the signature is checked, and that
  // ordering is forced by per-company credentials: the secret to verify
  // against belongs to whichever company owns this collection, and the only
  // thing identifying that company is the reference in the body. Reading a
  // row is harmless; nothing is settled until the signature passes below.
  const providerRef = referenceFromCallback(provider, body);
  if (!providerRef) return acknowledged("no reference");

  const daraja = provider === "MPESA_DARAJA" ? parseDarajaCallback(body) : null;
  const intent = await intentForCallback(provider, providerRef, daraja);
  if (!intent) return acknowledged("unknown reference");

  const creds = await resolveCredentials(intent.companyId, provider);

  if (!adapter.verifyWebhook(raw, request.headers, creds ?? undefined)) {
    await audit({
      companyId: intent.companyId,
      action: "PAYMENT_FAILED",
      entity: "PaymentIntent",
      entityId: intent.id,
      changes: { provider, reason: "callback signature rejected" },
      request,
    });
    // 401 rather than 200: this one is hostile, and a retry will not fix it.
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  // What the callback *claims*. settleIntent compares these against the
  // provider's own answer; none of them is acted on alone.
  let hint: SettleHint | undefined;
  let recheckSettled = false;
  if (daraja) {
    hint = { resultCode: daraja.resultCode, amountCents: daraja.amountCents, receiptRef: daraja.receiptRef };
  } else if (provider === "PAYSTACK") {
    const data = (body as { data?: { amount?: number; currency?: string; status?: string } }).data ?? {};
    if (paystackKind === "charge.success") {
      hint = { resultCode: "0", amountCents: typeof data.amount === "number" ? data.amount : undefined };
    } else if (paystackKind === "refund") {
      // A refund on a charge we booked: re-ask Paystack about the charge.
      recheckSettled = true;
    }
  }

  // Confirms with the provider before booking anything.
  const settled = await settleIntent(intent.id, { hint, recheckSettled });

  await audit({
    companyId: settled.companyId,
    action: settled.status === "SUCCEEDED" ? "PAYMENT_SETTLED" : settled.status === "FAILED" ? "PAYMENT_FAILED" : "UPDATE",
    entity: "PaymentIntent",
    entityId: settled.id,
    changes: {
      provider,
      trigger: "callback",
      event: paystackKind ?? daraja?.resultCode ?? null,
      status: settled.status,
      amountCents: settled.amountCents,
      paymentId: settled.paymentId,
      receiptRef: settled.receiptRef,
      failureReason: settled.failureReason,
    },
    request,
  });

  return acknowledged();
}

function clientIp(request: Request): string {
  const fwd = request.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return request.headers.get("x-real-ip") ?? "unknown";
}
