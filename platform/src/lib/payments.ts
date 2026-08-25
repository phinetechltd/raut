import "server-only";

import crypto from "node:crypto";

import { normalisePhone } from "./sms";

/**
 * Payment gateways — Paystack, M-Pesa (Safaricom Daraja) and KCB Buni.
 *
 * Same shape as the SMS adapters in `sms.ts`: one interface, one adapter per
 * provider, a selector, and nothing transmitted until the attempt is persisted.
 * Credentials come from the environment and are never stored per-tenant in the
 * database, so a database dump does not leak the means to move money.
 *
 * Two properties matter more here than anywhere else in the platform:
 *
 *   **The provider is the authority on whether money moved.** A client saying
 *   "paid" means nothing. Every success path in this file runs either from a
 *   signed webhook or from an explicit verify call back to the provider.
 *
 *   **Callbacks arrive more than once.** Paystack retries, Daraja retries, and
 *   a rep hammering a slow screen retries too. Settlement is therefore keyed on
 *   the provider's own reference, which is unique per provider in the schema.
 */

export type PaymentProviderName = "PAYSTACK" | "MPESA_DARAJA" | "KCB_BUNI";

export const PAYMENT_PROVIDERS: Array<{
  name: PaymentProviderName;
  label: string;
  /** What the payer supplies for this provider. */
  needs: "phone" | "email";
  /** Maps to Payment.method once settled. */
  method: string;
}> = [
  { name: "MPESA_DARAJA", label: "M-Pesa (STK push)", needs: "phone", method: "MPESA_STK" },
  { name: "PAYSTACK", label: "Card / Paystack", needs: "email", method: "PAYSTACK" },
  { name: "KCB_BUNI", label: "KCB Buni", needs: "phone", method: "KCB_BUNI" },
];

export interface InitiateInput {
  amountCents: number;
  currency: string;
  /** Our own reference, echoed back by the provider where it supports one. */
  reference: string;
  payerPhone?: string | null;
  payerEmail?: string | null;
  description: string;
  callbackUrl: string;
}

export interface InitiateResult {
  ok: boolean;
  /** The provider's handle for this attempt. */
  providerRef?: string;
  /** Where to send the payer, for redirect-based providers like Paystack. */
  redirectUrl?: string;
  /** Provider text worth showing the rep ("Enter your PIN on your phone"). */
  message?: string;
  error?: string;
}

export interface VerifyResult {
  status: "PENDING" | "SUCCEEDED" | "FAILED";
  receiptRef?: string;
  amountCents?: number;
  failureReason?: string;
  raw?: unknown;
}

export interface PaymentProvider {
  readonly name: PaymentProviderName;
  /** True when the environment carries everything this adapter needs. */
  configured(): boolean;
  initiate(input: InitiateInput): Promise<InitiateResult>;
  /** Ask the provider directly. Used for polling and to confirm a webhook. */
  verify(providerRef: string): Promise<VerifyResult>;
  /**
   * Validates a webhook body against the provider's signature scheme.
   * Returning false must be treated as hostile, not as a transient error.
   */
  verifyWebhook(rawBody: string, headers: Headers): boolean;
}

/* ────────────────────────── helpers ────────────────────────── */

/** Cents to the major unit the provider expects, as a string where needed. */
const toMajor = (cents: number) => cents / 100;

async function postJson(url: string, body: unknown, headers: Record<string, string>) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* provider returned non-JSON; keep the text for the error path */
  }
  return { ok: res.ok, status: res.status, json, text };
}

/**
 * Daraja and Buni both mint short-lived OAuth tokens. They are cached in
 * module scope with a safety margin, because minting one per request costs a
 * round trip on every single collection and Safaricom rate-limits the endpoint.
 */
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

async function cachedToken(
  key: string,
  mint: () => Promise<{ token: string; ttlSeconds: number } | null>,
): Promise<string | null> {
  const hit = tokenCache.get(key);
  if (hit && hit.expiresAt > Date.now() + 30_000) return hit.token;

  const fresh = await mint();
  if (!fresh) return null;
  tokenCache.set(key, {
    token: fresh.token,
    expiresAt: Date.now() + fresh.ttlSeconds * 1000,
  });
  return fresh.token;
}

/* ────────────────────────── Paystack ────────────────────────── */

