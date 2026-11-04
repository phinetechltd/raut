import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, afterEach, before, describe, it } from "node:test";

/**
 * Gateway collections against a throwaway copy of the dev database, with
 * `fetch` stubbed so the Daraja adapter talks to a scripted provider.
 *
 * DATABASE_URL is pointed at the copy before any module is imported, because
 * `@/lib/db` builds its PrismaClient at import time. prisma/xos.db is never
 * touched. The Daraja credentials come from the environment (no tenant bundle
 * is stored), which is the platform-account path.
 */
const dir = mkdtempSync(path.join(tmpdir(), "xos-collections-"));
const file = path.join(dir, "xos.db");
copyFileSync(path.resolve(__dirname, "../../prisma/xos.db"), file);
process.env.DATABASE_URL = `file:${file.split(path.sep).join("/")}`;
Object.assign(process.env, {
  MPESA_CONSUMER_KEY: "ck",
  MPESA_CONSUMER_SECRET: "cs",
  MPESA_SHORTCODE: "174379",
  MPESA_PASSKEY: "pass",
  MPESA_ENV: "sandbox",
  MPESA_BASE_URL: "http://daraja.mock",
  PAYSTACK_SECRET_KEY: "sk_test_platform",
  PAYSTACK_BASE_URL: "http://paystack.mock",
  SMS_PROVIDER: "console",
  PAYMENTS_TIMEOUT_MS: "500",
});
delete process.env.CREDENTIALS_KEY;

type Sales = typeof import("./sales");
type Collections = typeof import("./collections");
type Payments = typeof import("@/lib/payments");
type Db = typeof import("@/lib/db")["db"];

let sales: Sales;
let collections: Collections;
let payments: Payments;
let db: Db;

let companyId: string;
let otherCompanyId: string;
let userId: string | null;
let seq = 0;

const realFetch = globalThis.fetch;
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A scripted Daraja: OAuth always works; the STK endpoints answer as told. */
function daraja(script: {
  push?: () => Response | Promise<Response>;
  query?: (body: Record<string, unknown>) => Response;
}) {
  const seen: Array<{ url: string; body: unknown }> = [];
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    seen.push({ url: u, body });
    const answer = (): Promise<Response> => {
      if (u.includes("/oauth/")) return Promise.resolve(json(200, { access_token: "tok", expires_in: "3599" }));
      if (u.includes("/stkpush/")) return Promise.resolve(script.push ? script.push() : json(200, { CheckoutRequestID: `ws_CO_${Date.now()}_${seq++}`, ResponseDescription: "Success" }));
      if (u.includes("/stkpushquery/")) return Promise.resolve(script.query ? script.query(body) : json(500, { errorCode: "500.001.1001", errorMessage: "processing" }));
      return Promise.resolve(json(404, {}));
    };
    // Like the real fetch, an aborted signal rejects with an AbortError even
    // if the scripted answer never comes.
    return new Promise<Response>((resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      answer().then(resolve, reject);
    });
  }) as typeof fetch;
  return seen;
}

async function newCustomer(company = companyId, phone: string | null = "0712345678") {
  seq++;
  return db.customer.create({
    data: {
      companyId: company,
      code: `COL-${Date.now()}-${seq}`,
      name: `Collections test customer ${seq}`,
      phone,
      paymentTermsDays: 30,
    },
  });
}

