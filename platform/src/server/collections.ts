import "server-only";

import { Prisma, type PaymentIntent } from "@prisma/client";

import { ApiError } from "@/lib/api";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import {
  PAYMENT_PROVIDERS,
  ProviderTransportError,
  providerFor,
  toDarajaMsisdn,
  type DarajaCallback,
  type PaymentProviderName,
  type VerifyResult,
} from "@/lib/payments";

import { resolveCredentials } from "./credentials";
import { notifyPayment, recordPayment } from "./sales";

/**
 * Gateway collections: turning a payment intent into money in the ledger.
 *
 * The rule this file exists to enforce is that **only the provider decides
 * whether money moved**. Nothing here books a Payment because a client, a rep,
 * or even a callback body said so — every success path ends in an explicit
 * `verify()` call back to the gateway. A callback is treated as a nudge that
 * something changed, never as the fact itself. The one thing a callback *is*
 * believed about is the receipt number, and only after verify has agreed the
 * money moved, because Daraja's query endpoint never returns it.
 *
 * Settlement is idempotent on the provider's own reference, because callbacks
 * arrive more than once: Paystack retries on non-2xx, Daraja retries, and a rep
 * on a slow connection will poll the same intent repeatedly.
 */

/** How long a collection may wait for the provider before it is given up on. */
export const INTENT_TTL_MS = 24 * 3600_000;

/** A PROCESSING intent younger than this is left to polling and callbacks. */
export const RECHECK_AFTER_MS = 2 * 60_000;

/** How long a claim may sit in SETTLING before it is presumed abandoned. */
const STALE_CLAIM_MS = 2 * 60_000;

/**
 * providerRef prefix for an intent whose initiate call *may* have reached the
 * provider but whose answer never reached us. The provider's handle is unknown;
 * reconciliation looks the collection up by our own reference where the
 * provider allows it (Paystack), or adopts the handle from the callback when
 * one arrives (Daraja). It is never settled on a guess.
 */
export const LOOKUP_PREFIX = "lookup:";
export const isLookupRef = (ref: string | null | undefined) => Boolean(ref && ref.startsWith(LOOKUP_PREFIX));

/** The Payment.clientUuid an intent's payment is booked under. */
export const intentClientUuid = (intentId: string) => `intent:${intentId}`;

/**
 * What a client may see of an intent. `providerPayload` (raw provider bodies)
 * and `companyId` never leave the server: the first is dispute evidence that
 * can carry a payer's details, the second is tenancy plumbing.
 */
export interface PublicIntent {
  id: string;
  status: string;
  provider: string;
  amountCents: number;
  currency: string;
  receiptRef: string | null;
  failureReason: string | null;
  redirectUrl: string | null;
  paymentId: string | null;
  createdAt: string;
  completedAt: string | null;
}

export function toPublicIntent(intent: PaymentIntent): PublicIntent {
  return {
    id: intent.id,
    status: intent.status,
    provider: intent.provider,
    amountCents: intent.amountCents,
    currency: intent.currency,
    receiptRef: intent.receiptRef,
    failureReason: intent.failureReason,
    redirectUrl: intent.redirectUrl,
    paymentId: intent.paymentId,
    createdAt: intent.createdAt.toISOString(),
    completedAt: intent.completedAt ? intent.completedAt.toISOString() : null,
  };
}

export interface InitiateCollectionInput {
  companyId: string;
  customerId: string;
  provider: PaymentProviderName;
  amountCents: number;
  payerPhone?: string | null;
  payerEmail?: string | null;
  visitId?: string | null;
  clientUuid?: string | null;
  createdById?: string | null;
  /** Absolute base URL of this deployment, for the provider callback. */
  baseUrl: string;
}

