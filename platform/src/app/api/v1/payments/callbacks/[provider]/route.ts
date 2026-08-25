import { NextResponse } from "next/server";

import { handler } from "@/lib/api";
import { audit } from "@/lib/audit";
import { providerFor, type PaymentProviderName } from "@/lib/payments";
import {
  intentForCallback,
  referenceFromCallback,
  settleIntent,
} from "@/server/collections";
import { resolveCredentials } from "@/server/credentials";

export const dynamic = "force-dynamic";

const SLUGS: Record<string, PaymentProviderName> = {
  paystack: "PAYSTACK",
  mpesa_daraja: "MPESA_DARAJA",
  kcb_buni: "KCB_BUNI",
};

/**
 * Gateway callbacks.
 *
 * Public by necessity — the provider has no session — which makes three things
 * non-negotiable:
 *
 *   1. **The body is never believed.** It identifies *which* collection changed;
 *      whether money moved is decided by `settleIntent`, which asks the provider
 *      directly. A forged callback therefore cannot conjure a payment: at worst
 *      it triggers a verification that returns PENDING.
 *   2. **Signatures are checked where the provider offers them.** Paystack signs
 *      with HMAC-SHA512, KCB with a shared secret when configured. Daraja does
 *      not sign at all, which is precisely why rule 1 exists.
 *   3. **Always 200.** Paystack and Daraja retry on any non-2xx, so returning an
 *      error for an unknown reference earns an escalating retry storm for a
 *      callback we were never going to act on.
 */
export const POST = handler<{ provider: string }>(
  { public: true },
  async ({ request, params }) => {
    const provider = SLUGS[params.provider?.toLowerCase() ?? ""];
    if (!provider) return NextResponse.json({ ok: true, ignored: "unknown provider" });

    const adapter = providerFor(provider);
    if (!adapter) return NextResponse.json({ ok: true, ignored: "no adapter" });

    // The raw text, not the parsed object: signatures are computed over the
    // exact bytes, and re-serialising JSON changes them.
    const raw = await request.text();

    let body: unknown = null;
    try {
      body = JSON.parse(raw);
    } catch {
      return NextResponse.json({ ok: true, ignored: "unparseable body" });
    }

    // The intent is resolved *before* the signature is checked, and that
    // ordering is forced by per-company credentials: the secret to verify
    // against belongs to whichever company owns this collection, and the only
    // thing identifying that company is the reference in the body. Reading a
    // row is harmless; nothing is settled until the signature passes below.
    const providerRef = referenceFromCallback(provider, body);
    if (!providerRef) return NextResponse.json({ ok: true, ignored: "no reference" });

    const intent = await intentForCallback(provider, providerRef);
    if (!intent) return NextResponse.json({ ok: true, ignored: "unknown reference" });

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

    // Confirms with the provider before booking anything.
    const settled = await settleIntent(intent.id);

    await audit({
      companyId: settled.companyId,
      action: settled.status === "SUCCEEDED" ? "PAYMENT_SETTLED" : "PAYMENT_FAILED",
      entity: "PaymentIntent",
      entityId: settled.id,
      changes: {
        provider,
        status: settled.status,
        amountCents: settled.amountCents,
        paymentId: settled.paymentId,
        failureReason: settled.failureReason,
      },
      request,
    });

    return NextResponse.json({ ok: true });
  },
);
