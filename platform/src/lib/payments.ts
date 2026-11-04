import "server-only";

import crypto from "node:crypto";

import { normalisePhone } from "./sms";

/**
 * Payment gateways — Paystack, M-Pesa (Safaricom Daraja) and KCB Buni.
 *
 * Same shape as the SMS adapters in `sms.ts`: one interface, one adapter per
 * provider, a selector, and nothing transmitted until the attempt is persisted.
 *
 * Credentials are resolved per company and passed in — see `credsFor`. A
 * company with its own stored bundle uses **only** that bundle; a company with
 * none uses the deployment's environment. The two are never mixed, because a
 * tenant key plus a platform secret is a payment into the wrong account.
 *
 * Two properties matter more here than anywhere else in the platform:
 *
 *   **The provider is the authority on whether money moved.** A client saying
 *   "paid" means nothing. Every success path runs through an explicit verify
 *   call back to the provider; a callback only says *which* intent to ask about.
 *
 *   **Callbacks arrive more than once, and sometimes never.** Paystack retries,
 *   Daraja retries, a rep on a slow screen retries, and a response can be lost
 *   after the provider acted on it. Settlement is keyed on the provider's own
 *   reference, and every outbound call carries a timeout so a hung socket can
 *   never hold a request open for ever.
 */

export type PaymentProviderName = "PAYSTACK" | "MPESA_DARAJA" | "KCB_BUNI";

/**
 * A resolved credential bundle for one company and one provider.
 *
 * Adapters read from this rather than `process.env` directly, so the same code
 * serves a tenant with its own Paystack account and a deployment running a
 * single shared one. `credsFor` below decides which wins.
 */
export type Creds = Record<string, string | undefined>;

const nonEmpty = (v: string | undefined) => (v && v.length > 0 ? v : undefined);

/**
 * A tenant bundle, when present, is the **whole** credential set.
 *
 * Earlier this fell back to the environment key by key, which meant a tenant
 * that had stored a Paystack secret but no public key silently used the
 * platform's public key, and a tenant missing one Daraja value collected into
 * the platform's paybill. Now: a bundle answers for every key, present or not;
 * optional values default inside the adapter, never from the environment. Only
 * a company with *no* bundle at all reads the environment.
 */
export function credsFor(tenant: Creds | null | undefined) {
  const bundle = tenant ?? null;
  return (key: string): string | undefined =>
    bundle ? nonEmpty(bundle[key]) : nonEmpty(process.env[key]);
}

/** The keys each provider needs, for validation and for the settings form. */
export const REQUIRED_KEYS: Record<PaymentProviderName, string[]> = {
  PAYSTACK: ["PAYSTACK_SECRET_KEY"],
  MPESA_DARAJA: [
    "MPESA_CONSUMER_KEY",
    "MPESA_CONSUMER_SECRET",
    "MPESA_SHORTCODE",
    "MPESA_PASSKEY",
  ],
  KCB_BUNI: ["KCB_CONSUMER_KEY", "KCB_CONSUMER_SECRET", "KCB_TILL_NUMBER"],
};

export const PAYMENT_PROVIDERS: Array<{
  name: PaymentProviderName;
  label: string;
  /** What the payer supplies for this provider. */
  needs: "phone" | "email";
  /** Maps to Payment.method once settled. */
  method: string;
  /** True when the provider takes whole shillings only (no cents). */
  wholeUnits: boolean;
}> = [
  { name: "MPESA_DARAJA", label: "M-Pesa (STK push)", needs: "phone", method: "MPESA_STK", wholeUnits: true },
  { name: "PAYSTACK", label: "Card / Paystack", needs: "email", method: "PAYSTACK", wholeUnits: false },
  { name: "KCB_BUNI", label: "KCB Buni", needs: "phone", method: "KCB_BUNI", wholeUnits: true },
];

/** Payment.method values that only `settleIntent` may book. */
export const GATEWAY_METHODS: ReadonlySet<string> = new Set(PAYMENT_PROVIDERS.map((p) => p.method));

/** A manual M-Pesa confirmation code as the customer reads it off the SMS. */
export const MPESA_CODE_PATTERN = /^[A-Z0-9]{10}$/;

export interface InitiateInput {
  amountCents: number;
  currency: string;
  /** Our own reference, echoed back by the provider where it supports one. */
  reference: string;
  payerPhone?: string | null;
  payerEmail?: string | null;
  description: string;
  /** Server-to-server notification URL. */
  callbackUrl: string;
  /** Where the payer's browser lands after a hosted checkout (Paystack). */
  returnUrl?: string;
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
  /**
   * REVERSED is only ever reported for a charge that previously succeeded:
   * Paystack refunded or charged it back. The caller decides what that means
   * for the ledger; this file only reports it.
   */
  status: "PENDING" | "SUCCEEDED" | "FAILED" | "REVERSED";
  receiptRef?: string;
  amountCents?: number;
  currency?: string;
  failureReason?: string;
  /** Provider-specific code (Daraja ResultCode/errorCode, Paystack status). */
  code?: string;
  /** True when the provider refused *our* credentials, not the transaction. */
  authError?: boolean;
  raw?: unknown;
}