export async function initiateCollection(input: InitiateCollectionInput): Promise<PaymentIntent> {
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    throw new ApiError(422, "INVALID_AMOUNT", "Amount must be a positive whole number of cents");
  }

  const adapter = providerFor(input.provider);
  const meta = PAYMENT_PROVIDERS.find((p) => p.name === input.provider);
  if (!adapter || !meta) {
    throw new ApiError(422, "UNKNOWN_PROVIDER", `Unknown payment provider: ${input.provider}`);
  }

  // Daraja and Buni take whole shillings and silently truncate the rest. The
  // amount is refused here rather than rounded: a till that asks for 1,250.50
  // and collects 1,250 has under-collected without anyone noticing.
  if (meta.wholeUnits && input.amountCents % 100 !== 0) {
    throw new ApiError(
      422,
      "AMOUNT_NOT_WHOLE",
      `${meta.label} takes whole shillings only. Round ${(input.amountCents / 100).toFixed(2)} to a whole amount.`,
    );
  }

  // This company's own credentials, or the platform's — never a mix.
  const creds = await resolveCredentials(input.companyId, input.provider);

  // A missing credential is a configuration problem, not a server fault.
  // Returning 500 "something went wrong" sends an admin hunting through logs
  // for a bug that does not exist, so it says plainly what is absent.
  if (!adapter.configured(creds ?? undefined)) {
    throw new ApiError(
      503,
      "PROVIDER_NOT_CONFIGURED",
      `${input.provider} is not configured for this company yet. Add its credentials in Settings → Payments.`,
      { provider: input.provider },
    );
  }

  // Replaying the same client UUID must not charge the customer twice. This is
  // the same contract the offline outbox relies on everywhere else. Scoped to
  // the company: a uuid is client-generated input, and another tenant's
  // collection must be indistinguishable from none.
  if (input.clientUuid) {
    const existing = await db.paymentIntent.findFirst({
      where: { clientUuid: input.clientUuid, companyId: input.companyId },
    });
    if (existing) return existing;
  }

  const customer = await db.customer.findFirst({
    where: { id: input.customerId, companyId: input.companyId },
    select: { id: true, name: true, phone: true, email: true },
  });
  if (!customer) throw new ApiError(404, "NOT_FOUND", "Customer not found");

  let intent: PaymentIntent;
  try {
    intent = await db.paymentIntent.create({
      data: {
        companyId: input.companyId,
        customerId: customer.id,
        visitId: input.visitId ?? null,
        provider: input.provider,
        amountCents: input.amountCents,
        payerPhone: input.payerPhone ?? customer.phone ?? null,
        payerEmail: input.payerEmail ?? customer.email ?? null,
        status: "PENDING",
        clientUuid: input.clientUuid ?? null,
        createdById: input.createdById ?? null,
      },
    });
  } catch (error) {
    // The uuid exists under another company. Say "conflict", not whose.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new ApiError(409, "CONFLICT", "This client reference has already been used");
    }
    throw error;
  }

  const slug = input.provider.toLowerCase();
  const initiateInput = {
    amountCents: intent.amountCents,
    currency: intent.currency,
    reference: intent.id,
    payerPhone: intent.payerPhone,
    payerEmail: intent.payerEmail,
    description: `Payment from ${customer.name}`.slice(0, 60),
    callbackUrl: `${input.baseUrl}/api/v1/payments/callbacks/${slug}`,
    returnUrl: `${input.baseUrl}/api/v1/payments/return/${slug}?reference=${encodeURIComponent(intent.id)}`,
  };

  // Between here and the update below the request to the provider is in
  // flight. Whatever goes wrong, the intent must not be left PENDING with no
  // handle: that row would never settle, while the STK prompt it caused may
  // well be on the customer's phone. So: a provider the adapter *knows* it
  // never reached fails the intent outright; anything else — a timeout, a
  // reset after the bytes left, an unexpected throw — moves it to PROCESSING
  // under a lookup key and leaves reconciliation to find out what happened.
  let outcome: Prisma.PaymentIntentUpdateInput;
  try {
    const result = await adapter.initiate(initiateInput, creds ?? undefined);
    outcome = result.ok
      ? {
          status: "PROCESSING",
          providerRef: result.providerRef ?? `${LOOKUP_PREFIX}${intent.id}`,
          redirectUrl: result.redirectUrl ?? null,
        }
      : { status: "FAILED", failureReason: result.error ?? "Could not start the payment", completedAt: new Date() };
  } catch (error) {
    const sent = error instanceof ProviderTransportError ? error.sent : true;
    const message = error instanceof Error ? error.message : String(error);
    if (!sent) {
      outcome = {
        status: "FAILED",
        failureReason: `provider unreachable: ${message}`.slice(0, 300),
        completedAt: new Date(),
      };
    } else {
      console.warn(`[payments] initiate ${intent.id} lost its answer from ${input.provider}: ${message}`);
      outcome = {
        status: "PROCESSING",
        providerRef: `${LOOKUP_PREFIX}${intent.id}`,
        providerPayload: JSON.stringify({ transport: message }).slice(0, 2000),
      };
    }
  }

  // Conditional: while the request was in flight the provider's callback may
  // already have arrived and been adopted onto this row (see
  // `intentForCallback`), and may even have settled it. A handle or verdict
  // the provider delivered wins over anything we would write here.
  await db.paymentIntent.updateMany({
    where: { id: intent.id, status: "PENDING", providerRef: null },
    data: outcome,
  });
  return db.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } });
}