const paystack: PaymentProvider = {
  name: "PAYSTACK",

  configured() {
    return Boolean(process.env.PAYSTACK_SECRET_KEY);
  },

  async initiate(input) {
    const secret = process.env.PAYSTACK_SECRET_KEY;
    if (!secret) return { ok: false, error: "Paystack secret key is not configured" };
    if (!input.payerEmail) return { ok: false, error: "Paystack requires the payer's email" };

    const base = process.env.PAYSTACK_BASE_URL ?? "https://api.paystack.co";
    const res = await postJson(
      `${base}/transaction/initialize`,
      {
        email: input.payerEmail,
        // Paystack takes the minor unit, which is what we store — no conversion.
        amount: input.amountCents,
        currency: input.currency,
        reference: input.reference,
        callback_url: input.callbackUrl,
        metadata: { description: input.description },
      },
      { Authorization: `Bearer ${secret}` },
    );

    const json = res.json as
      | { status?: boolean; message?: string; data?: { reference?: string; authorization_url?: string } }
      | null;

    if (!res.ok || !json?.status) {
      return { ok: false, error: json?.message ?? `Paystack returned ${res.status}` };
    }
    return {
      ok: true,
      providerRef: json.data?.reference ?? input.reference,
      redirectUrl: json.data?.authorization_url,
      message: "Open the payment link to complete the card payment.",
    };
  },

  async verify(providerRef) {
    const secret = process.env.PAYSTACK_SECRET_KEY;
    if (!secret) return { status: "PENDING", failureReason: "Paystack not configured" };

    const base = process.env.PAYSTACK_BASE_URL ?? "https://api.paystack.co";
    const res = await fetch(`${base}/transaction/verify/${encodeURIComponent(providerRef)}`, {
      headers: { Authorization: `Bearer ${secret}` },
    });
    const json = (await res.json().catch(() => null)) as
      | { status?: boolean; data?: { status?: string; amount?: number; reference?: string; gateway_response?: string } }
      | null;

    const state = json?.data?.status;
    if (state === "success") {
      return {
        status: "SUCCEEDED",
        receiptRef: json?.data?.reference,
        amountCents: json?.data?.amount,
        raw: json,
      };
    }
    if (state === "failed" || state === "abandoned" || state === "reversed") {
      return {
        status: "FAILED",
        failureReason: json?.data?.gateway_response ?? state,
        raw: json,
      };
    }
    return { status: "PENDING", raw: json };
  },

  verifyWebhook(rawBody, headers) {
    const secret = process.env.PAYSTACK_SECRET_KEY;
    const signature = headers.get("x-paystack-signature");
    if (!secret || !signature) return false;

    const expected = crypto.createHmac("sha512", secret).update(rawBody).digest("hex");
    // Constant-time compare: a fast-exit strcmp leaks the prefix a byte at a time.
    const a = Buffer.from(expected, "utf8");
    const b = Buffer.from(signature, "utf8");
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  },
};

/* ─────────────────── M-Pesa · Safaricom Daraja ─────────────────── */

