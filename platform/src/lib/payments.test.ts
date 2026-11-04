import assert from "node:assert/strict";
import crypto from "node:crypto";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  baseUrlProblem,
  credsFor,
  darajaPassword,
  darajaTimestamp,
  darajaVerdict,
  parseDarajaCallback,
  paystackEventKind,
  providerFor,
  ProviderTransportError,
  rateLimiter,
  resetTokenCache,
  stripPaystack,
  testCredentialProblem,
  toDarajaMsisdn,
  toWholeShillings,
} from "./payments";

/**
 * The pure parts of the gateway adapters, plus the two transport behaviours
 * that matter for money — the token cache being evicted on a 401, and a lost
 * connection being reported as "sent" or "not sent" — exercised against a
 * stubbed `fetch`. No network, no database.
 */

type FetchStub = (url: string, init?: RequestInit) => Promise<Response> | Response;

const realFetch = globalThis.fetch;
const realEnv = { ...process.env };

function stubFetch(fn: FetchStub) {
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(fn(String(url), init))) as typeof fetch;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const DARAJA_ENV = {
  MPESA_CONSUMER_KEY: "ck",
  MPESA_CONSUMER_SECRET: "cs",
  MPESA_SHORTCODE: "174379",
  MPESA_PASSKEY: "pass",
  MPESA_ENV: "sandbox",
};

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of Object.keys(process.env)) if (!(k in realEnv)) delete process.env[k];
  Object.assign(process.env, realEnv);
  resetTokenCache();
});

describe("msisdn normalisation", () => {
  it("accepts every local spelling of a Kenyan mobile number", () => {
    for (const raw of ["0712345678", "+254712345678", "254712345678", "712345678", "0712 345 678", "+254 (712) 345-678"]) {
      assert.equal(toDarajaMsisdn(raw), "254712345678", raw);
    }
    assert.equal(toDarajaMsisdn("0112345678"), "254112345678");
  });
  it("refuses anything that is not a 12-digit 254 number", () => {
    for (const raw of ["", "12345", "+447700900123", "07123456789", "abc"]) {
      assert.equal(toDarajaMsisdn(raw), null, raw);
    }
  });
});

describe("daraja timestamp and password", () => {
  it("formats YYYYMMDDHHmmss in Nairobi time", () => {
    // 2026-11-04T21:30:05Z is 2026-11-05 00:30:05 in Nairobi.
    assert.equal(darajaTimestamp(new Date("2026-11-04T21:30:05Z")), "20261105003005");
    assert.match(darajaTimestamp(), /^\d{14}$/);
  });
  it("builds the password as base64(shortcode+passkey+timestamp)", () => {
    const ts = "20261105003005";
    assert.equal(darajaPassword("174379", "pk", ts), Buffer.from(`174379pk${ts}`).toString("base64"));
  });
});

describe("amount rounding rule", () => {
  it("accepts whole shillings only", () => {
    assert.equal(toWholeShillings(125_000), 1250);
    assert.equal(toWholeShillings(100), 1);
    assert.equal(toWholeShillings(125_050), null, "cents are refused, not rounded");
    assert.equal(toWholeShillings(0), null);
    assert.equal(toWholeShillings(-100), null);
    assert.equal(toWholeShillings(10.5), null);
  });
});