/** What a callback is allowed to tell us — hints, confirmed by verify. */
export interface SettleHint {
  /** Provider result code as the callback reported it ("0" = success). */
  resultCode?: string;
  /** Amount the callback says was paid, in cents. Compared, never trusted alone. */
  amountCents?: number;
  /** The provider's receipt number (M-Pesa confirmation code). */
  receiptRef?: string;
}

export interface SettleOptions {
  /**
   * Replaces the provider round trip. Tests use it to script a verdict; nothing
   * in production passes it, so the gateway stays the only source of truth.
   */
  verify?: (intent: {
    provider: string;
    providerRef: string;
    companyId: string;
  }) => Promise<VerifyResult>;
  /** Fields the triggering callback carried. */
  hint?: SettleHint;
  /**
   * Re-ask the provider about an intent that already SUCCEEDED, to catch a
   * reversal. Set by a Paystack refund/reversal event and the console's
   * manual re-check; never by ordinary polling.
   */
  recheckSettled?: boolean;
}

/**
 * Asks the provider what happened, and books the money if it succeeded.
 *
 * Safe to call repeatedly — from polling, from a callback, or from both at once.
 * A terminal intent short-circuits. Booking is guarded three ways, because the
 * callback and the poll routinely arrive within milliseconds of each other and
 * both see a PROCESSING intent and a SUCCEEDED verdict:
 *
 *   1. The intent is **claimed first** with a conditional update
 *      (PROCESSING → SETTLING, exactly one row). The loser of the race sees
 *      zero rows and returns the intent as it stands.
 *   2. The Payment is booked under a clientUuid derived from the intent id,
 *      so `Payment.clientUuid @unique` refuses a second booking even if the
 *      claim were somehow bypassed.
 *   3. The intent → payment link is written **inside the payment's own
 *      transaction**, so there is no moment at which a Payment exists that the
 *      intent does not point at. A crash cannot leave the two half-joined.
 *
 * A failed booking releases the claim so the next poll can try again; a claim
 * left behind by a crashed process is re-taken once it is stale.
 *
 * Two deliberate exceptions to "terminal means final":
 *
 *   - A FAILED intent whose callback now says success (Daraja has been seen
 *     to answer a query with a timeout and deliver a success callback minutes
 *     later) is re-verified, within the intent's 24-hour life.
 *   - A SUCCEEDED intent is re-verified only when asked (`recheckSettled`);
 *     a REVERSED verdict then marks it REVERSED and writes an audit entry.
 *     The ledger is **not** touched — a refund is a bookkeeping decision a
 *     person makes with the evidence on the Collections page.
 */