/** Daraja wants `YYYYMMDDHHmmss` in Nairobi time, and rejects anything else. */
function darajaTimestamp(now = new Date()): string {
  const nairobi = new Date(now.getTime() + 3 * 3600_000); // UTC+3, no DST in Kenya
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${nairobi.getUTCFullYear()}${p(nairobi.getUTCMonth() + 1)}${p(nairobi.getUTCDate())}` +
    `${p(nairobi.getUTCHours())}${p(nairobi.getUTCMinutes())}${p(nairobi.getUTCSeconds())}`
  );
}

/** Daraja's MSISDN format is 2547XXXXXXXX — no plus, no leading zero. */
export function toDarajaMsisdn(raw: string): string | null {
  const e164 = normalisePhone(raw);
  if (!e164) return null;
  const digits = e164.replace(/\D/g, "");
  return digits.startsWith("254") && digits.length === 12 ? digits : null;
}

const mpesaDaraja: PaymentProvider = {
  name: "MPESA_DARAJA",

  configured() {
    return Boolean(
      process.env.MPESA_CONSUMER_KEY &&
        process.env.MPESA_CONSUMER_SECRET &&
        process.env.MPESA_SHORTCODE &&
        process.env.MPESA_PASSKEY,
    );
  },

  async initiate(input) {
    if (!this.configured()) return { ok: false, error: "M-Pesa Daraja is not configured" };
    if (!input.payerPhone) return { ok: false, error: "M-Pesa requires the payer's phone number" };

    const msisdn = toDarajaMsisdn(input.payerPhone);
    if (!msisdn) return { ok: false, error: "Not a valid Kenyan mobile number" };

    // Daraja takes whole shillings only; a fractional amount is silently
    // truncated on their side, which would under-collect without telling anyone.
    const shillings = Math.round(toMajor(input.amountCents));
    if (shillings < 1) return { ok: false, error: "Amount must be at least KES 1" };

    const token = await darajaToken();
    if (!token) return { ok: false, error: "Could not authenticate with Daraja" };

    const shortcode = process.env.MPESA_SHORTCODE!;
    const passkey = process.env.MPESA_PASSKEY!;
    const timestamp = darajaTimestamp();
    const password = Buffer.from(`${shortcode}${passkey}${timestamp}`).toString("base64");

    const res = await postJson(
      `${darajaBase()}/mpesa/stkpush/v1/processrequest`,
      {
        BusinessShortCode: shortcode,
        Password: password,
        Timestamp: timestamp,
        TransactionType:
          process.env.MPESA_TRANSACTION_TYPE ?? "CustomerPayBillOnline",
        Amount: shillings,
        PartyA: msisdn,
        PartyB: process.env.MPESA_PARTY_B ?? shortcode,
        PhoneNumber: msisdn,
        CallBackURL: input.callbackUrl,
        // Both are shown to the customer on the STK prompt, and Daraja rejects
        // anything longer than 12 / 13 characters respectively.
        AccountReference: input.reference.slice(0, 12),
        TransactionDesc: input.description.slice(0, 13),
      },
      { Authorization: `Bearer ${token}` },
    );

    const json = res.json as
      | { CheckoutRequestID?: string; ResponseDescription?: string; errorMessage?: string }
      | null;

    if (!res.ok || !json?.CheckoutRequestID) {
      return { ok: false, error: json?.errorMessage ?? `Daraja returned ${res.status}` };
    }
    return {
      ok: true,
      providerRef: json.CheckoutRequestID,
      message: json.ResponseDescription ?? "Ask the customer to enter their M-Pesa PIN.",
    };
  },

  async verify(providerRef) {
    if (!this.configured()) return { status: "PENDING", failureReason: "Daraja not configured" };

    const token = await darajaToken();
    if (!token) return { status: "PENDING", failureReason: "Could not authenticate with Daraja" };

    const shortcode = process.env.MPESA_SHORTCODE!;
    const passkey = process.env.MPESA_PASSKEY!;
    const timestamp = darajaTimestamp();
    const password = Buffer.from(`${shortcode}${passkey}${timestamp}`).toString("base64");

    const res = await postJson(
      `${darajaBase()}/mpesa/stkpushquery/v1/query`,
      {
        BusinessShortCode: shortcode,
        Password: password,
        Timestamp: timestamp,
        CheckoutRequestID: providerRef,
      },
      { Authorization: `Bearer ${token}` },
    );

    const json = res.json as { ResultCode?: string | number; ResultDesc?: string } | null;
    const code = json?.ResultCode == null ? null : String(json.ResultCode);

    if (code === "0") return { status: "SUCCEEDED", raw: json };
    // 1032 is the customer cancelling at the PIN prompt; 1037 is a timeout.
    // Anything non-zero and non-null is terminal — Daraja does not re-prompt.
    if (code != null && code !== "" ) {
      // While the prompt is still on the handset Daraja answers 500.001.1001
      // ("transaction is being processed"), which is not a failure.
      if (code === "500.001.1001") return { status: "PENDING", raw: json };
      return { status: "FAILED", failureReason: json?.ResultDesc ?? `Result ${code}`, raw: json };
    }
    return { status: "PENDING", raw: json };
  },

  /**
   * Daraja does not sign callbacks. Safaricom's guidance is to whitelist their
   * source IPs at the edge; the application therefore treats a callback as a
   * *hint* and always confirms with an explicit query before booking money.
   * Returning true here means "shaped like a callback", not "authenticated".
   */
  verifyWebhook(rawBody) {
    try {
      const body = JSON.parse(rawBody) as { Body?: { stkCallback?: unknown } };
      return Boolean(body?.Body?.stkCallback);
    } catch {
      return false;
    }
  },
};

function darajaBase() {
  return process.env.MPESA_ENV === "production"
    ? "https://api.safaricom.co.ke"
    : "https://sandbox.safaricom.co.ke";
}

async function darajaToken(): Promise<string | null> {
  return cachedToken("daraja", async () => {
    const key = process.env.MPESA_CONSUMER_KEY;
    const secret = process.env.MPESA_CONSUMER_SECRET;
    if (!key || !secret) return null;

    const basic = Buffer.from(`${key}:${secret}`).toString("base64");
    const res = await fetch(
      `${darajaBase()}/oauth/v1/generate?grant_type=client_credentials`,
      { headers: { Authorization: `Basic ${basic}` } },
    );
    if (!res.ok) return null;
    const json = (await res.json().catch(() => null)) as
      | { access_token?: string; expires_in?: string | number }
      | null;
    if (!json?.access_token) return null;
    return { token: json.access_token, ttlSeconds: Number(json.expires_in ?? 3599) };
  });
}

/* ────────────────────────── KCB Buni ────────────────────────── */

const kcbBuni: PaymentProvider = {
  name: "KCB_BUNI",

  configured() {
    return Boolean(
      process.env.KCB_CONSUMER_KEY &&
        process.env.KCB_CONSUMER_SECRET &&
        process.env.KCB_TILL_NUMBER,
    );
  },

  async initiate(input) {
    if (!this.configured()) return { ok: false, error: "KCB Buni is not configured" };
    if (!input.payerPhone) return { ok: false, error: "KCB Buni requires the payer's phone number" };

    const msisdn = toDarajaMsisdn(input.payerPhone);
    if (!msisdn) return { ok: false, error: "Not a valid Kenyan mobile number" };

    const token = await kcbToken();
    if (!token) return { ok: false, error: "Could not authenticate with KCB Buni" };

    const res = await postJson(
      `${kcbBase()}/mm/api/request/1.0.0/stkpush`,
      {
        phoneNumber: msisdn,
        amount: Math.round(toMajor(input.amountCents)),
        invoiceNumber: input.reference,
        sharedShortCode: true,
        till: process.env.KCB_TILL_NUMBER,
        callbackUrl: input.callbackUrl,
        description: input.description,
      },
      { Authorization: `Bearer ${token}` },
    );

    const json = res.json as
      | { transactionId?: string; header?: { statusCode?: number; statusMessage?: string } }
      | null;

    if (!res.ok || !json?.transactionId) {
      return {
        ok: false,
        error: json?.header?.statusMessage ?? `KCB Buni returned ${res.status}`,
      };
    }
    return {
      ok: true,
      providerRef: json.transactionId,
      message: "Ask the customer to authorise the prompt on their phone.",
    };
  },

  async verify(providerRef) {
    if (!this.configured()) return { status: "PENDING", failureReason: "KCB Buni not configured" };

    const token = await kcbToken();
    if (!token) return { status: "PENDING", failureReason: "Could not authenticate with KCB Buni" };

    const res = await fetch(
      `${kcbBase()}/mm/api/request/1.0.0/transaction/${encodeURIComponent(providerRef)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const json = (await res.json().catch(() => null)) as
      | { status?: string; receiptNumber?: string; resultDesc?: string }
      | null;

    const state = (json?.status ?? "").toUpperCase();
    if (state === "SUCCESS" || state === "COMPLETED") {
      return { status: "SUCCEEDED", receiptRef: json?.receiptNumber, raw: json };
    }
    if (state === "FAILED" || state === "CANCELLED" || state === "REJECTED") {
      return { status: "FAILED", failureReason: json?.resultDesc ?? state, raw: json };
    }
    return { status: "PENDING", raw: json };
  },

  /**
   * Buni signs callbacks with a shared secret in `x-buni-signature` when one is
   * configured on the app. Where the tenant has not set one, the callback is
   * treated as a hint and confirmed by an explicit query, exactly as Daraja is.
   */
  verifyWebhook(rawBody, headers) {
    const secret = process.env.KCB_WEBHOOK_SECRET;
    if (!secret) return true; // unsigned: confirmed by query before booking
    const signature = headers.get("x-buni-signature");
    if (!signature) return false;

    const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
    const a = Buffer.from(expected, "utf8");
    const b = Buffer.from(signature, "utf8");
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  },
};

