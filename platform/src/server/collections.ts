import "server-only";

import { ApiError } from "@/lib/api";
import { db } from "@/lib/db";
import { resolveCredentials } from "./credentials";
import {
  PAYMENT_PROVIDERS,
  providerFor,
  type PaymentProviderName,
  type VerifyResult,
} from "@/lib/payments";

import { recordPayment } from "./sales";

/**
 * Gateway collections: turning a payment intent into money in the ledger.
 *
 * The rule this file exists to enforce is that **only the provider decides
 * whether money moved**. Nothing here books a Payment because a client, a rep,
 * or even a callback body said so — every success path ends in an explicit
 * `verify()` call back to the gateway. A callback is treated as a nudge that
 * something changed, never as the fact itself.
 *
 * Settlement is idempotent on the provider's own reference, because callbacks
 * arrive more than once: Paystack retries on non-2xx, Daraja retries, and a rep
 * on a slow connection will poll the same intent repeatedly.
 */

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

export async function initiateCollection(input: InitiateCollectionInput) {
  if (input.amountCents <= 0) {
    throw new ApiError(422, "INVALID_AMOUNT", "Amount must be greater than zero");
  }

  const adapter = providerFor(input.provider);
  if (!adapter) {
    throw new ApiError(422, "UNKNOWN_PROVIDER", `Unknown payment provider: ${input.provider}`);
  }

  // This company's own credentials, falling back to the platform's.
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
  // the same contract the offline outbox relies on everywhere else.
  if (input.clientUuid) {
    const existing = await db.paymentIntent.findUnique({
      where: { clientUuid: input.clientUuid },
    });
    if (existing) return existing;
  }

  const customer = await db.customer.findFirst({
    where: { id: input.customerId, companyId: input.companyId },
    select: { id: true, name: true, phone: true, email: true },
  });
  if (!customer) throw new ApiError(404, "NOT_FOUND", "Customer not found");

  const intent = await db.paymentIntent.create({
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

  const result = await adapter.initiate(
    {
      amountCents: intent.amountCents,
      currency: intent.currency,
      reference: intent.id,
      payerPhone: intent.payerPhone,
      payerEmail: intent.payerEmail,
      description: `Payment from ${customer.name}`.slice(0, 60),
      callbackUrl: `${input.baseUrl}/api/v1/payments/callbacks/${input.provider.toLowerCase()}`,
    },
    creds ?? undefined,
  );

  return db.paymentIntent.update({
    where: { id: intent.id },
    data: result.ok
      ? { status: "PROCESSING", providerRef: result.providerRef ?? null }
      : { status: "FAILED", failureReason: result.error ?? "Could not start the payment" },
  });
}

/** How long a claim may sit in SETTLING before it is presumed abandoned. */
const STALE_CLAIM_MS = 2 * 60_000;

/** The Payment.clientUuid an intent's payment is booked under. */
export const intentClientUuid = (intentId: string) => `intent:${intentId}`;

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
 */
export async function settleIntent(intentId: string, opts: SettleOptions = {}) {
  const intent = await db.paymentIntent.findUnique({ where: { id: intentId } });
  if (!intent) throw new ApiError(404, "NOT_FOUND", "Payment intent not found");

  if (intent.status === "SUCCEEDED" || intent.status === "FAILED") return intent;
  if (!intent.providerRef) return intent;

  if (intent.status === "SETTLING") {
    // Another request holds the claim, or a crashed one abandoned it. The link
    // is written with the payment, so a booked payment under this intent's
    // uuid with the intent still SETTLING should not occur — repair it anyway
    // rather than assume.
    const booked = await db.payment.findUnique({
      where: { clientUuid: intentClientUuid(intent.id) },
      select: { id: true },
    });
    if (booked) {
      return db.paymentIntent.update({
        where: { id: intent.id },
        data: { status: "SUCCEEDED", paymentId: booked.id, completedAt: new Date() },
      });
    }
    if (Date.now() - intent.updatedAt.getTime() < STALE_CLAIM_MS) return intent;
    // Stale: fall through and compete for the claim like any other caller.
  }

  const adapter = providerFor(intent.provider);
  if (!adapter && !opts.verify) return intent;

  const verdict = opts.verify
    ? await opts.verify({
        provider: intent.provider,
        providerRef: intent.providerRef,
        companyId: intent.companyId,
      })
    : await adapter!.verify(
        intent.providerRef,
        (await resolveCredentials(intent.companyId, intent.provider as never)) ?? undefined,
      );
  const raw = verdict.raw == null ? null : JSON.stringify(verdict.raw).slice(0, 8000);

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

  // Succeeded. Claim the intent before booking anything: exactly one caller
  // moves it to SETTLING, everyone else returns what they find.
  const claimed = await db.paymentIntent.updateMany({
    where: {
      id: intent.id,
      OR: [
        { status: { in: ["PENDING", "PROCESSING"] } },
        { status: "SETTLING", updatedAt: { lt: new Date(Date.now() - STALE_CLAIM_MS) } },
      ],
    },
    data: { status: "SETTLING" },
  });
  if (claimed.count !== 1) {
    return db.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } });
  }

  // The provider is authoritative on the amount too: if it reports a different
  // figure from what we asked for — a partial payment, or a customer editing
  // the amount at the till — the ledger records what actually arrived.
  const settledCents = verdict.amountCents ?? intent.amountCents;

  const method =
    PAYMENT_PROVIDERS.find((p) => p.name === intent.provider)?.method ?? "MPESA";

  const link = {
    status: "SUCCEEDED",
    receiptRef: verdict.receiptRef ?? null,
    providerPayload: raw,
    completedAt: new Date(),
  };

  try {
    await recordPayment({
      companyId: intent.companyId,
      customerId: intent.customerId,
      amountCents: settledCents,
      method,
      reference: verdict.receiptRef ?? intent.providerRef,
      visitId: intent.visitId ?? undefined,
      createdById: intent.createdById ?? undefined,
      // The backstop: Payment.clientUuid is unique, so a second booking for
      // this intent is refused by the database whatever else goes wrong.
      clientUuid: intentClientUuid(intent.id),
      note:
        settledCents === intent.amountCents
          ? undefined
          : `Requested ${intent.amountCents / 100}, settled ${settledCents / 100}`,
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
    const booked = await db.payment.findUnique({
      where: { clientUuid: intentClientUuid(intent.id) },
      select: { id: true },
    });
    if (booked) {
      return db.paymentIntent.update({
        where: { id: intent.id },
        data: { ...link, paymentId: booked.id },
      });
    }
    // Release the claim so the next poll or callback can try again.
    await db.paymentIntent.updateMany({
      where: { id: intent.id, status: "SETTLING" },
      data: { status: "PROCESSING" },
    });
    throw error;
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
        return (data?.reference as string) ?? null;
      }
      case "MPESA_DARAJA": {
        const cb = (b?.Body as Record<string, unknown>)?.stkCallback as
          | Record<string, unknown>
          | undefined;
        return (cb?.CheckoutRequestID as string) ?? null;
      }
      case "KCB_BUNI":
        return (b?.transactionId as string) ?? (b?.transactionID as string) ?? null;
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/** Finds the intent a callback belongs to, scoped by provider. */
export async function intentForCallback(
  provider: PaymentProviderName,
  providerRef: string,
) {
  return db.paymentIntent.findFirst({ where: { provider, providerRef } });
}
