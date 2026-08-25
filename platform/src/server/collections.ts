import "server-only";

import { ApiError } from "@/lib/api";
import { db } from "@/lib/db";
import { resolveCredentials } from "./credentials";
import {
  PAYMENT_PROVIDERS,
  providerFor,
  type PaymentProviderName,
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

/**
 * Asks the provider what happened, and books the money if it succeeded.
 *
 * Safe to call repeatedly — from polling, from a callback, or from both at once.
 * A terminal intent short-circuits, and settlement runs inside a check that the
 * intent is still unsettled, so a duplicate callback cannot create a second
 * Payment for the same collection.
 */
export async function settleIntent(intentId: string) {
  const intent = await db.paymentIntent.findUnique({ where: { id: intentId } });
  if (!intent) throw new ApiError(404, "NOT_FOUND", "Payment intent not found");

  if (intent.status === "SUCCEEDED" || intent.status === "FAILED") return intent;
  if (!intent.providerRef) return intent;

  const adapter = providerFor(intent.provider);
  if (!adapter) return intent;

  const creds = await resolveCredentials(intent.companyId, intent.provider as never);
  const verdict = await adapter.verify(intent.providerRef, creds ?? undefined);
  const raw = verdict.raw == null ? null : JSON.stringify(verdict.raw).slice(0, 8000);

  if (verdict.status === "PENDING") {
    return db.paymentIntent.update({
      where: { id: intent.id },
      data: { providerPayload: raw },
    });
  }

  if (verdict.status === "FAILED") {
    return db.paymentIntent.update({
      where: { id: intent.id },
      data: {
        status: "FAILED",
        failureReason: verdict.failureReason ?? "The payment did not complete",
        providerPayload: raw,
        completedAt: new Date(),
      },
    });
  }

  // Succeeded. Book it, then attach the Payment to the intent.
  //
  // The provider is authoritative on the amount too: if it reports a different
  // figure from what we asked for — a partial payment, or a customer editing
  // the amount at the till — the ledger records what actually arrived.
  const settledCents = verdict.amountCents ?? intent.amountCents;

  const method =
    PAYMENT_PROVIDERS.find((p) => p.name === intent.provider)?.method ?? "MPESA";

  const { payment } = await recordPayment({
    companyId: intent.companyId,
    customerId: intent.customerId,
    amountCents: settledCents,
    method,
    reference: verdict.receiptRef ?? intent.providerRef,
    visitId: intent.visitId ?? undefined,
    createdById: intent.createdById ?? undefined,
    note:
      settledCents === intent.amountCents
        ? undefined
        : `Requested ${intent.amountCents / 100}, settled ${settledCents / 100}`,
  });

  return db.paymentIntent.update({
    where: { id: intent.id },
    data: {
      status: "SUCCEEDED",
      receiptRef: verdict.receiptRef ?? null,
      providerPayload: raw,
      paymentId: payment.id,
      completedAt: new Date(),
    },
  });
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