export interface PaymentProvider {
  readonly name: PaymentProviderName;
  /** True when this company's credentials carry everything the adapter needs. */
  configured(creds?: Creds): boolean;
  /**
   * Starts a collection. Throws `ProviderTransportError` when the provider
   * could not be reached; returns `ok: false` when it answered with a refusal.
   */
  initiate(input: InitiateInput, creds?: Creds): Promise<InitiateResult>;
  /** Ask the provider directly. Used for polling and to confirm a webhook. */
  verify(providerRef: string, creds?: Creds): Promise<VerifyResult>;
  /**
   * Look a collection up by *our* reference, for an intent whose initiate
   * response was lost before the provider's handle reached us. Only providers
   * that echo the merchant reference can offer this.
   */
  verifyByReference?(reference: string, creds?: Creds): Promise<VerifyResult>;
  /**
   * Validates a webhook body against the provider's signature scheme.
   * Returning false must be treated as hostile, not as a transient error.
   */
  verifyWebhook(rawBody: string, headers: Headers, creds?: Creds): boolean;
  /**
   * Proves the stored credential authenticates, without moving money. A good
   * key is told "unknown transaction"; a bad one is told "unauthorised".
   */
  testCredentials(creds?: Creds): Promise<{ ok: boolean; note: string }>;
}

/* ────────────────────────── transport ────────────────────────── */

const DEFAULT_TIMEOUT_MS = 20_000;

/** `PAYMENTS_TIMEOUT_MS`, read per call so a test can shorten it. */
export function paymentsTimeoutMs(): number {
  const n = Number(process.env.PAYMENTS_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
}

/**
 * The provider could not be reached, or did not answer in time.
 *
 * `sent` is the one fact a caller needs: **false** means the request never
 * left (connection refused, host unknown), so nothing happened on the
 * provider's side and the intent can be failed outright. **true** means the
 * bytes may have arrived — a timeout, a reset mid-flight — and an STK prompt
 * may be sitting on the customer's phone, so the intent must stay live and be
 * reconciled rather than declared dead.
 */
export class ProviderTransportError extends Error {
  constructor(
    message: string,
    readonly sent: boolean,
    readonly causeCode?: string,
  ) {
    super(message);
    this.name = "ProviderTransportError";
  }
}

const NOT_SENT_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ERR_INVALID_URL", "EHOSTUNREACH", "ENETUNREACH", "EADDRNOTAVAIL"]);

/**
 * undici reports a refusal in several shapes: `cause.code`, an AggregateError
 * of per-address errors (localhost → ::1 and 127.0.0.1), or a bare message
 * such as "bad port" for a URL it refuses to dial at all. All of them mean the
 * request never left this process.
 */
function notSentCode(e: { code?: string; cause?: { code?: string; message?: string; errors?: Array<{ code?: string }> } }): string | null {
  const cause = e?.cause;
  const direct = cause?.code ?? e?.code;
  if (direct && NOT_SENT_CODES.has(direct)) return direct;
  const nested = cause?.errors?.map((x) => x?.code).find((c) => c && NOT_SENT_CODES.has(c));
  if (nested) return nested;
  const message = cause?.message ?? "";
  const inMessage = [...NOT_SENT_CODES].find((c) => message.includes(c));
  if (inMessage) return inMessage;
  if (/bad port|invalid url|unsupported protocol/i.test(message)) return "ERR_INVALID_URL";
  return null;
}

function transportError(error: unknown): ProviderTransportError {
  if (error instanceof ProviderTransportError) return error;
  const e = error as { name?: string; code?: string; cause?: { code?: string; name?: string; message?: string; errors?: Array<{ code?: string }> } };
  if (e?.name === "AbortError" || e?.cause?.name === "AbortError") {
    return new ProviderTransportError(`The payment provider did not answer within ${paymentsTimeoutMs()} ms`, true, "ETIMEDOUT");
  }
  const code = notSentCode(e);
  if (code) {
    return new ProviderTransportError(`The payment provider is unreachable (${code})`, false, code);
  }
  const other = e?.cause?.code ?? e?.code;
  return new ProviderTransportError(
    `Lost the connection to the payment provider${other ? ` (${other})` : ""}`,
    true,
    other,
  );
}

interface HttpResult {
  ok: boolean;
  status: number;
  json: unknown;
  text: string;
}

/** One outbound call, always bounded by `PAYMENTS_TIMEOUT_MS`. */
async function request(url: string, init: RequestInit): Promise<HttpResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), paymentsTimeoutMs());
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* provider returned non-JSON; keep the text for the error path */
    }
    return { ok: res.ok, status: res.status, json, text };
  } catch (error) {
    throw transportError(error);
  } finally {
    clearTimeout(timer);
  }
}

const postJson = (url: string, body: unknown, headers: Record<string, string>) =>
  request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", ...headers },
    body: JSON.stringify(body),
  });

const getJson = (url: string, headers: Record<string, string>) =>
  request(url, { method: "GET", headers: { Accept: "application/json", ...headers } });

/* ────────────────────────── helpers ────────────────────────── */

type EnvReader = (key: string) => string | undefined;

/** Short, non-reversible handle for a credential, used only as a cache key. */
function cacheKeyFor(secret: string): string {
  return crypto.createHash("sha256").update(secret).digest("hex").slice(0, 16);
}

/**
 * Whole shillings for a provider that takes no cents, or null when the amount
 * has cents. Daraja silently truncates a fractional amount on its side, which
 * under-collects without telling anyone, so an amount with cents is refused at
 * the door (422) rather than rounded here.
 */
export function toWholeShillings(cents: number): number | null {
  if (!Number.isInteger(cents) || cents <= 0) return null;
  if (cents % 100 !== 0) return null;
  return cents / 100;
}