describe("daraja status mapping", () => {
  const ok = (ResultCode: string | number, ResultDesc = "x") => ({ ResponseCode: "0", ResultCode, ResultDesc });

  it("treats the still-processing answers as PENDING", () => {
    assert.equal(darajaVerdict(500, { requestId: "r", errorCode: "500.001.1001", errorMessage: "The transaction is being processed" }).status, "PENDING");
    assert.equal(darajaVerdict(200, ok("4999")).status, "PENDING");
    assert.equal(darajaVerdict(200, ok(4999)).status, "PENDING");
    assert.equal(darajaVerdict(200, { ResponseCode: "0", ResponseDescription: "accepted" }).status, "PENDING", "missing ResultCode");
    assert.equal(darajaVerdict(200, ok("")).status, "PENDING", "empty ResultCode");
    assert.equal(darajaVerdict(200, null).status, "PENDING");
  });

  it("maps success and the terminal failures with human reasons", () => {
    assert.equal(darajaVerdict(200, ok("0")).status, "SUCCEEDED");
    assert.equal(darajaVerdict(200, ok(0)).status, "SUCCEEDED");
    const cases: Array<[string, RegExp]> = [
      ["1032", /cancelled by the customer/i],
      ["1037", /no response from the customer's phone/i],
      ["1", /insufficient/i],
      ["2001", /wrong m-pesa pin/i],
      ["1019", /expired/i],
    ];
    for (const [code, re] of cases) {
      const v = darajaVerdict(200, ok(code, "Daraja says"));
      assert.equal(v.status, "FAILED", code);
      assert.equal(v.code, code);
      assert.match(v.failureReason ?? "", re, code);
    }
    const unknown = darajaVerdict(200, ok("1234", "Something odd"));
    assert.equal(unknown.status, "FAILED");
    assert.equal(unknown.failureReason, "Something odd");
  });

  it("reports credential problems as authError without failing the transaction", () => {
    const a = darajaVerdict(401, { errorMessage: "Unauthorized" });
    assert.equal(a.status, "PENDING");
    assert.equal(a.authError, true);
    const b = darajaVerdict(404, { requestId: "r", errorCode: "404.001.03", errorMessage: "Invalid Access Token" });
    assert.equal(b.status, "PENDING");
    assert.equal(b.authError, true);
  });

  it("keeps an unknown CheckoutRequestID pending, with its code, for the credential test", () => {
    const v = darajaVerdict(400, { requestId: "r", errorCode: "400.002.02", errorMessage: "Bad Request - Invalid CheckoutRequestID" });
    assert.equal(v.status, "PENDING");
    assert.equal(v.code, "400.002.02");
    assert.equal(v.authError, undefined);
  });
});

describe("daraja callback parsing", () => {
  it("reads ResultCode, amount, receipt, phone and date from Body.stkCallback", () => {
    const cb = parseDarajaCallback({
      Body: {
        stkCallback: {
          MerchantRequestID: "29115-34620561-1",
          CheckoutRequestID: "ws_CO_191220191020363925",
          ResultCode: 0,
          ResultDesc: "The service request is processed successfully.",
          CallbackMetadata: {
            Item: [
              { Name: "Amount", Value: 1250 },
              { Name: "MpesaReceiptNumber", Value: "NLJ7RT61SV" },
              { Name: "TransactionDate", Value: 20191219102115 },
              { Name: "PhoneNumber", Value: 254708374149 },
            ],
          },
        },
      },
    });
    assert.ok(cb);
    assert.equal(cb.checkoutRequestId, "ws_CO_191220191020363925");
    assert.equal(cb.resultCode, "0");
    assert.equal(cb.amountCents, 125_000);
    assert.equal(cb.receiptRef, "NLJ7RT61SV");
    assert.equal(cb.phone, "254708374149");
    assert.equal(cb.transactionDate, "20191219102115");
  });
  it("handles a failure callback with no metadata, and rejects other shapes", () => {
    const cb = parseDarajaCallback({ Body: { stkCallback: { CheckoutRequestID: "ws_CO_1", ResultCode: 1032, ResultDesc: "Request cancelled by user" } } });
    assert.equal(cb?.resultCode, "1032");
    assert.equal(cb?.amountCents, undefined);
    assert.equal(parseDarajaCallback({ Body: {} }), null);
    assert.equal(parseDarajaCallback({ data: { reference: "x" } }), null);
    assert.equal(parseDarajaCallback(null), null);
  });
});

describe("webhook HMAC checks", () => {
  const paystack = providerFor("PAYSTACK")!;
  const kcb = providerFor("KCB_BUNI")!;
  const body = JSON.stringify({ event: "charge.success", data: { reference: "abc" } });

  it("accepts a Paystack body signed with the tenant's secret and nothing else", () => {
    const creds = { PAYSTACK_SECRET_KEY: "sk_test_abc" };
    const sig = crypto.createHmac("sha512", "sk_test_abc").update(body).digest("hex");
    assert.equal(paystack.verifyWebhook(body, new Headers({ "x-paystack-signature": sig }), creds), true);
    assert.equal(paystack.verifyWebhook(body, new Headers({ "x-paystack-signature": sig.replace(/^./, "0") }), creds), false);
    assert.equal(paystack.verifyWebhook(body, new Headers(), creds), false);
    assert.equal(paystack.verifyWebhook(body + " ", new Headers({ "x-paystack-signature": sig }), creds), false, "exact bytes");
    assert.equal(paystack.verifyWebhook(body, new Headers({ "x-paystack-signature": sig }), { PAYSTACK_SECRET_KEY: "other" }), false);
  });

  it("KCB: unsigned when no secret is configured, strict when one is", () => {
    assert.equal(kcb.verifyWebhook(body, new Headers(), { KCB_CONSUMER_KEY: "k" }), true);
    const sig = crypto.createHmac("sha256", "whs").update(body).digest("hex");
    assert.equal(kcb.verifyWebhook(body, new Headers({ "x-buni-signature": sig }), { KCB_WEBHOOK_SECRET: "whs" }), true);
    assert.equal(kcb.verifyWebhook(body, new Headers(), { KCB_WEBHOOK_SECRET: "whs" }), false);
    assert.equal(kcb.verifyWebhook(body, new Headers({ "x-buni-signature": "00" }), { KCB_WEBHOOK_SECRET: "whs" }), false);
  });
});

describe("credsFor isolation", () => {
  it("uses only the tenant bundle when one exists, even for keys it lacks", () => {
    process.env.PAYSTACK_SECRET_KEY = "sk_live_platform";
    process.env.PAYSTACK_PUBLIC_KEY = "pk_live_platform";
    const get = credsFor({ PAYSTACK_SECRET_KEY: "sk_live_tenant" });
    assert.equal(get("PAYSTACK_SECRET_KEY"), "sk_live_tenant");
    assert.equal(get("PAYSTACK_PUBLIC_KEY"), undefined, "no fallback to the platform's public key");
  });
  it("falls back to the environment only when there is no bundle at all", () => {
    process.env.PAYSTACK_SECRET_KEY = "sk_live_platform";
    assert.equal(credsFor(null)("PAYSTACK_SECRET_KEY"), "sk_live_platform");
    assert.equal(credsFor(undefined)("PAYSTACK_SECRET_KEY"), "sk_live_platform");
    assert.equal(credsFor({})("PAYSTACK_SECRET_KEY"), undefined, "an empty bundle is still a bundle");
  });
  it("a tenant missing one Daraja key is not configured — it does not borrow the platform's", () => {
    Object.assign(process.env, DARAJA_ENV);
    const daraja = providerFor("MPESA_DARAJA")!;
    assert.equal(daraja.configured(undefined), true, "platform credentials alone");
    assert.equal(daraja.configured({ ...DARAJA_ENV, MPESA_PASSKEY: "" }), false);
  });
});

describe("tenant-settable hosts and test keys", () => {
  it("allows only the official hosts over https unless the deployment opts in", () => {
    assert.equal(baseUrlProblem("PAYSTACK_BASE_URL", "https://api.paystack.co"), null);
    assert.equal(baseUrlProblem("MPESA_BASE_URL", "https://sandbox.safaricom.co.ke/"), null);
    assert.equal(baseUrlProblem("KCB_BASE_URL", "https://uat.buni.kcbgroup.com"), null);
    assert.match(baseUrlProblem("PAYSTACK_BASE_URL", "https://evil.example.com") ?? "", /may only point at api\.paystack\.co/);
    assert.match(baseUrlProblem("MPESA_BASE_URL", "http://api.safaricom.co.ke") ?? "", /https/);
    assert.match(baseUrlProblem("MPESA_BASE_URL", "not a url") ?? "", /not a valid URL/);
    assert.equal(baseUrlProblem("MPESA_ENV", "anything"), null, "only base-url keys are checked");
    process.env.PAYMENTS_ALLOW_CUSTOM_HOSTS = "1";
    assert.equal(baseUrlProblem("PAYSTACK_BASE_URL", "http://127.0.0.1:4720"), null);
  });
  it("refuses test keys and sandbox on a production deployment", () => {
    (process.env as Record<string, string>).NODE_ENV = "production";
    delete process.env.PAYMENTS_ALLOW_TEST_KEYS;
    assert.match(testCredentialProblem("PAYSTACK", { PAYSTACK_SECRET_KEY: "sk_test_abc" }) ?? "", /test key/);
    assert.equal(testCredentialProblem("PAYSTACK", { PAYSTACK_SECRET_KEY: "sk_live_abc" }), null);
    assert.match(testCredentialProblem("MPESA_DARAJA", { MPESA_ENV: "sandbox" }) ?? "", /sandbox/);
    assert.equal(testCredentialProblem("MPESA_DARAJA", { MPESA_ENV: "production" }), null);
    process.env.PAYMENTS_ALLOW_TEST_KEYS = "1";
    assert.equal(testCredentialProblem("PAYSTACK", { PAYSTACK_SECRET_KEY: "sk_test_abc" }), null);
    (process.env as Record<string, string>).NODE_ENV = "development";
    delete process.env.PAYMENTS_ALLOW_TEST_KEYS;
    assert.equal(testCredentialProblem("PAYSTACK", { PAYSTACK_SECRET_KEY: "sk_test_abc" }), null, "dev may use test keys");
  });
});

describe("paystack helpers", () => {
  it("filters webhook events to charge.* and refund.*", () => {
    assert.equal(paystackEventKind({ event: "charge.success" }), "charge.success");
    assert.equal(paystackEventKind({ event: "charge.failed" }), "charge.failed");
    assert.equal(paystackEventKind({ event: "refund.processed" }), "refund");
    assert.equal(paystackEventKind({ event: "transfer.success" }), null);
    assert.equal(paystackEventKind({ event: "customeridentification.success" }), null);
    assert.equal(paystackEventKind({}), null);
  });
  it("strips the authorization and customer objects before anything is stored", () => {
    const stripped = stripPaystack({
      status: "success",
      amount: 5000,
      currency: "KES",
      reference: "r1",
      channel: "card",
      paid_at: "2026-11-04T10:00:00Z",
      gateway_response: "Successful",
      customer: { email: "payer@example.com" },
      authorization: { last4: "4081", bin: "408408" },
    })!;
    assert.deepEqual(Object.keys(stripped).sort(), ["amount", "channel", "currency", "gateway_response", "paid_at", "reference", "status"]);
    assert.ok(!JSON.stringify(stripped).includes("payer@example.com"));
    assert.ok(!JSON.stringify(stripped).includes("4081"));
  });
  it("reports a 401 from verify as an authentication problem and 'reversed' as REVERSED", async () => {
    const paystack = providerFor("PAYSTACK")!;
    stubFetch(() => json(401, { status: false, message: "Invalid key" }));
    const a = await paystack.verify("r1", { PAYSTACK_SECRET_KEY: "sk_test_x" });
    assert.equal(a.status, "PENDING");
    assert.equal(a.authError, true);
    stubFetch(() => json(200, { status: true, data: { status: "reversed", amount: 5000, currency: "KES", reference: "r1" } }));
    const b = await paystack.verify("r1", { PAYSTACK_SECRET_KEY: "sk_test_x" });
    assert.equal(b.status, "REVERSED");
    stubFetch(() => json(200, { status: true, data: { status: "success", amount: 5000, currency: "NGN", reference: "r1" } }));
    const c = await paystack.verify("r1", { PAYSTACK_SECRET_KEY: "sk_test_x" });
    assert.equal(c.status, "FAILED", "wrong currency never settles");
    assert.match(c.failureReason ?? "", /NGN/);
  });
});

describe("rate limiter", () => {
  it("allows a burst up to capacity, then refills over time", () => {
    const allow = rateLimiter(5, 5 / 60);
    const t0 = 1_000_000;
    for (let i = 0; i < 5; i++) assert.equal(allow("u1", t0), true, `call ${i}`);
    assert.equal(allow("u1", t0), false, "sixth call in the same minute");
    assert.equal(allow("u2", t0), true, "another key has its own bucket");
    assert.equal(allow("u1", t0 + 12_000), true, "one token back after 12 s");
    assert.equal(allow("u1", t0 + 12_000), false);
  });
});

describe("daraja transport", () => {
  beforeEach(() => {
    Object.assign(process.env, DARAJA_ENV);
    process.env.MPESA_BASE_URL = "http://mock.local";
  });

  it("evicts the cached token on 401 and retries once with a fresh one", async () => {
    const daraja = providerFor("MPESA_DARAJA")!;
    const calls: string[] = [];
    let tokens = 0;
    stubFetch((url, init) => {
      calls.push(url.replace("http://mock.local", ""));
      if (url.includes("/oauth/")) return json(200, { access_token: `tok${++tokens}`, expires_in: "3599" });
      const auth = (init?.headers as Record<string, string>).Authorization;
      if (auth === "Bearer tok1") return json(404, { requestId: "r", errorCode: "404.001.03", errorMessage: "Invalid Access Token" });
      return json(200, { ResponseCode: "0", ResultCode: "0", ResultDesc: "ok" });
    });
    const v = await daraja.verify("ws_CO_1", undefined);
    assert.equal(v.status, "SUCCEEDED");
    assert.deepEqual(calls, [
      "/oauth/v1/generate?grant_type=client_credentials",
      "/mpesa/stkpushquery/v1/query",
      "/oauth/v1/generate?grant_type=client_credentials",
      "/mpesa/stkpushquery/v1/query",
    ]);
    // The fresh token is now cached: another verify mints nothing.
    stubFetch((url) => (url.includes("/oauth/") ? json(500, {}) : json(200, { ResultCode: "0" })));
    const again = await daraja.verify("ws_CO_1", undefined);
    assert.equal(again.status, "SUCCEEDED");
  });

  it("keeps AccountReference within 12 and TransactionDesc within 13 characters and whole-shilling amounts", async () => {
    const daraja = providerFor("MPESA_DARAJA")!;
    let pushed: Record<string, unknown> | null = null;
    stubFetch((url, init) => {
      if (url.includes("/oauth/")) return json(200, { access_token: "t", expires_in: "3599" });
      pushed = JSON.parse(String(init?.body));
      return json(200, { CheckoutRequestID: "ws_CO_42", ResponseDescription: "Success" });
    });
    const r = await daraja.initiate(
      { amountCents: 125_000, currency: "KES", reference: "cmh0abcdefghijklmnop", payerPhone: "0712345678", description: "Payment from A Very Long Customer Name", callbackUrl: "https://raut.test/cb" },
      undefined,
    );
    assert.equal(r.ok, true);
    assert.equal(r.providerRef, "ws_CO_42");
    assert.equal(String(pushed!.AccountReference).length, 12);
    assert.equal(String(pushed!.TransactionDesc).length, 13);
    assert.equal(pushed!.Amount, 1250);
    assert.equal(pushed!.PhoneNumber, "254712345678");
    const cents = await daraja.initiate(
      { amountCents: 125_050, currency: "KES", reference: "x", payerPhone: "0712345678", description: "d", callbackUrl: "https://raut.test/cb" },
      undefined,
    );
    assert.equal(cents.ok, false);
    assert.match(cents.error ?? "", /whole shillings/);
  });

  it("distinguishes a provider it never reached from one that may have acted", async () => {
    const daraja = providerFor("MPESA_DARAJA")!;
    const input = { amountCents: 100, currency: "KES", reference: "x", payerPhone: "0712345678", description: "d", callbackUrl: "https://raut.test/cb" };

    stubFetch((url) => {
      if (url.includes("/oauth/")) return json(200, { access_token: "t", expires_in: "3599" });
      return Promise.reject(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }));
    });
    await assert.rejects(daraja.initiate(input, undefined), (e: unknown) => e instanceof ProviderTransportError && e.sent === false);

    resetTokenCache();
    stubFetch((url) => {
      if (url.includes("/oauth/")) return json(200, { access_token: "t", expires_in: "3599" });
      return Promise.reject(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } }));
    });
    await assert.rejects(daraja.initiate(input, undefined), (e: unknown) => e instanceof ProviderTransportError && e.sent === true);

    // A hang is cut off by the timeout and counts as "may have been sent".
    resetTokenCache();
    process.env.PAYMENTS_TIMEOUT_MS = "60";
    stubFetch((url, init) => {
      if (url.includes("/oauth/")) return json(200, { access_token: "t", expires_in: "3599" });
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      });
    });
    const started = Date.now();
    await assert.rejects(daraja.initiate(input, undefined), (e: unknown) => e instanceof ProviderTransportError && e.sent === true && e.causeCode === "ETIMEDOUT");
    assert.ok(Date.now() - started < 2_000, "the timeout fired, not the test runner's");
  });

  it("credential test: an unknown CheckoutRequestID is proof the key works; a token refusal is not", async () => {
    const daraja = providerFor("MPESA_DARAJA")!;
    stubFetch((url) => {
      if (url.includes("/oauth/")) return json(200, { access_token: "t", expires_in: "3599" });
      return json(400, { requestId: "r", errorCode: "400.002.02", errorMessage: "Bad Request - Invalid CheckoutRequestID" });
    });
    const good = await daraja.testCredentials(DARAJA_ENV);
    assert.equal(good.ok, true, good.note);
    assert.match(good.note, /Authenticated/);

    resetTokenCache();
    stubFetch((url) => (url.includes("/oauth/") ? json(400, { errorCode: "400.008.01", errorMessage: "Invalid Authentication passed" }) : json(200, {})));
    const bad = await daraja.testCredentials(DARAJA_ENV);
    assert.equal(bad.ok, false);
    assert.match(bad.note, /refused the consumer key/);
  });

  it("Paystack credential test: 400/404 'not found' with a valid key passes, 401 fails", async () => {
    const paystack = providerFor("PAYSTACK")!;
    process.env.PAYSTACK_BASE_URL = "http://mock.local";
    stubFetch(() => json(404, { status: false, message: "Transaction reference not found" }));
    const good = await paystack.testCredentials({ PAYSTACK_SECRET_KEY: "sk_live_ok" });
    assert.equal(good.ok, true, good.note);
    stubFetch(() => json(401, { status: false, message: "Invalid key" }));
    const bad = await paystack.testCredentials({ PAYSTACK_SECRET_KEY: "sk_live_bad" });
    assert.equal(bad.ok, false);
    assert.match(bad.note, /401/);
  });
});