function kcbBase() {
  return (
    process.env.KCB_BASE_URL ??
    (process.env.KCB_ENV === "production"
      ? "https://api.buni.kcbgroup.com"
      : "https://uat.buni.kcbgroup.com")
  );
}

async function kcbToken(): Promise<string | null> {
  return cachedToken("kcb", async () => {
    const key = process.env.KCB_CONSUMER_KEY;
    const secret = process.env.KCB_CONSUMER_SECRET;
    if (!key || !secret) return null;

    const basic = Buffer.from(`${key}:${secret}`).toString("base64");
    const res = await fetch(`${kcbBase()}/token?grant_type=client_credentials`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });
    if (!res.ok) return null;
    const json = (await res.json().catch(() => null)) as
      | { access_token?: string; expires_in?: string | number }
      | null;
    if (!json?.access_token) return null;
    return { token: json.access_token, ttlSeconds: Number(json.expires_in ?? 3599) };
  });
}

/* ────────────────────────── selection ────────────────────────── */

const PROVIDERS: Record<PaymentProviderName, PaymentProvider> = {
  PAYSTACK: paystack,
  MPESA_DARAJA: mpesaDaraja,
  KCB_BUNI: kcbBuni,
};

export function providerFor(name: string): PaymentProvider | null {
  return PROVIDERS[name as PaymentProviderName] ?? null;
}

/**
 * Which gateways this deployment can actually use.
 *
 * The console and the mobile app both read this, so a rep is never offered a
 * method that will fail the moment they tap it — the commonest way a payment
 * feature loses trust on day one.
 */
export function availableProviders() {
  return PAYMENT_PROVIDERS.map((p) => ({
    ...p,
    configured: PROVIDERS[p.name].configured(),
  }));
}