/**
 * Where a provider's API lives.
 *
 * Resolution: the company's own optional key, then the deployment's
 * environment, then the official host. The environment is consulted even for
 * a company with a stored bundle — a host is a deployment concern, not an
 * identity, and it is how a staging box points every tenant at a sandbox or a
 * test at a mock. Tenant-supplied hosts are checked against
 * `OFFICIAL_GATEWAY_HOSTS` when saved (see `baseUrlProblem`).
 */
function hostFor(env: EnvReader, key: string, fallback: string): string {
  const url = env(key) ?? nonEmpty(process.env[key]) ?? fallback;
  return url.replace(/\/+$/, "");
}

/** The hosts a tenant may point a base-URL key at without an operator override. */
export const OFFICIAL_GATEWAY_HOSTS: Record<string, string[]> = {
  PAYSTACK_BASE_URL: ["api.paystack.co"],
  MPESA_BASE_URL: ["api.safaricom.co.ke", "sandbox.safaricom.co.ke"],
  KCB_BASE_URL: ["api.buni.kcbgroup.com", "uat.buni.kcbgroup.com"],
};

/**
 * Why a tenant-supplied base URL must be refused, or null when it is fine.
 *
 * A base URL in a credential bundle is where this server will POST a merchant
 * secret and a bearer token. Letting a company admin set it to any host turns
 * the credential form into an exfiltration channel for the platform's own
 * outbound traffic and a server-side request forgery primitive. Official hosts
 * only, unless the deployment explicitly opts in (`PAYMENTS_ALLOW_CUSTOM_HOSTS=1`,
 * which is what a staging box pointed at a mock sets).
 */
export function baseUrlProblem(key: string, value: string): string | null {
  const allowed = OFFICIAL_GATEWAY_HOSTS[key];
  if (!allowed) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return `${key} is not a valid URL`;
  }
  if (process.env.PAYMENTS_ALLOW_CUSTOM_HOSTS === "1") return null;
  if (url.protocol !== "https:") return `${key} must use https`;
  if (!allowed.includes(url.hostname.toLowerCase())) {
    return `${key} may only point at ${allowed.join(" or ")}. Ask your platform administrator if you need a different host.`;
  }
  return null;
}

/**
 * Why a credential bundle is unfit for this deployment, or null.
 *
 * A production deployment that accepts a `sk_test_` Paystack key or a Daraja
 * sandbox switch collects play money from real customers. Refused with a
 * clear message unless the operator sets `PAYMENTS_ALLOW_TEST_KEYS=1`.
 */
export function testCredentialProblem(
  provider: string,
  values: Record<string, string | undefined>,
): string | null {
  if (process.env.NODE_ENV !== "production") return null;
  if (process.env.PAYMENTS_ALLOW_TEST_KEYS === "1") return null;
  if (provider === "PAYSTACK" && (values.PAYSTACK_SECRET_KEY ?? "").startsWith("sk_test_")) {
    return "This is a Paystack test key (sk_test_…). A production deployment needs a live key, sk_live_…";
  }
  if (provider === "MPESA_DARAJA" && (values.MPESA_ENV ?? "production").toLowerCase() === "sandbox") {
    return "MPESA_ENV=sandbox points at Safaricom's sandbox. A production deployment needs MPESA_ENV=production";
  }
  return null;
}

/* ────────────────────────── rate limiting ────────────────────────── */

/**
 * A token bucket per key, in process memory.
 *
 * Good enough for one Node process behind nginx, which is how Raut deploys.
 * The callbacks route uses it per source IP so a misbehaving sender cannot
 * turn every callback into a provider round trip; initiate uses it per user so
 * a stuck "Request" button cannot push five STK prompts a second at a customer.
 */
export function rateLimiter(capacity: number, refillPerSecond: number) {
  const buckets = new Map<string, { tokens: number; at: number }>();
  return function allow(key: string, now = Date.now()): boolean {
    let b = buckets.get(key);
    if (!b) {
      b = { tokens: capacity, at: now };
      buckets.set(key, b);
    }
    const elapsed = Math.max(0, now - b.at) / 1000;
    b.tokens = Math.min(capacity, b.tokens + elapsed * refillPerSecond);
    b.at = now;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    if (buckets.size > 5000) {
      for (const [k, v] of buckets) if (now - v.at > 120_000) buckets.delete(k);
    }
    return true;
  };
}

/* ────────────────────────── OAuth token cache ────────────────────────── */

/**
 * Daraja and Buni both mint short-lived OAuth tokens. They are cached in
 * module scope with a safety margin, because minting one per request costs a
 * round trip on every single collection and Safaricom rate-limits the endpoint.
 * A 401 from the provider evicts the entry, so a token revoked early is minted
 * again on the next call rather than failing until it would have expired.
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

/** Exported for tests: forget every cached token. */
export function resetTokenCache() {
  tokenCache.clear();
}

/* ────────────────────────── Paystack ────────────────────────── */

interface PaystackTx {
  status?: string;
  amount?: number;
  currency?: string;
  reference?: string;
  channel?: string;
  paid_at?: string;
  gateway_response?: string;
  authorization_url?: string;
  access_code?: string;
}

/**
 * The part of a Paystack transaction worth keeping.
 *
 * The full object carries the payer's email, the card's `authorization`
 * (bin, last4, bank, reusable token) and the customer record. None of it is
 * needed to settle or to argue a dispute, and a database dump should not hand
 * anyone a list of card fragments, so the payload is reduced here before it
 * is stored.
 */
export function stripPaystack(data: unknown): Record<string, unknown> | null {
  if (!data || typeof data !== "object") return null;
  const d = data as PaystackTx;
  return {
    status: d.status,
    amount: d.amount,
    currency: d.currency,
    reference: d.reference,
    channel: d.channel,
    paid_at: d.paid_at,
    gateway_response: d.gateway_response,
  };
}