export async function settleIntent(intentId: string, opts: SettleOptions = {}): Promise<PaymentIntent> {
  const intent = await db.paymentIntent.findUnique({ where: { id: intentId } });
  if (!intent) throw new ApiError(404, "NOT_FOUND", "Payment intent not found");

  const hint = opts.hint ?? {};
  const now = Date.now();

  if (intent.status === "EXPIRED" || intent.status === "CANCELLED" || intent.status === "REVERSED") return intent;

  if (intent.status === "SUCCEEDED") {
    // The receipt usually arrives *after* a poll has already settled the
    // intent, because Daraja's query has no receipt field. Keep it, once.
    if (hint.receiptRef && !intent.receiptRef && hint.resultCode === "0") {
      await persistReceipt(intent, hint.receiptRef);
    }
    if (!opts.recheckSettled) return db.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } });
  }

  const lateSuccess =
    intent.status === "FAILED" &&
    hint.resultCode === "0" &&
    (intent.completedAt ?? intent.updatedAt).getTime() > now - INTENT_TTL_MS;
  if (intent.status === "FAILED" && !lateSuccess) return intent;

  if (!intent.providerRef) return intent;

  if (intent.status === "SETTLING") {
    // Another request holds the claim, or a crashed one abandoned it. The link
    // is written with the payment, so a booked payment under this intent's
    // uuid with the intent still SETTLING should not occur — repair it anyway
    // rather than assume.
    const booked = await db.payment.findUnique({
      where: { clientUuid: intentClientUuid(intent.id) },
      select: { id: true, reference: true },
    });
    if (booked) {
      return db.paymentIntent.update({
        where: { id: intent.id },
        data: { status: "SUCCEEDED", paymentId: booked.id, receiptRef: intent.receiptRef ?? booked.reference, completedAt: new Date() },
      });
    }
    if (now - intent.updatedAt.getTime() < STALE_CLAIM_MS) {
      // The callback carrying the receipt has arrived while a poll is mid-way
      // through booking. The receipt must not be lost with it: pin it on the
      // row now; the booking keeps whatever receipt is already there.
      if (hint.receiptRef && hint.resultCode === "0" && !intent.receiptRef) {
        await db.paymentIntent.updateMany({ where: { id: intent.id, receiptRef: null }, data: { receiptRef: hint.receiptRef } });
        // If the booking has just committed, its payment carries the
        // provider's handle as reference; give it the receipt too.
        await alignPaymentReference(intent.id);
      }
      return intent;
    }
    // Stale: fall through and compete for the claim like any other caller.
  }

  const adapter = providerFor(intent.provider);
  if (!adapter && !opts.verify) return intent;

  let verdict: VerifyResult;
  if (opts.verify) {
    verdict = await opts.verify({ provider: intent.provider, providerRef: intent.providerRef, companyId: intent.companyId });
  } else {
    const creds = (await resolveCredentials(intent.companyId, intent.provider as PaymentProviderName)) ?? undefined;
    if (isLookupRef(intent.providerRef)) {
      // The provider's handle never reached us. Only a provider that keys on
      // *our* reference can be asked; the rest wait for a callback or expiry.
      if (!adapter!.verifyByReference) return intent;
      verdict = await adapter!.verifyByReference(intent.id, creds);
    } else {
      verdict = await adapter!.verify(intent.providerRef, creds);
    }
  }
  const raw = verdict.raw == null ? null : JSON.stringify(verdict.raw).slice(0, 8000);

  // Our credentials were refused. That says nothing about the transaction, so
  // the intent is left exactly as it is for the next attempt.
  if (verdict.authError) {
    console.warn(`[payments] ${intent.provider} refused credentials while verifying ${intent.id}: ${verdict.failureReason ?? verdict.code}`);
    return intent;
  }

  if (verdict.status === "REVERSED") {
    if (intent.status === "SUCCEEDED") return markReversed(intent, verdict, raw);
    await db.paymentIntent.updateMany({
      where: { id: intent.id, status: { in: ["PENDING", "PROCESSING", "SETTLING"] } },
      data: { status: "FAILED", failureReason: verdict.failureReason ?? "Reversed by the provider", providerPayload: raw, completedAt: new Date() },
    });
    return db.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } });
  }

  if (intent.status === "SUCCEEDED") {
    // A re-check that found nothing new. Nothing to write.
    return intent;
  }

  if (verdict.status === "PENDING") {
    // Only while still live: a verdict that raced a successful settlement must
    // not overwrite the receipt's payload.
    await db.paymentIntent.updateMany({
      where: { id: intent.id, status: { in: ["PENDING", "PROCESSING"] } },
      data: { providerPayload: raw },
    });
    return db.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } });
  }

  if (verdict.status === "FAILED") {
    await db.paymentIntent.updateMany({
      where: { id: intent.id, status: { in: ["PENDING", "PROCESSING", "SETTLING"] } },
      data: {
        status: "FAILED",
        failureReason: verdict.failureReason ?? "The payment did not complete",
        providerPayload: raw,
        completedAt: new Date(),
      },
    });
    return db.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } });
  }

  // Succeeded, says the provider. Before anything is booked, the amount the
  // provider (or, failing that, the callback) reports must be the amount we
  // asked for. A customer who edits the figure at the till, a partial payment,
  // or a forged callback carrying a different sum must not become a Payment
  // for a figure nobody agreed to. Daraja's query carries no amount, so the
  // callback's figure is what gets compared there.
  const reported = verdict.amountCents ?? hint.amountCents;
  const currencyMismatch = verdict.currency && verdict.currency !== intent.currency;
  if ((reported != null && reported !== intent.amountCents) || currencyMismatch) {
    const reason = currencyMismatch
      ? `amount mismatch: paid in ${verdict.currency}, expected ${intent.currency}`
      : `amount mismatch: provider reports ${(reported! / 100).toFixed(2)}, intent is ${(intent.amountCents / 100).toFixed(2)}`;
    await db.paymentIntent.updateMany({
      where: { id: intent.id, status: { in: ["PENDING", "PROCESSING", "SETTLING", "FAILED"] } },
      data: { status: "FAILED", failureReason: reason, providerPayload: raw, completedAt: new Date() },
    });
    await audit({
      companyId: intent.companyId,
      action: "PAYMENT_FAILED",
      entity: "PaymentIntent",
      entityId: intent.id,
      changes: {
        reason: "amount mismatch",
        expectedCents: intent.amountCents,
        reportedCents: reported ?? null,
        expectedCurrency: intent.currency,
        reportedCurrency: verdict.currency ?? null,
        receiptRef: verdict.receiptRef ?? hint.receiptRef ?? null,
      },
    });
    return db.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } });
  }

  // Claim the intent before booking anything: exactly one caller moves it to
  // SETTLING, everyone else returns what they find.
  const claimed = await db.paymentIntent.updateMany({
    where: {
      id: intent.id,
      OR: [
        { status: { in: ["PENDING", "PROCESSING"] } },
        { status: "SETTLING", updatedAt: { lt: new Date(now - STALE_CLAIM_MS) } },
        ...(lateSuccess ? [{ status: "FAILED" }] : []),
      ],
    },
    data: { status: "SETTLING" },
  });
  if (claimed.count !== 1) {
    return db.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } });
  }

  const method = PAYMENT_PROVIDERS.find((p) => p.name === intent.provider)?.method ?? "MPESA_STK";
  const receiptRef = verdict.receiptRef ?? hint.receiptRef ?? null;

  const link = {
    status: "SUCCEEDED",
    // undefined, not null, when unknown: a receipt a callback pinned on the
    // row while this booking was in progress must survive it.
    receiptRef: receiptRef ?? undefined,
    providerPayload: raw,
    failureReason: null,
    completedAt: new Date(),
  };

  let booked: { customer: { id: string; name: string; phone: string | null; balanceCents: number }; payment: { amountCents: number } };
  try {
    booked = await recordPayment({
      companyId: intent.companyId,
      customerId: intent.customerId,
      amountCents: intent.amountCents,
      method,
      // The receipt is what the customer can quote back; the provider's
      // handle is the fallback when a receipt never arrives.
      reference: receiptRef ?? (isLookupRef(intent.providerRef) ? intent.id : intent.providerRef),
      visitId: intent.visitId ?? undefined,
      createdById: intent.createdById ?? undefined,
      // The backstop: Payment.clientUuid is unique, so a second booking for
      // this intent is refused by the database whatever else goes wrong.
      clientUuid: intentClientUuid(intent.id),
      // Same transaction as the Payment: the intent cannot be SUCCEEDED without
      // its payment, nor the payment exist without the intent pointing at it.
      inTransaction: async (tx, payment) => {
        await tx.paymentIntent.update({
          where: { id: intent.id },
          data: { ...link, paymentId: payment.id },
        });
      },
    });
  } catch (error) {
    // Was the money already booked for this intent after all? Then the unique
    // clientUuid did its job: link it and finish rather than fail.
    const existing = await db.payment.findUnique({
      where: { clientUuid: intentClientUuid(intent.id) },
      select: { id: true },
    });
    if (existing) {
      return db.paymentIntent.update({
        where: { id: intent.id },
        data: { ...link, paymentId: existing.id },
      });
    }
    // Release the claim so the next poll or callback can try again.
    await db.paymentIntent.updateMany({
      where: { id: intent.id, status: "SETTLING" },
      data: { status: lateSuccess ? "FAILED" : "PROCESSING" },
    });
    throw error;
  }

  // A receipt that arrived during the booking is on the intent but not yet on
  // the payment, which was written with the provider's handle. Align them.
  await alignPaymentReference(intent.id);

  // The receipt SMS, after the transaction and never fatal: the money is in
  // the ledger whether or not the SMS provider is awake.
  try {
    await notifyPayment({
      companyId: intent.companyId,
      customerId: booked.customer.id,
      amountCents: booked.payment.amountCents,
      balanceCents: booked.customer.balanceCents,
      phone: booked.customer.phone ?? intent.payerPhone,
      customerName: booked.customer.name,
    });
  } catch (error) {
    console.warn(`[payments] receipt SMS for ${intent.id} failed:`, error instanceof Error ? error.message : error);
  }

  return db.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } });
}