async function processingIntent(customerId: string, extra: Record<string, unknown> = {}) {
  return db.paymentIntent.create({
    data: {
      companyId,
      customerId,
      provider: "MPESA_DARAJA",
      amountCents: 25_000,
      status: "PROCESSING",
      providerRef: `ws_CO_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      payerPhone: "254712345678",
      ...extra,
    },
  });
}

const succeeded = async () => ({ status: "SUCCEEDED" as const, receiptRef: "QWE123XYZ9" });

const rejects = (p: Promise<unknown>, status: number, pattern?: RegExp) =>
  assert.rejects(p, (error: unknown) => {
    const e = error as { status?: number; message: string };
    assert.equal(e.status, status, `expected ${status}, got ${e.status}: ${e.message}`);
    if (pattern) assert.match(e.message, pattern);
    return true;
  });

describe("collections", () => {
  before(async () => {
    ({ db } = await import("@/lib/db"));
    sales = await import("./sales");
    collections = await import("./collections");
    payments = await import("@/lib/payments");

    const tari = await db.company.findUniqueOrThrow({ where: { slug: "tari" } });
    companyId = tari.id;
    const other = await db.company.create({
      data: { name: "Other Tenant", slug: `other-col-${Date.now()}`, status: "ACTIVE" },
    });
    otherCompanyId = other.id;
    const user = await db.user.findFirst({ where: { companyId }, select: { id: true } });
    userId = user?.id ?? null;
    // The receipt SMS path needs the SMS module licensed.
    await db.companyModule.upsert({
      where: { companyId_moduleKey: { companyId, moduleKey: "SMS" } },
      update: { enabled: true },
      create: { companyId, moduleKey: "SMS", enabled: true },
    });
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    payments.resetTokenCache();
  });

  after(async () => {
    await db.$disconnect();
    rmSync(dir, { recursive: true, force: true });
  });

  const base = { provider: "MPESA_DARAJA" as const, amountCents: 25_000, baseUrl: "https://raut.test", createdById: null };

  // ── initiateCollection: orphans and transport ─────────────────────────

  describe("initiateCollection", () => {
    it("fails the intent outright when the provider was never reached", async () => {
      const c = await newCustomer();
      daraja({ push: () => Promise.reject(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } })) });
      const intent = await collections.initiateCollection({ ...base, companyId, customerId: c.id });
      assert.equal(intent.status, "FAILED");
      assert.match(intent.failureReason ?? "", /^provider unreachable/);
      assert.equal(intent.providerRef, null);
    });

    it("keeps the intent live under a lookup key when the answer was lost after sending", async () => {
      const c = await newCustomer();
      daraja({ push: () => Promise.reject(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } })) });
      const intent = await collections.initiateCollection({ ...base, companyId, customerId: c.id });
      assert.equal(intent.status, "PROCESSING");
      assert.equal(intent.providerRef, `lookup:${intent.id}`);
      assert.ok(collections.isLookupRef(intent.providerRef));

      // Nothing can be verified for it yet; a poll leaves it as it is.
      daraja({ query: () => json(200, { ResultCode: "0" }) });
      const polled = await collections.settleIntent(intent.id);
      assert.equal(polled.status, "PROCESSING", "Daraja cannot be asked without a CheckoutRequestID");
      assert.equal(await db.payment.count({ where: { customerId: c.id } }), 0);
    });

    it("a timeout counts as 'may have been sent'", async () => {
      const c = await newCustomer();
      process.env.PAYMENTS_TIMEOUT_MS = "60";
      daraja({
        push: () => new Promise<Response>(() => {
          /* never answers; the AbortSignal ends it */
        }),
      });
      const intent = await collections.initiateCollection({ ...base, companyId, customerId: c.id });
      process.env.PAYMENTS_TIMEOUT_MS = "500";
      assert.equal(intent.status, "PROCESSING");
      assert.ok(collections.isLookupRef(intent.providerRef));
      assert.match(intent.providerPayload ?? "", /did not answer/);
    });

    it("refuses an amount with cents for a whole-shilling provider", async () => {
      const c = await newCustomer();
      daraja({});
      await rejects(collections.initiateCollection({ ...base, companyId, customerId: c.id, amountCents: 25_050 }), 422, /whole shillings/);
      assert.equal(await db.paymentIntent.count({ where: { customerId: c.id } }), 0, "nothing persisted");
    });

    it("replays a clientUuid only within the same company", async () => {
      const c = await newCustomer();
      daraja({});
      const uuid = `col-replay-${Date.now()}`;
      const first = await collections.initiateCollection({ ...base, companyId, customerId: c.id, clientUuid: uuid });
      assert.equal(first.status, "PROCESSING");
      const again = await collections.initiateCollection({ ...base, companyId, customerId: c.id, clientUuid: uuid });
      assert.equal(again.id, first.id, "same intent, no second push");
      assert.equal(await db.paymentIntent.count({ where: { clientUuid: uuid } }), 1);

      const foreign = await newCustomer(otherCompanyId);
      await rejects(
        collections.initiateCollection({ ...base, companyId: otherCompanyId, customerId: foreign.id, clientUuid: uuid }),
        409,
      );
    });

    it("stores the Paystack redirect URL and never returns payload or company in the DTO", async () => {
      const c = await newCustomer(companyId, null);
      globalThis.fetch = (async () =>
        json(200, { status: true, data: { authorization_url: "https://checkout.paystack.com/abc", access_code: "abc", reference: "ignored" } })) as typeof fetch;
      const intent = await collections.initiateCollection({
        ...base,
        provider: "PAYSTACK",
        amountCents: 25_050,
        companyId,
        customerId: c.id,
        payerEmail: "payer@example.com",
      });
      assert.equal(intent.status, "PROCESSING");
      assert.equal(intent.redirectUrl, "https://checkout.paystack.com/abc");
      const dto = collections.toPublicIntent(intent) as unknown as Record<string, unknown>;
      assert.equal(dto.redirectUrl, "https://checkout.paystack.com/abc");
      assert.equal("providerPayload" in dto, false);
      assert.equal("companyId" in dto, false);
      assert.equal("payerEmail" in dto, false);
      assert.deepEqual(
        Object.keys(dto).sort(),
        ["amountCents", "completedAt", "createdAt", "currency", "failureReason", "id", "paymentId", "provider", "receiptRef", "redirectUrl", "status"],
      );
    });
  });

  // ── settleIntent ──────────────────────────────────────────────────────

  describe("settleIntent", () => {
    it("books exactly one payment when a callback and a poll settle at once", async () => {
      const c = await newCustomer();
      const intent = await processingIntent(c.id);
      const results = await Promise.all([
        collections.settleIntent(intent.id, { verify: succeeded }),
        collections.settleIntent(intent.id, { verify: succeeded }),
        collections.settleIntent(intent.id, { verify: succeeded }),
      ]);
      const booked = await db.payment.findMany({ where: { customerId: c.id } });
      assert.equal(booked.length, 1);
      assert.equal(booked[0].method, "MPESA_STK");
      assert.equal(booked[0].reference, "QWE123XYZ9", "the receipt is the payment's reference");
      assert.equal(booked[0].clientUuid, collections.intentClientUuid(intent.id));
      for (const r of results) assert.ok(["SUCCEEDED", "SETTLING"].includes(r.status));
      const final = await db.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } });
      assert.equal(final.status, "SUCCEEDED");
      assert.equal(final.paymentId, booked[0].id);
    });

    it("refuses to settle when the provider's amount differs, and audits it", async () => {
      const c = await newCustomer();
      const intent = await processingIntent(c.id);
      const r = await collections.settleIntent(intent.id, {
        verify: async () => ({ status: "SUCCEEDED", amountCents: 20_000, receiptRef: "SHORT1" }),
      });
      assert.equal(r.status, "FAILED");
      assert.match(r.failureReason ?? "", /^amount mismatch/);
      assert.equal(await db.payment.count({ where: { customerId: c.id } }), 0);
      const trail = await db.auditLog.findFirst({ where: { entity: "PaymentIntent", entityId: intent.id, action: "PAYMENT_FAILED" } });
      assert.ok(trail, "audited");
      assert.match(trail.changes ?? "", /amount mismatch/);
    });

    it("compares the callback's amount when the provider's verify carries none (Daraja)", async () => {
      const c = await newCustomer();
      const intent = await processingIntent(c.id);
      const r = await collections.settleIntent(intent.id, {
        verify: async () => ({ status: "SUCCEEDED" }),
        hint: { resultCode: "0", amountCents: 24_900, receiptRef: "R1" },
      });
      assert.equal(r.status, "FAILED");
      assert.match(r.failureReason ?? "", /amount mismatch/);
    });

    it("takes the receipt from the callback once verify agrees, and sends the receipt SMS", async () => {
      const c = await newCustomer();
      const intent = await processingIntent(c.id);
      const smsBefore = await db.smsMessage.count({ where: { customerId: c.id, templateKey: "PAYMENT_RECEIPT" } });
      const r = await collections.settleIntent(intent.id, {
        verify: async () => ({ status: "SUCCEEDED" }),
        hint: { resultCode: "0", amountCents: 25_000, receiptRef: "NLJ7RT61SV" },
      });
      assert.equal(r.status, "SUCCEEDED");
      assert.equal(r.receiptRef, "NLJ7RT61SV");
      const payment = await db.payment.findUniqueOrThrow({ where: { id: r.paymentId! } });
      assert.equal(payment.reference, "NLJ7RT61SV");
      const smsAfter = await db.smsMessage.count({ where: { customerId: c.id, templateKey: "PAYMENT_RECEIPT" } });
      assert.equal(smsAfter, smsBefore + 1, "one PAYMENT_RECEIPT SMS queued");
    });

    it("persists a receipt that arrives after a poll already settled the intent", async () => {
      const c = await newCustomer();
      const intent = await processingIntent(c.id);
      const polled = await collections.settleIntent(intent.id, { verify: async () => ({ status: "SUCCEEDED" }) });
      assert.equal(polled.status, "SUCCEEDED");
      assert.equal(polled.receiptRef, null);
      const late = await collections.settleIntent(intent.id, {
        verify: async () => {
          throw new Error("a settled intent must not ask the provider on an ordinary callback");
        },
        hint: { resultCode: "0", amountCents: 25_000, receiptRef: "LATE12345X" },
      });
      assert.equal(late.receiptRef, "LATE12345X");
      const payment = await db.payment.findUniqueOrThrow({ where: { id: late.paymentId! } });
      assert.equal(payment.reference, "LATE12345X");
      assert.equal(await db.payment.count({ where: { customerId: c.id } }), 1);
    });

    it("re-verifies a FAILED intent whose callback now claims success (late success)", async () => {
      const c = await newCustomer();
      const intent = await processingIntent(c.id);
      const failed = await collections.settleIntent(intent.id, { verify: async () => ({ status: "FAILED", failureReason: "timed out" }) });
      assert.equal(failed.status, "FAILED");
      const ignored = await collections.settleIntent(intent.id, { verify: succeeded });
      assert.equal(ignored.status, "FAILED", "without a success hint a failed intent stays failed");
      const revived = await collections.settleIntent(intent.id, { verify: succeeded, hint: { resultCode: "0", amountCents: 25_000 } });
      assert.equal(revived.status, "SUCCEEDED");
      assert.equal(await db.payment.count({ where: { customerId: c.id } }), 1);
    });

    it("marks a settled intent REVERSED on re-check, audits it, and leaves the ledger alone", async () => {
      const c = await newCustomer();
      const intent = await processingIntent(c.id, { provider: "PAYSTACK", providerRef: `ps_${Date.now()}` });
      const settled = await collections.settleIntent(intent.id, { verify: async () => ({ status: "SUCCEEDED", amountCents: 25_000 }) });
      assert.equal(settled.status, "SUCCEEDED");
      const paymentsBefore = await db.payment.count({ where: { customerId: c.id } });

      const plainPoll = await collections.settleIntent(intent.id, { verify: async () => ({ status: "REVERSED" }) });
      assert.equal(plainPoll.status, "SUCCEEDED", "ordinary polling never re-asks about a settled intent");

      const rechecked = await collections.settleIntent(intent.id, {
        recheckSettled: true,
        verify: async () => ({ status: "REVERSED", failureReason: "Chargeback" }),
      });
      assert.equal(rechecked.status, "REVERSED");
      assert.equal(rechecked.paymentId, settled.paymentId, "the payment link is kept as evidence");
      assert.equal(await db.payment.count({ where: { customerId: c.id } }), paymentsBefore, "no automatic contra-entry");
      const trail = await db.auditLog.findFirst({ where: { entity: "PaymentIntent", entityId: intent.id, action: "UPDATE" } });
      assert.match(trail?.changes ?? "", /REVERSED/);

      const again = await collections.settleIntent(intent.id, { recheckSettled: true, verify: succeeded });
      assert.equal(again.status, "REVERSED", "terminal");
    });

    it("leaves the intent untouched when our own credentials are refused", async () => {
      const c = await newCustomer();
      const intent = await processingIntent(c.id);
      const r = await collections.settleIntent(intent.id, { verify: async () => ({ status: "PENDING", authError: true }) });
      assert.equal(r.status, "PROCESSING");
    });
  });

  // ── callbacks: adoption of orphans ────────────────────────────────────

  describe("intentForCallback", () => {
    it("adopts a Daraja CheckoutRequestID for a lookup-keyed intent with the same phone and amount", async () => {
      // A phone no other test uses: adoption picks the *oldest* matching orphan.
      const c = await newCustomer(companyId, "0733000001");
      const orphan = await processingIntent(c.id, { providerRef: null, payerPhone: "0733000001" });
      await db.paymentIntent.update({ where: { id: orphan.id }, data: { providerRef: `lookup:${orphan.id}` } });
      const found = await collections.intentForCallback("MPESA_DARAJA", "ws_CO_adopt_1", {
        checkoutRequestId: "ws_CO_adopt_1",
        resultCode: "0",
        amountCents: 25_000,
        phone: "254733000001",
      });
      assert.equal(found?.id, orphan.id);
      assert.equal(found?.providerRef, "ws_CO_adopt_1");
      const wrongAmount = await collections.intentForCallback("MPESA_DARAJA", "ws_CO_adopt_2", {
        checkoutRequestId: "ws_CO_adopt_2",
        resultCode: "0",
        amountCents: 25_000,
        phone: "254799999999",
      });
      assert.equal(wrongAmount, null);
    });

    it("adopts a Paystack reference that names a lookup-keyed intent", async () => {
      const c = await newCustomer();
      const orphan = await processingIntent(c.id, { provider: "PAYSTACK", providerRef: null });
      await db.paymentIntent.update({ where: { id: orphan.id }, data: { providerRef: `lookup:${orphan.id}` } });
      const found = await collections.intentForCallback("PAYSTACK", orphan.id);
      assert.equal(found?.providerRef, orphan.id);
    });

    it("reads Paystack refund events by transaction_reference", () => {
      assert.equal(collections.referenceFromCallback("PAYSTACK", { event: "refund.processed", data: { reference: "RF_1", transaction_reference: "T_1" } }), "T_1");
      assert.equal(collections.referenceFromCallback("PAYSTACK", { event: "charge.success", data: { reference: "T_2" } }), "T_2");
      assert.equal(collections.referenceFromCallback("MPESA_DARAJA", { Body: { stkCallback: { CheckoutRequestID: "ws_CO_9" } } }), "ws_CO_9");
    });
  });

  // ── reconciliation ────────────────────────────────────────────────────

  describe("reconcileIntents", () => {
    it("expires stale intents, keys orphans, re-checks due ones and repairs stale claims", async () => {
      const c = await newCustomer();
      const now = Date.now();
      const old = new Date(now - 25 * 3600_000);
      const dueAt = new Date(now - 5 * 60_000);

      const expiredPending = await processingIntent(c.id, { status: "PENDING", providerRef: null });
      const expiredProcessing = await processingIntent(c.id);
      const orphan = await processingIntent(c.id, { status: "PENDING", providerRef: null });
      const due = await processingIntent(c.id);
      const fresh = await processingIntent(c.id);
      const stale = await processingIntent(c.id, { status: "SETTLING" });
      await db.paymentIntent.update({ where: { id: expiredPending.id }, data: { createdAt: old } });
      await db.paymentIntent.update({ where: { id: expiredProcessing.id }, data: { createdAt: old } });
      await db.paymentIntent.update({ where: { id: orphan.id }, data: { createdAt: dueAt } });
      await db.paymentIntent.update({ where: { id: due.id }, data: { createdAt: dueAt } });
      await db.paymentIntent.update({ where: { id: stale.id }, data: { createdAt: dueAt, updatedAt: dueAt } });

      daraja({ query: (body) => (body.CheckoutRequestID === due.providerRef || body.CheckoutRequestID === stale.providerRef ? json(200, { ResultCode: "0" }) : json(500, { errorCode: "500.001.1001" })) });

      const summary = await collections.reconcileIntents();
      assert.equal(summary.expired, 2);
      assert.equal(summary.orphansKeyed, 1);
      assert.ok(summary.rechecked >= 2, `rechecked ${summary.rechecked}`);
      assert.ok(summary.staleClaims >= 1);
      assert.deepEqual(summary.errors, []);

      const byId = async (id: string) => db.paymentIntent.findUniqueOrThrow({ where: { id } });
      assert.equal((await byId(expiredPending.id)).status, "EXPIRED");
      assert.equal((await byId(expiredProcessing.id)).status, "EXPIRED");
      assert.equal((await byId(orphan.id)).providerRef, `lookup:${orphan.id}`);
      assert.equal((await byId(orphan.id)).status, "PROCESSING");
      assert.equal((await byId(due.id)).status, "SUCCEEDED");
      assert.equal((await byId(stale.id)).status, "SUCCEEDED", "a stale claim is re-run");
      assert.equal((await byId(fresh.id)).status, "PROCESSING", "a two-minute-old intent is left to polling");
      assert.equal(await db.payment.count({ where: { customerId: c.id } }), 2);

      const again = await collections.reconcileIntents();
      assert.equal(again.expired, 0);
      assert.equal(await db.payment.count({ where: { customerId: c.id } }), 2, "idempotent");
    });
  });

  // ── gateway methods may only be booked by settlement ──────────────────

  describe("recordPayment method whitelist", () => {
    it("rejects gateway methods from anything but settleIntent", async () => {
      const c = await newCustomer();
      for (const method of ["MPESA_STK", "PAYSTACK", "KCB_BUNI"]) {
        await rejects(sales.recordPayment({ companyId, customerId: c.id, amountCents: 1_000, method, clientUuid: `dev-${Date.now()}` }), 422, /booked by the gateway/);
      }
      assert.equal(await db.payment.count({ where: { customerId: c.id } }), 0);
    });

    it("requires a plausible M-Pesa code for a manual MPESA record, unique per company", async () => {
      const c = await newCustomer();
      await rejects(sales.recordPayment({ companyId, customerId: c.id, amountCents: 1_000, method: "MPESA", reference: "paid" }), 422, /confirmation code/);
      await rejects(sales.recordPayment({ companyId, customerId: c.id, amountCents: 1_000, method: "MPESA" }), 422);
      const code = `Q${Date.now().toString(36).toUpperCase()}`.slice(0, 10).padEnd(10, "X");
      const first = await sales.recordPayment({ companyId, customerId: c.id, amountCents: 1_000, method: "MPESA", reference: code.toLowerCase(), createdById: userId });
      assert.equal(first.payment.reference, code, "stored upper-cased");
      await rejects(sales.recordPayment({ companyId, customerId: c.id, amountCents: 1_000, method: "MPESA", reference: code }), 409, /already recorded/);
      // Another company may record the same code: M-Pesa codes are unique per customer SMS, not globally known to us.
      const foreign = await newCustomer(otherCompanyId);
      const other = await sales.recordPayment({ companyId: otherCompanyId, customerId: foreign.id, amountCents: 1_000, method: "MPESA", reference: code });
      assert.equal(other.payment.reference, code);
    });
  });
});