/** Which webhook events are acted on; everything else is acknowledged and dropped. */
export function paystackEventKind(body: unknown): "charge.success" | "charge.failed" | "refund" | null {
  const event = (body as { event?: unknown })?.event;
  if (typeof event !== "string") return null;
  if (event === "charge.success") return "charge.success";
  if (event === "charge.failed") return "charge.failed";
  if (event.startsWith("refund.")) return "refund";
  return null;
}

function paystackVerdict(res: HttpResult, expectCurrency?: string): VerifyResult {
  const json = res.json as { status?: boolean; message?: string; data?: PaystackTx } | null;
  if (res.status === 401 || res.status === 403) {
    return {
      status: "PENDING",
      authError: true,
      code: String(res.status),
      failureReason: "Paystack rejected the secret key",
      raw: { status: res.status, message: json?.message },
    };
  }
  const data = json?.data;
  const state = data?.status;
  const raw = stripPaystack(data) ?? { status: res.status, message: json?.message };

  if (state === "success") {
    if (expectCurrency && data?.currency && data.currency !== expectCurrency) {
      return {
        status: "FAILED",
        code: "currency",
        failureReason: `Paid in ${data.currency}, expected ${expectCurrency}`,
        amountCents: data.amount,
        currency: data.currency,
        raw,
      };
    }
    return {
      status: "SUCCEEDED",
      receiptRef: data?.reference,
      amountCents: data?.amount,
      currency: data?.currency,
      code: state,
      raw,
    };
  }
  if (state === "reversed") {
    return { status: "REVERSED", code: state, failureReason: data?.gateway_response ?? "Reversed by Paystack", amountCents: data?.amount, currency: data?.currency, raw };
  }
  if (state === "failed" || state === "abandoned") {
    return {
      status: "FAILED",
      code: state,
      failureReason: data?.gateway_response ?? (state === "abandoned" ? "The customer did not complete the payment" : "Declined"),
      raw,
    };
  }
  // "ongoing", "pending", "processing", "queued", or an unknown reference
  // (400 "Transaction reference not found") — nothing final yet.
  return { status: "PENDING", code: state ?? String(res.status), failureReason: json?.message, raw };
}