/** Writes a late-arriving receipt onto a settled intent and its payment. */
async function persistReceipt(intent: PaymentIntent, receiptRef: string) {
  await db.paymentIntent.updateMany({
    where: { id: intent.id, status: "SUCCEEDED", receiptRef: null },
    data: { receiptRef },
  });
  await alignPaymentReference(intent.id);
}

/**
 * Makes the booked payment's reference the intent's receipt, when the intent
 * has one and the payment was written with the provider's handle instead. The
 * receipt can arrive before, during or after the booking, from a different
 * request; whichever side finishes last calls this, so the two always meet.
 */
async function alignPaymentReference(intentId: string) {
  const current = await db.paymentIntent.findUnique({
    where: { id: intentId },
    select: { receiptRef: true, providerRef: true },
  });
  if (!current?.receiptRef) return;
  await db.payment.updateMany({
    where: {
      clientUuid: intentClientUuid(intentId),
      OR: [{ reference: null }, { reference: current.providerRef }, { reference: intentId }],
    },
    data: { reference: current.receiptRef },
  });
}

/**
 * The provider took the money back after we booked it. The intent is marked,
 * the audit trail says so, and the ledger is left for a person: an automatic
 * contra-entry would hide a chargeback behind a tidy balance.
 */
async function markReversed(intent: PaymentIntent, verdict: VerifyResult, raw: string | null) {
  const updated = await db.paymentIntent.updateMany({
    where: { id: intent.id, status: "SUCCEEDED" },
    data: {
      status: "REVERSED",
      failureReason: verdict.failureReason ?? "Reversed by the provider",
      providerPayload: raw,
    },
  });
  if (updated.count === 1) {
    await audit({
      companyId: intent.companyId,
      action: "UPDATE",
      entity: "PaymentIntent",
      entityId: intent.id,
      changes: {
        status: { from: "SUCCEEDED", to: "REVERSED" },
        paymentId: intent.paymentId,
        amountCents: intent.amountCents,
        reason: verdict.failureReason ?? "reversed by provider",
        note: "Ledger not reversed automatically — review on Finance → Collections",
      },
    });
  }
  return db.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } });
}

/**
 * Resolves the intent a provider callback refers to.
 *
 * Each gateway names the reference differently, and Daraja buries it inside a
 * nested body, so the shapes are pulled apart here rather than in the route.
 */
export function referenceFromCallback(
  provider: PaymentProviderName,
  body: unknown,
): string | null {
  const b = body as Record<string, unknown>;
  try {
    switch (provider) {
      case "PAYSTACK": {
        const data = b?.data as Record<string, unknown> | undefined;
        // Charge events carry `reference`; refund events name the charge as
        // `transaction_reference` and their own id as `reference`.
        const ref = (data?.transaction_reference as string) ?? (data?.reference as string);
        return typeof ref === "string" && ref ? ref : null;
      }
      case "MPESA_DARAJA": {
        const cb = (b?.Body as Record<string, unknown>)?.stkCallback as
          | Record<string, unknown>
          | undefined;
        const ref = cb?.CheckoutRequestID;
        return typeof ref === "string" && ref ? ref : null;
      }
      case "KCB_BUNI": {
        const ref = (b?.transactionId as string) ?? (b?.transactionID as string);
        return typeof ref === "string" && ref ? ref : null;
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/**
 * Finds the intent a callback belongs to, scoped by provider.
 *
 * Besides the exact match, two orphan shapes are adopted here — an intent
 * whose initiate answer was lost and so carries a lookup key instead of the
 * provider's handle:
 *
 *   - Paystack echoes *our* reference, so a callback naming an intent id that
 *     is still under a lookup key simply claims it.
 *   - Daraja's callback carries no AccountReference, only the phone and the
 *     amount. A lookup-keyed Daraja intent for the same phone and amount in
 *     the last 24 hours adopts the CheckoutRequestID. That is a heuristic, and
 *     it is safe *because* adoption books nothing: it only decides which
 *     intent the subsequent verify asks Daraja about, and Daraja answers for
 *     the CheckoutRequestID, not for our guess.
 */
export async function intentForCallback(
  provider: PaymentProviderName,
  providerRef: string,
  daraja?: DarajaCallback | null,
) {
  const exact = await db.paymentIntent.findFirst({ where: { provider, providerRef } });
  if (exact) return exact;

  // Two orphan shapes: the answer was lost (lookup key), or the initiate call
  // is *still in flight* — Daraja can deliver the callback before a hung push
  // request has timed out on our side. Both are adopted; the in-flight write
  // is conditional and will not overwrite what is set here.
  const orphanShape = {
    OR: [
      { status: "PROCESSING", providerRef: { startsWith: LOOKUP_PREFIX } },
      { status: "PENDING", providerRef: null },
    ],
  };
  let orphan: PaymentIntent | null = null;
  if (provider === "PAYSTACK") {
    orphan = await db.paymentIntent.findFirst({ where: { id: providerRef, provider, ...orphanShape } });
  } else if (provider === "MPESA_DARAJA" && daraja?.phone && daraja.amountCents != null) {
    const msisdn = toDarajaMsisdn(daraja.phone);
    const candidates = await db.paymentIntent.findMany({
      where: {
        provider,
        ...orphanShape,
        amountCents: daraja.amountCents,
        createdAt: { gt: new Date(Date.now() - INTENT_TTL_MS) },
      },
      orderBy: { createdAt: "asc" },
      take: 20,
    });
    orphan =
      candidates.find((c) => c.payerPhone && msisdn && toDarajaMsisdn(c.payerPhone) === msisdn) ?? null;
  }
  if (!orphan) return null;

  try {
    const adopted = await db.paymentIntent.updateMany({
      where: { id: orphan.id, providerRef: orphan.providerRef, status: orphan.status },
      data: { providerRef, status: "PROCESSING" },
    });
    if (adopted.count !== 1) return null;
  } catch (error) {
    // The handle already belongs to another intent: not ours to adopt.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return null;
    throw error;
  }
  return db.paymentIntent.findUnique({ where: { id: orphan.id } });
}

export interface ReconcileSummary {
  /** PENDING/PROCESSING intents past 24 hours, now EXPIRED. */
  expired: number;
  /** PENDING intents with no handle, moved under a lookup key. */
  orphansKeyed: number;
  /** Intents re-verified with the provider. */
  rechecked: number;
  /** …of which reached SUCCEEDED in this sweep. */
  settled: number;
  /** …of which reached FAILED in this sweep. */
  failed: number;
  /** Stale SETTLING claims handed back to the race. */
  staleClaims: number;
  errors: Array<{ intentId: string; error: string }>;
  durationMs: number;
}

/**
 * The safety net under polling and callbacks.
 *
 * Run every few minutes by the systemd timer (`POST /payments/reconcile`):
 *
 *   1. Anything still PENDING or PROCESSING after 24 hours is EXPIRED. An STK
 *      prompt lives for about a minute and a Paystack checkout for a day; past
 *      that there is nothing left to wait for.
 *   2. A PENDING intent with no provider handle — the process died between
 *      creating the row and hearing back — is moved under a lookup key so it
 *      is treated like any other lost answer.
 *   3. Every PROCESSING intent older than two minutes is re-verified. Two
 *      minutes because inside that window the rep's own polling is doing this
 *      already, and doubling it only spends the provider's rate limit.
 *   4. A SETTLING claim older than its stale window is re-run; `settleIntent`
 *      either links the payment that was booked or re-competes for the claim.
 */
export async function reconcileIntents(opts: { now?: Date; limit?: number } = {}): Promise<ReconcileSummary> {
  const started = Date.now();
  const now = opts.now ?? new Date();
  const limit = opts.limit ?? 200;
  const summary: ReconcileSummary = {
    expired: 0,
    orphansKeyed: 0,
    rechecked: 0,
    settled: 0,
    failed: 0,
    staleClaims: 0,
    errors: [],
    durationMs: 0,
  };

  const expired = await db.paymentIntent.updateMany({
    where: {
      status: { in: ["PENDING", "PROCESSING"] },
      createdAt: { lt: new Date(now.getTime() - INTENT_TTL_MS) },
    },
    data: {
      status: "EXPIRED",
      failureReason: "No confirmation from the provider within 24 hours",
      completedAt: now,
    },
  });
  summary.expired = expired.count;

  const orphans = await db.paymentIntent.findMany({
    where: { status: "PENDING", providerRef: null, createdAt: { lt: new Date(now.getTime() - RECHECK_AFTER_MS) } },
    select: { id: true },
    take: limit,
  });
  for (const o of orphans) {
    const keyed = await db.paymentIntent.updateMany({
      where: { id: o.id, status: "PENDING", providerRef: null },
      data: { status: "PROCESSING", providerRef: `${LOOKUP_PREFIX}${o.id}` },
    });
    summary.orphansKeyed += keyed.count;
  }

  const due = await db.paymentIntent.findMany({
    where: {
      OR: [
        {
          status: "PROCESSING",
          createdAt: { lt: new Date(now.getTime() - RECHECK_AFTER_MS), gte: new Date(now.getTime() - INTENT_TTL_MS) },
        },
        { status: "SETTLING", updatedAt: { lt: new Date(now.getTime() - STALE_CLAIM_MS) } },
      ],
    },
    select: { id: true, status: true },
    orderBy: { createdAt: "asc" },
    take: limit,
  });

  for (const row of due) {
    if (row.status === "SETTLING") summary.staleClaims++;
    try {
      const after = await settleIntent(row.id);
      summary.rechecked++;
      if (after.status === "SUCCEEDED") summary.settled++;
      else if (after.status === "FAILED") summary.failed++;
    } catch (error) {
      summary.errors.push({ intentId: row.id, error: error instanceof Error ? error.message : String(error) });
    }
  }

  summary.durationMs = Date.now() - started;
  return summary;
}