const paystack: PaymentProvider = {
  name: "PAYSTACK",

  configured(creds) {
    return Boolean(credsFor(creds)("PAYSTACK_SECRET_KEY"));
  },

  async initiate(input, creds) {
    const env = credsFor(creds);
    const secret = env("PAYSTACK_SECRET_KEY");
    if (!secret) return { ok: false, error: "Paystack secret key is not configured" };
    if (!input.payerEmail) return { ok: false, error: "Paystack requires the payer's email" };

    const base = hostFor(env, "PAYSTACK_BASE_URL", "https://api.paystack.co");
    const res = await postJson(
      `${base}/transaction/initialize`,
      {
        email: input.payerEmail,
        // Paystack takes the minor unit, which is what we store — no conversion.
        amount: input.amountCents,
        currency: input.currency,
        reference: input.reference,
        // Where the payer's browser goes afterwards. Server-side notification
        // is the webhook, configured once on the Paystack dashboard.
        callback_url: input.returnUrl ?? input.callbackUrl,
        metadata: { description: input.description, raut_reference: input.reference },
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

  async verify(providerRef, creds) {
    const env = credsFor(creds);
    const secret = env("PAYSTACK_SECRET_KEY");
    if (!secret) return { status: "PENDING", failureReason: "Paystack not configured", authError: true };

    const base = hostFor(env, "PAYSTACK_BASE_URL", "https://api.paystack.co");
    const res = await getJson(`${base}/transaction/verify/${encodeURIComponent(providerRef)}`, {
      Authorization: `Bearer ${secret}`,
    });
    return paystackVerdict(res, env("PAYSTACK_CURRENCY") ?? "KES");
  },

  // Paystack's reference *is* our reference, so the lookup is the same call.
  async verifyByReference(reference, creds) {
    return paystack.verify(reference, creds);
  },

  verifyWebhook(rawBody, headers, creds) {
    const secret = credsFor(creds)("PAYSTACK_SECRET_KEY");
    const signature = headers.get("x-paystack-signature");
    if (!secret || !signature) return false;

    const expected = crypto.createHmac("sha512", secret).update(rawBody).digest("hex");
    // Constant-time compare: a fast-exit strcmp leaks the prefix a byte at a time.
    const a = Buffer.from(expected, "utf8");
    const b = Buffer.from(signature, "utf8");
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  },

  async testCredentials(creds) {
    const env = credsFor(creds);
    const secret = env("PAYSTACK_SECRET_KEY");
    if (!secret) return { ok: false, note: "PAYSTACK_SECRET_KEY is missing" };
    const base = hostFor(env, "PAYSTACK_BASE_URL", "https://api.paystack.co");
    let res: HttpResult;
    try {
      res = await getJson(`${base}/transaction/verify/raut-credential-test`, {
        Authorization: `Bearer ${secret}`,
      });
    } catch (error) {
      return { ok: false, note: `Paystack unreachable: ${(error as Error).message}` };
    }
    const json = res.json as { status?: boolean; message?: string } | null;
    if (res.status === 401 || res.status === 403) {
      return { ok: false, note: `Paystack rejected the secret key (HTTP ${res.status}${json?.message ? `: ${json.message}` : ""})` };
    }
    // A valid key is told the reference does not exist (400/404, status:false).
    if ((res.status === 400 || res.status === 404) && json && json.status === false) {
      return { ok: true, note: `Authenticated with Paystack (${secret.startsWith("sk_test_") ? "test" : "live"} key)` };
    }
    if (res.ok) return { ok: true, note: "Authenticated with Paystack" };
    return { ok: false, note: `Unexpected answer from Paystack: HTTP ${res.status} ${json?.message ?? res.text.slice(0, 120)}` };
  },
};

/* ─────────────────── M-Pesa · Safaricom Daraja ─────────────────── */

/** Daraja wants `YYYYMMDDHHmmss` in Nairobi time, and rejects anything else. */
export function darajaTimestamp(now = new Date()): string {
  const nairobi = new Date(now.getTime() + 3 * 3600_000); // UTC+3, no DST in Kenya
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${nairobi.getUTCFullYear()}${p(nairobi.getUTCMonth() + 1)}${p(nairobi.getUTCDate())}` +
    `${p(nairobi.getUTCHours())}${p(nairobi.getUTCMinutes())}${p(nairobi.getUTCSeconds())}`
  );
}

/** base64(shortcode + passkey + timestamp), as the STK endpoints require. */
export function darajaPassword(shortcode: string, passkey: string, timestamp: string): string {
  return Buffer.from(`${shortcode}${passkey}${timestamp}`).toString("base64");
}

/** Daraja's MSISDN format is 2547XXXXXXXX — no plus, no leading zero. */
export function toDarajaMsisdn(raw: string): string | null {
  const e164 = normalisePhone(raw);
  if (!e164) return null;
  const digits = e164.replace(/\D/g, "");
  return digits.startsWith("254") && digits.length === 12 ? digits : null;
}

/** Daraja's field limits, shown on the customer's STK prompt. */
export const DARAJA_ACCOUNT_REF_MAX = 12;
export const DARAJA_DESC_MAX = 13;

/**
 * ResultCode → what the rep should read. Daraja's own ResultDesc is terse
 * ("Request cancelled by user", "DS timeout") and sometimes wrong, so the
 * common ones are spelled out.
 */
export const DARAJA_RESULT_REASONS: Record<string, string> = {
  "1": "Insufficient M-Pesa balance",
  "1001": "The customer has another M-Pesa transaction in progress. Try again shortly",
  "1019": "The transaction expired before the customer completed it",
  "1025": "The prompt could not be sent to the handset",
  "1032": "Cancelled by the customer",
  "1037": "No response from the customer's phone — it may be off or out of reach",
  "2001": "Wrong M-Pesa PIN entered",
  "9999": "The prompt could not be sent to the handset",
};

/** Codes Daraja answers with while the prompt is still live on the handset. */
const DARAJA_PENDING_CODES = new Set(["500.001.1001", "4999"]);

/** Codes meaning "your token is bad", not "the transaction is bad". */
const DARAJA_AUTH_CODES = new Set(["404.001.03", "404.001.04", "401.002.01", "400.008.01"]);

/** "This CheckoutRequestID is not one we know" — proof the token worked. */
const DARAJA_UNKNOWN_REQUEST_CODES = new Set(["400.002.02", "500.001.1002"]);

/**
 * Turns an STK query response into a verdict. Pure, so the tests can walk
 * every shape Daraja is known to answer with:
 *
 *   - `ResultCode: "0"` → SUCCEEDED.
 *   - HTTP 500 `errorCode: "500.001.1001"` ("transaction is being processed"),
 *     `ResultCode: "4999"`, or no ResultCode at all → PENDING. These are the
 *     normal answers while the prompt sits on the phone; treating any of them
 *     as failure would cancel a collection the customer is about to approve.
 *   - Any other ResultCode → FAILED, with a human reason where one is known.
 *   - 401 / invalid-token codes → PENDING with `authError`, and the caller
 *     evicts the cached token.
 *   - An unknown CheckoutRequestID → PENDING with that code; the credential
 *     test uses it as proof that authentication worked.
 */
export function darajaVerdict(httpStatus: number, json: unknown): VerifyResult {
  const j = (json ?? {}) as { ResultCode?: string | number; ResultDesc?: string; errorCode?: string; errorMessage?: string };
  const errorCode = j.errorCode == null ? null : String(j.errorCode);

  if (httpStatus === 401 || (errorCode && DARAJA_AUTH_CODES.has(errorCode))) {
    return { status: "PENDING", authError: true, code: errorCode ?? "401", failureReason: "Could not authenticate with Daraja", raw: json };
  }
  if (errorCode) {
    if (DARAJA_PENDING_CODES.has(errorCode)) return { status: "PENDING", code: errorCode, raw: json };
    if (DARAJA_UNKNOWN_REQUEST_CODES.has(errorCode)) {
      return { status: "PENDING", code: errorCode, failureReason: j.errorMessage ?? "Daraja does not recognise this request", raw: json };
    }
    // Any other errorCode is Daraja being unable to answer right now, not a
    // verdict on the transaction. Stay pending; expiry is the backstop.
    return { status: "PENDING", code: errorCode, failureReason: j.errorMessage ?? `Daraja error ${errorCode}`, raw: json };
  }

  const code = j.ResultCode == null || j.ResultCode === "" ? null : String(j.ResultCode);
  if (code === null) return { status: "PENDING", raw: json };
  if (code === "0") return { status: "SUCCEEDED", code, raw: json };
  if (DARAJA_PENDING_CODES.has(code)) return { status: "PENDING", code, raw: json };
  return {
    status: "FAILED",
    code,
    failureReason: DARAJA_RESULT_REASONS[code] ?? j.ResultDesc ?? `M-Pesa result ${code}`,
    raw: json,
  };
}

export interface DarajaCallback {
  checkoutRequestId: string;
  merchantRequestId?: string;
  resultCode: string;
  resultDesc?: string;
  /** Whole shillings × 100, when the callback carries an amount. */
  amountCents?: number;
  receiptRef?: string;
  phone?: string;
  transactionDate?: string;
}

/**
 * Pulls the useful fields out of `Body.stkCallback`. The receipt number only
 * ever arrives here — the STK query endpoint does not return it — so this is
 * what the customer's receipt is built from once verify agrees the money moved.
 */
export function parseDarajaCallback(body: unknown): DarajaCallback | null {
  const cb = (body as { Body?: { stkCallback?: Record<string, unknown> } })?.Body?.stkCallback;
  if (!cb || typeof cb !== "object") return null;
  const checkoutRequestId = cb.CheckoutRequestID;
  if (typeof checkoutRequestId !== "string" || !checkoutRequestId) return null;

  const out: DarajaCallback = {
    checkoutRequestId,
    merchantRequestId: typeof cb.MerchantRequestID === "string" ? cb.MerchantRequestID : undefined,
    resultCode: cb.ResultCode == null ? "" : String(cb.ResultCode),
    resultDesc: typeof cb.ResultDesc === "string" ? cb.ResultDesc : undefined,
  };

  const items = (cb.CallbackMetadata as { Item?: Array<{ Name?: string; Value?: unknown }> } | undefined)?.Item;
  if (Array.isArray(items)) {
    for (const item of items) {
      switch (item?.Name) {
        case "Amount": {
          const n = Number(item.Value);
          if (Number.isFinite(n)) out.amountCents = Math.round(n * 100);
          break;
        }
        case "MpesaReceiptNumber":
          if (item.Value != null) out.receiptRef = String(item.Value);
          break;
        case "PhoneNumber":
          if (item.Value != null) out.phone = String(item.Value);
          break;
        case "TransactionDate":
          if (item.Value != null) out.transactionDate = String(item.Value);
          break;
        default:
          break;
      }
    }
  }
  return out;
}

function darajaBase(env: EnvReader) {
  return hostFor(
    env,
    "MPESA_BASE_URL",
    env("MPESA_ENV") === "production" ? "https://api.safaricom.co.ke" : "https://sandbox.safaricom.co.ke",
  );
}

function darajaTokenKey(env: EnvReader) {
  // Keyed on the credential itself, not the string "daraja". With per-company
  // credentials a single shared cache key would hand one tenant's access token
  // to another tenant's collection — money into the wrong merchant account.
  return `daraja:${cacheKeyFor(env("MPESA_CONSUMER_KEY") ?? "")}`;
}

async function darajaToken(env: EnvReader): Promise<string | null> {
  const key = env("MPESA_CONSUMER_KEY");
  const secret = env("MPESA_CONSUMER_SECRET");
  if (!key || !secret) return null;

  return cachedToken(darajaTokenKey(env), async () => {
    const basic = Buffer.from(`${key}:${secret}`).toString("base64");
    const res = await getJson(`${darajaBase(env)}/oauth/v1/generate?grant_type=client_credentials`, {
      Authorization: `Basic ${basic}`,
    });
    if (!res.ok) return null;
    const json = res.json as { access_token?: string; expires_in?: string | number } | null;
    if (!json?.access_token) return null;
    return { token: json.access_token, ttlSeconds: Number(json.expires_in ?? 3599) };
  });
}

/**
 * Runs one authenticated Daraja call, re-minting the token once if the first
 * attempt is refused as unauthenticated. The second refusal is returned as is.
 */
async function withDarajaToken(
  env: EnvReader,
  call: (token: string) => Promise<HttpResult>,
): Promise<HttpResult | null> {
  const token = await darajaToken(env);
  if (!token) return null;
  const first = await call(token);
  const code = (first.json as { errorCode?: string } | null)?.errorCode;
  if (first.status !== 401 && !(code && DARAJA_AUTH_CODES.has(code))) return first;

  tokenCache.delete(darajaTokenKey(env));
  const fresh = await darajaToken(env);
  if (!fresh || fresh === token) return first;
  return call(fresh);
}

function stkQueryBody(env: EnvReader, checkoutRequestId: string) {
  const shortcode = env("MPESA_SHORTCODE")!;
  const passkey = env("MPESA_PASSKEY")!;
  const timestamp = darajaTimestamp();
  return {
    BusinessShortCode: shortcode,
    Password: darajaPassword(shortcode, passkey, timestamp),
    Timestamp: timestamp,
    CheckoutRequestID: checkoutRequestId,
  };
}

const mpesaDaraja: PaymentProvider = {
  name: "MPESA_DARAJA",

  configured(creds) {
    const env = credsFor(creds);
    return REQUIRED_KEYS.MPESA_DARAJA.every((k) => Boolean(env(k)));
  },

  async initiate(input, creds) {
    const env = credsFor(creds);
    if (!this.configured(creds)) {
      return { ok: false, error: "M-Pesa Daraja is not configured" };
    }
    if (!input.payerPhone) return { ok: false, error: "M-Pesa requires the payer's phone number" };

    const msisdn = toDarajaMsisdn(input.payerPhone);
    if (!msisdn) return { ok: false, error: "Not a valid Kenyan mobile number" };

    const shillings = toWholeShillings(input.amountCents);
    if (shillings === null) return { ok: false, error: "M-Pesa takes whole shillings only" };
    if (shillings < 1) return { ok: false, error: "Amount must be at least KES 1" };

    const shortcode = env("MPESA_SHORTCODE")!;
    const passkey = env("MPESA_PASSKEY")!;

    // The token is minted before anything is pushed: a failure here means
    // nothing reached the customer, and the caller may say so.
    const res = await withDarajaToken(env, (token) => {
      const timestamp = darajaTimestamp();
      return postJson(
        `${darajaBase(env)}/mpesa/stkpush/v1/processrequest`,
        {
          BusinessShortCode: shortcode,
          Password: darajaPassword(shortcode, passkey, timestamp),
          Timestamp: timestamp,
          TransactionType: env("MPESA_TRANSACTION_TYPE") ?? "CustomerPayBillOnline",
          Amount: shillings,
          PartyA: msisdn,
          PartyB: env("MPESA_PARTY_B") ?? shortcode,
          PhoneNumber: msisdn,
          CallBackURL: input.callbackUrl,
          // Both are shown to the customer on the STK prompt, and Daraja rejects
          // anything longer than 12 / 13 characters respectively.
          AccountReference: input.reference.slice(0, DARAJA_ACCOUNT_REF_MAX),
          TransactionDesc: input.description.slice(0, DARAJA_DESC_MAX),
        },
        { Authorization: `Bearer ${token}` },
      );
    });
    if (!res) return { ok: false, error: "Could not authenticate with Daraja" };

    const json = res.json as
      | { CheckoutRequestID?: string; ResponseDescription?: string; errorMessage?: string; errorCode?: string }
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

  async verify(providerRef, creds) {
    const env = credsFor(creds);
    if (!this.configured(creds)) {
      return { status: "PENDING", failureReason: "Daraja not configured", authError: true };
    }

    const res = await withDarajaToken(env, (token) =>
      postJson(`${darajaBase(env)}/mpesa/stkpushquery/v1/query`, stkQueryBody(env, providerRef), {
        Authorization: `Bearer ${token}`,
      }),
    );
    if (!res) return { status: "PENDING", failureReason: "Could not authenticate with Daraja", authError: true };
    return darajaVerdict(res.status, res.json);
  },

  /**
   * Daraja does not sign callbacks. Safaricom's guidance is to whitelist their
   * source IPs at the edge; the application therefore treats a callback as a
   * *hint* and always confirms with an explicit query before booking money.
   * Returning true here means "shaped like a callback", not "authenticated".
   */
  verifyWebhook(rawBody) {
    try {
      return parseDarajaCallback(JSON.parse(rawBody)) !== null;
    } catch {
      return false;
    }
  },

  async testCredentials(creds) {
    const env = credsFor(creds);
    const missing = REQUIRED_KEYS.MPESA_DARAJA.filter((k) => !env(k));
    if (missing.length > 0) return { ok: false, note: `Keys missing: ${missing.join(", ")}` };

    tokenCache.delete(darajaTokenKey(env));
    let token: string | null;
    try {
      token = await darajaToken(env);
    } catch (error) {
      return { ok: false, note: `Daraja unreachable: ${(error as Error).message}` };
    }
    if (!token) return { ok: false, note: "Daraja refused the consumer key / secret (no access token issued)" };

    // OAuth alone proves the app credentials; the shortcode and passkey are
    // only exercised by an STK call. A query for an id that cannot exist does
    // that without pushing anything to a phone.
    let res: HttpResult;
    try {
      res = await postJson(
        `${darajaBase(env)}/mpesa/stkpushquery/v1/query`,
        stkQueryBody(env, "ws_CO_raut_credential_test"),
        { Authorization: `Bearer ${token}` },
      );
    } catch (error) {
      return { ok: false, note: `Daraja unreachable: ${(error as Error).message}` };
    }
    const verdict = darajaVerdict(res.status, res.json);
    if (verdict.authError) return { ok: false, note: `Daraja rejected the access token (${verdict.code})` };
    if (verdict.code && DARAJA_UNKNOWN_REQUEST_CODES.has(verdict.code)) {
      return { ok: true, note: `Authenticated with Daraja (${env("MPESA_ENV") === "production" ? "production" : "sandbox"}, shortcode ${env("MPESA_SHORTCODE")})` };
    }
    if (verdict.code && DARAJA_PENDING_CODES.has(verdict.code)) {
      return { ok: true, note: "Authenticated with Daraja (query accepted)" };
    }
    if (res.status === 400 || res.status === 500) {
      const j = res.json as { errorMessage?: string; errorCode?: string } | null;
      return { ok: false, note: `Daraja refused the STK query: ${j?.errorCode ?? res.status} ${j?.errorMessage ?? ""}`.trim() };
    }
    return { ok: res.ok, note: res.ok ? "Authenticated with Daraja" : `Unexpected answer from Daraja: HTTP ${res.status}` };
  },
};

/* ────────────────────────── KCB Buni ────────────────────────── */

const kcbBuni: PaymentProvider = {
  name: "KCB_BUNI",

  configured(creds) {
    const env = credsFor(creds);
    return REQUIRED_KEYS.KCB_BUNI.every((k) => Boolean(env(k)));
  },

  async initiate(input, creds) {
    const env = credsFor(creds);
    if (!this.configured(creds)) return { ok: false, error: "KCB Buni is not configured" };
    if (!input.payerPhone) return { ok: false, error: "KCB Buni requires the payer's phone number" };

    const msisdn = toDarajaMsisdn(input.payerPhone);
    if (!msisdn) return { ok: false, error: "Not a valid Kenyan mobile number" };

    const shillings = toWholeShillings(input.amountCents);
    if (shillings === null) return { ok: false, error: "KCB Buni takes whole shillings only" };

    const token = await kcbToken(env);
    if (!token) return { ok: false, error: "Could not authenticate with KCB Buni" };

    const res = await postJson(
      `${kcbBase(env)}/mm/api/request/1.0.0/stkpush`,
      {
        phoneNumber: msisdn,
        amount: shillings,
        invoiceNumber: input.reference,
        sharedShortCode: true,
        till: env("KCB_TILL_NUMBER"),
        callbackUrl: input.callbackUrl,
        description: input.description,
      },
      { Authorization: `Bearer ${token}` },
    );

    const json = res.json as
      | { transactionId?: string; header?: { statusCode?: number; statusMessage?: string } }
      | null;

    if (res.status === 401) tokenCache.delete(`kcb:${cacheKeyFor(env("KCB_CONSUMER_KEY") ?? "")}`);
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

  async verify(providerRef, creds) {
    const env = credsFor(creds);
    if (!this.configured(creds)) {
      return { status: "PENDING", failureReason: "KCB Buni not configured", authError: true };
    }

    const token = await kcbToken(env);
    if (!token) return { status: "PENDING", failureReason: "Could not authenticate with KCB Buni", authError: true };

    const res = await getJson(
      `${kcbBase(env)}/mm/api/request/1.0.0/transaction/${encodeURIComponent(providerRef)}`,
      { Authorization: `Bearer ${token}` },
    );
    if (res.status === 401) {
      tokenCache.delete(`kcb:${cacheKeyFor(env("KCB_CONSUMER_KEY") ?? "")}`);
      return { status: "PENDING", authError: true, code: "401", failureReason: "KCB Buni rejected the access token" };
    }
    const json = res.json as
      | { status?: string; receiptNumber?: string; resultDesc?: string; amount?: number | string }
      | null;

    const state = (json?.status ?? "").toUpperCase();
    const amount = json?.amount == null ? undefined : Number(json.amount);
    if (state === "SUCCESS" || state === "COMPLETED") {
      return {
        status: "SUCCEEDED",
        code: state,
        receiptRef: json?.receiptNumber,
        amountCents: amount != null && Number.isFinite(amount) ? Math.round(amount * 100) : undefined,
        raw: json,
      };
    }
    if (state === "FAILED" || state === "CANCELLED" || state === "REJECTED") {
      return { status: "FAILED", code: state, failureReason: json?.resultDesc ?? state, raw: json };
    }
    return { status: "PENDING", code: state || String(res.status), raw: json };
  },

  /**
   * Buni signs callbacks with a shared secret in `x-buni-signature` when one is
   * configured on the app. Where the tenant has not set one, the callback is
   * treated as a hint and confirmed by an explicit query, exactly as Daraja is.
   */
  verifyWebhook(rawBody, headers, creds) {
    const secret = credsFor(creds)("KCB_WEBHOOK_SECRET");
    if (!secret) return true; // unsigned: confirmed by query before booking
    const signature = headers.get("x-buni-signature");
    if (!signature) return false;

    const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
    const a = Buffer.from(expected, "utf8");
    const b = Buffer.from(signature, "utf8");
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  },

  async testCredentials(creds) {
    const env = credsFor(creds);
    const missing = REQUIRED_KEYS.KCB_BUNI.filter((k) => !env(k));
    if (missing.length > 0) return { ok: false, note: `Keys missing: ${missing.join(", ")}` };
    tokenCache.delete(`kcb:${cacheKeyFor(env("KCB_CONSUMER_KEY") ?? "")}`);
    try {
      const token = await kcbToken(env);
      return token
        ? { ok: true, note: "Authenticated with KCB Buni (access token issued)" }
        : { ok: false, note: "KCB Buni refused the consumer key / secret" };
    } catch (error) {
      return { ok: false, note: `KCB Buni unreachable: ${(error as Error).message}` };
    }
  },
};

function kcbBase(env: EnvReader) {
  return hostFor(
    env,
    "KCB_BASE_URL",
    env("KCB_ENV") === "production" ? "https://api.buni.kcbgroup.com" : "https://uat.buni.kcbgroup.com",
  );
}

async function kcbToken(env: EnvReader): Promise<string | null> {
  const key = env("KCB_CONSUMER_KEY");
  const secret = env("KCB_CONSUMER_SECRET");
  if (!key || !secret) return null;

  return cachedToken(`kcb:${cacheKeyFor(key)}`, async () => {
    const basic = Buffer.from(`${key}:${secret}`).toString("base64");
    const res = await request(`${kcbBase(env)}/token?grant_type=client_credentials`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });
    if (!res.ok) return null;
    const json = res.json as { access_token?: string; expires_in?: string | number } | null;
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
 * Which gateways a given company can actually use.
 *
 * The console and the mobile app both read this, so a rep is never offered a
 * method that will fail the moment they tap it — the commonest way a payment
 * feature loses trust on day one. Pass the company's resolved credentials;
 * omitting them reports what the environment alone supports.
 */
export function availableProviders(
  credsByProvider?: Partial<Record<PaymentProviderName, Creds>>,
) {
  return PAYMENT_PROVIDERS.map((p) => ({
    ...p,
    requiredKeys: REQUIRED_KEYS[p.name],
    configured: PROVIDERS[p.name].configured(credsByProvider?.[p.name]),
  }));
}
