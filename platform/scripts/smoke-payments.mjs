/**
 * End-to-end payments smoke test: the platform against a mock Daraja and a
 * mock Paystack.
 *
 *   node scripts/smoke-payments.mjs [baseUrl]            (default http://localhost:3290)
 *   npm run test:payments                                 (= --with-server)
 *
 * Starts `mock-daraja.mjs` and `mock-paystack.mjs` in-process (or uses
 * MOCK_DARAJA_URL / MOCK_PAYSTACK_URL), then drives the real API: stores
 * gateway credentials for the demo company, tests them, and walks every path a
 * collection can take — success, cancel, timeout, insufficient balance, a
 * prompt that is never answered, a success that arrives after a failure, a
 * callback that beats the query, duplicate and out-of-order callbacks, an
 * amount that does not match, a push whose response was lost, a token that
 * expired mid-flight, reconciliation and expiry, Paystack's signed webhooks
 * (good, bad, missing, replayed, reversed, wrong currency), the return
 * redirect, and the two ways a handset must *not* be able to book a gateway
 * payment — asserting over HTTP that money is booked exactly once, and only
 * when the provider says so.
 *
 * `--with-server` builds a SCRATCH COPY of the platform sources in the temp
 * directory (src/, prisma/, scripts/, public/, config files; node_modules
 * junctioned), copies prisma/xos.db to a TEMP DATABASE, and starts `next dev`
 * there with:
 *
 *   DATABASE_URL=<temp copy>           PUBLIC_BASE_URL=http://localhost:3290
 *   MPESA_BASE_URL / PAYSTACK_BASE_URL → the mocks
 *   PAYMENTS_RUNNER_TOKEN=<token>      PAYMENTS_TIMEOUT_MS=1500
 *   PAYMENTS_ALLOW_CUSTOM_HOSTS=1      PAYMENTS_INITIATE_PER_MINUTE=500
 *   CREDENTIALS_KEY=<from .env or random>
 *
 * so neither the shared dev database nor the checkout's `.next/` is touched,
 * and runs `check-consistency.mjs` against the temp database afterwards.
 * Everything is removed at the end.
 *
 * Against an external server (no --with-server) set SMOKE_DATABASE_URL to that
 * server's database to enable the checks that need to backdate or inspect rows
 * directly; without it those checks are skipped, and the credentials this
 * script stores are removed again at the end.
 */

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { startMock as startDaraja } from "./mock-daraja.mjs";
import { startMock as startPaystack } from "./mock-paystack.mjs";

const args = process.argv.slice(2);
const WITH_SERVER = args.includes("--with-server");
const BASE = args.find((a) => !a.startsWith("--")) ?? "http://localhost:3290";
const RUNNER_TOKEN = process.env.PAYMENTS_RUNNER_TOKEN ?? "smoke-payments-runner-token";
const DARAJA_PORT = Number(process.env.MOCK_DARAJA_PORT ?? 4710);
const PAYSTACK_PORT = Number(process.env.MOCK_PAYSTACK_PORT ?? 4720);
const PASSWORD = "Raut@2026";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let passed = 0;
let failed = 0;
let dbUrl = process.env.SMOKE_DATABASE_URL ?? null;
let prisma = null;

function check(name, condition, detail = "") {
  if (condition) {
    passed++;
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function skip(name, why) {
  console.log(`  - ${name} (skipped: ${why})`);
}

async function api(p, { method = "GET", token, body, headers = {}, raw = false, redirect = "follow" } = {}) {
  const res = await fetch(`${BASE}/api/v1${p}`, {
    method,
    redirect,
    headers: {
      ...(raw ? {} : { "Content-Type": "application/json" }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: raw ? body : JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = {};
  try {
    json = JSON.parse(text);
  } catch {
    /* html or empty */
  }
  return { status: res.status, json, text, headers: res.headers };
}

const uuid = () => `smoke-pay-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Polls the intent until `until(dto)` holds or the deadline passes. */
async function pollUntil(token, id, until, { timeoutMs = 20_000, every = 400 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const r = await api(`/payments/intents/${id}`, { token });
    last = r.json?.data ?? null;
    if (last && until(last)) return last;
    await sleep(every);
  }
  return last;
}

/** Waits until a predicate over mock state holds. */
async function waitFor(fn, { timeoutMs = 10_000, every = 200 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await sleep(every);
  }
  return false;
}

async function getPrisma() {
  if (!dbUrl) return null;
  if (!prisma) {
    const { PrismaClient } = await import("@prisma/client");
    prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } });
  }
  return prisma;
}

async function main() {
  console.log(`\nRaut payments smoke test → ${BASE}\n`);

  // ── mocks ───────────────────────────────────────────────────────────
  let daraja;
  let paystack;
  let darajaUrl = process.env.MOCK_DARAJA_URL;
  let paystackUrl = process.env.MOCK_PAYSTACK_URL;
  if (!darajaUrl) {
    daraja = await startDaraja({ port: DARAJA_PORT });
    darajaUrl = daraja.url;
  }
  if (!paystackUrl) {
    paystack = await startPaystack({ port: PAYSTACK_PORT });
    paystackUrl = paystack.url;
  }
  const dctl = async (body) => (await fetch(`${darajaUrl}/__control`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
  const dstate = async () => (await fetch(`${darajaUrl}/__control`)).json();
  const pctl = async (body) => (await fetch(`${paystackUrl}/__control`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
  const pstate = async () => (await fetch(`${paystackUrl}/__control`)).json();

  await dctl({ reset: true, consumerKey: "ck-smoke", consumerSecret: "cs-smoke", callbackDelayMs: 150 });
  await pctl({ reset: true, secretKey: "sk_test_smoke", webhookUrl: `${BASE}/api/v1/payments/callbacks/paystack` });
  console.log(`Mock Daraja at ${darajaUrl}, mock Paystack at ${paystackUrl}`);

  // ── sign in ─────────────────────────────────────────────────────────
  console.log("\nSetup");
  const health = await api("/health");
  check("Platform is healthy", health.json?.data?.status === "healthy");

  const login = await api("/auth/login", { method: "POST", body: { email: "admin@tarisolutions.co.ke", password: PASSWORD } });
  const token = login.json?.data?.accessToken;
  check("Admin signs in", Boolean(token), login.json?.error?.message ?? "");
  if (!token) throw new Error("cannot continue without a session");

  const customers = (await api("/customers?limit=10", { token })).json?.data ?? [];
  const customer = customers[0];
  check("A customer is available", Boolean(customer?.id));
  const PHONE = "0712345678";
  const MSISDN = "254712345678";

  const db = await getPrisma();
  if (!db) console.log("  (no database access: SMOKE_DATABASE_URL unset — direct-row checks will be skipped)");

  // Warm the routes the timing-sensitive scenarios hit, so `next dev`'s first
  // compile of each does not land in the middle of a race the test is timing.
  await api("/payments/intents/warm-up", { token });
  await api("/payments/callbacks/mpesa_daraja", { method: "POST", body: {} });
  await api("/payments/callbacks/paystack", { method: "POST", body: {} });
  await api("/payments/reconcile", { method: "POST" });
  await api("/payments/return/paystack?reference=warm-up", { redirect: "manual" });

  const paymentsFor = async (customerId) => (await api(`/payments?customerId=${customerId}&limit=200`, { token })).json?.data ?? [];
  const payCount = async (customerId) => (await paymentsFor(customerId)).length;

  const saveCred = (provider, values) => api("/settings/credentials", { method: "POST", token, body: { provider, values } });
  const testCred = (provider) => api("/settings/credentials", { method: "PATCH", token, body: { provider, action: "test" } });
  const deleteCred = (provider) => api("/settings/credentials", { method: "PATCH", token, body: { provider, action: "delete" } });

  const DARAJA_CREDS = { MPESA_CONSUMER_KEY: "ck-smoke", MPESA_CONSUMER_SECRET: "cs-smoke", MPESA_SHORTCODE: "174379", MPESA_PASSKEY: "pk-smoke", MPESA_ENV: "sandbox" };

  const initiate = (body) => api("/payments/initiate", { method: "POST", token, body: { customerId: customer.id, provider: "MPESA_DARAJA", amountCents: 25_000, payerPhone: PHONE, clientUuid: uuid(), ...body } });
  const collect = async (mode, body = {}) => {
    await dctl({ mode });
    const r = await initiate(body);
    return { status: r.status, intent: r.json?.data ?? null, error: r.json?.error ?? null };
  };
  const terminal = (d) => ["SUCCEEDED", "FAILED", "EXPIRED", "REVERSED", "CANCELLED"].includes(d.status);
  const pushFor = async (intentId) => (await dstate()).pushes.find((p) => p.accountReference === intentId.slice(0, 12));
  const callbacksFor = async (checkoutId) => (await dstate()).callbacks.filter((c) => c.checkoutRequestId === checkoutId);

  try {
    // ── credentials ───────────────────────────────────────────────────
    console.log("\nCredentials");
    let r = await saveCred("MPESA_DARAJA", { ...DARAJA_CREDS, MPESA_PARTY_B: "600000" });
    check("Daraja credentials can be stored", r.status === 200, r.json?.error?.message ?? "");
    r = await testCred("MPESA_DARAJA");
    check("Daraja test: OAuth + STK query authenticate", r.json?.data?.ok === true && /Authenticated with Daraja/.test(r.json?.data?.note ?? ""), r.json?.data?.note);
    check("…and the test queried an impossible CheckoutRequestID, pushing nothing", (await dstate()).requests.some((q) => q.path === "/mpesa/stkpushquery/v1/query" && q.body?.CheckoutRequestID === "ws_CO_raut_credential_test") && (await dstate()).pushes.length === 0);

    r = await saveCred("MPESA_DARAJA", { ...DARAJA_CREDS, MPESA_CONSUMER_SECRET: "wrong" });
    r = await testCred("MPESA_DARAJA");
    check("Daraja test fails with a wrong consumer secret", r.json?.data?.ok === false && /refused the consumer key/.test(r.json?.data?.note ?? ""), r.json?.data?.note);
    r = await saveCred("MPESA_DARAJA", DARAJA_CREDS); // required keys only: PARTY_B must survive
    check("Replacing required keys keeps the stored optional ones", r.status === 200);

    r = await saveCred("PAYSTACK", { PAYSTACK_SECRET_KEY: "sk_test_smoke" });
    check("Paystack credentials can be stored", r.status === 200, r.json?.error?.message ?? "");
    r = await testCred("PAYSTACK");
    check("Paystack test: verify of an impossible reference answers 'not found' with a valid key", r.json?.data?.ok === true && /Authenticated with Paystack/.test(r.json?.data?.note ?? ""), r.json?.data?.note);
    await saveCred("PAYSTACK", { PAYSTACK_SECRET_KEY: "sk_test_wrong" });
    r = await testCred("PAYSTACK");
    check("Paystack test fails on 401", r.json?.data?.ok === false && /401/.test(r.json?.data?.note ?? ""), r.json?.data?.note);
    await saveCred("PAYSTACK", { PAYSTACK_SECRET_KEY: "sk_test_smoke" });

    const providers = (await api("/payments/providers", { token })).json?.data?.providers ?? [];
    check("Providers list offers Daraja and Paystack, not KCB", providers.find((p) => p.name === "MPESA_DARAJA")?.configured === true && providers.find((p) => p.name === "PAYSTACK")?.configured === true && providers.find((p) => p.name === "KCB_BUNI")?.configured === false);

    // ── M-Pesa: happy path ────────────────────────────────────────────
    console.log("\nM-Pesa · success");
    let before = await payCount(customer.id);
    let { status, intent } = await collect("succeed");
    check("Initiate returns a PROCESSING intent", status === 200 && intent?.status === "PROCESSING", JSON.stringify(intent?.status));
    check("The response is the public DTO only", intent && !("providerPayload" in intent) && !("companyId" in intent) && "redirectUrl" in intent && "createdAt" in intent && "currency" in intent);
    let push = await pushFor(intent.id);
    check("The STK push carried whole shillings, the MSISDN and the stored Party B", push?.amount === 250 && push?.phone === MSISDN && (await dstate()).requests.find((q) => q.path === "/mpesa/stkpush/v1/processrequest" && q.body?.AccountReference === intent.id.slice(0, 12))?.body?.PartyB === "600000", JSON.stringify(push));
    check("AccountReference ≤ 12 and TransactionDesc ≤ 13 characters", push && push.accountReference.length <= 12 && push.transactionDesc.length <= 13);
    let settled = await pollUntil(token, intent.id, (d) => d.status === "SUCCEEDED", { timeoutMs: 30_000 });
    check("The intent settles SUCCEEDED (poll or callback, whichever confirms first)", settled?.status === "SUCCEEDED", settled?.status);
    // The receipt only ever travels in the callback (the STK query has no
    // receipt field), so it may land a moment after a poll has settled.
    await waitFor(async () => (await callbacksFor(push.checkoutRequestId)).some((c) => c.status === 200));
    settled = await pollUntil(token, intent.id, (d) => Boolean(d.receiptRef), { timeoutMs: 5000 });
    check("…and carries the M-Pesa receipt from the callback", settled?.receiptRef === push?.receipt, `${settled?.status} ${settled?.receiptRef}`);
    let pays = await paymentsFor(customer.id);
    let booked = pays.find((p) => p.id === settled?.paymentId);
    check("Exactly one MPESA_STK payment is booked, referenced by the receipt", pays.length === before + 1 && booked?.method === "MPESA_STK" && booked?.reference === push?.receipt, JSON.stringify({ count: pays.length - before, method: booked?.method, ref: booked?.reference }));

    // ── M-Pesa: duplicate / out-of-order callbacks ───────────────────
    console.log("\nM-Pesa · duplicate and out-of-order callbacks");
    before = await payCount(customer.id);
    ({ intent } = await collect("duplicate"));
    push = await pushFor(intent.id);
    await waitFor(async () => (await callbacksFor(push.checkoutRequestId)).length >= 3, { timeoutMs: 8000 });
    settled = await pollUntil(token, intent.id, terminal);
    check("Three callbacks (one stale 1037 in between) settle once and stay SUCCEEDED", settled?.status === "SUCCEEDED" && (await payCount(customer.id)) === before + 1, `${settled?.status}, ${(await callbacksFor(push.checkoutRequestId)).length} callbacks`);

    // ── M-Pesa: failures ─────────────────────────────────────────────
    console.log("\nM-Pesa · failures");
    before = await payCount(customer.id);
    for (const [mode, re] of [["cancel", /cancelled by the customer/i], ["timeout", /no response from the customer/i], ["insufficient", /insufficient/i]]) {
      ({ intent } = await collect(mode));
      settled = await pollUntil(token, intent.id, terminal);
      check(`${mode} → FAILED with a human reason`, settled?.status === "FAILED" && re.test(settled.failureReason ?? ""), `${settled?.status}: ${settled?.failureReason}`);
    }
    check("No payment was booked for any failure", (await payCount(customer.id)) === before);

    r = await initiate({ amountCents: 25_050 });
    check("An amount with cents is refused with 422 AMOUNT_NOT_WHOLE", r.status === 422 && r.json?.error?.code === "AMOUNT_NOT_WHOLE", r.json?.error?.message);

    const replayUuid = uuid();
    const pushesBefore = (await dstate()).pushes.length;
    await dctl({ mode: "pending" });
    const a = await initiate({ clientUuid: replayUuid });
    const b = await initiate({ clientUuid: replayUuid });
    check("Replaying a clientUuid returns the same intent and sends one push", a.json?.data?.id === b.json?.data?.id && (await dstate()).pushes.length === pushesBefore + 1);

    // ── M-Pesa: pending / forged callback / completion ───────────────
    console.log("\nM-Pesa · pending, forged callback, late completion");
    before = await payCount(customer.id);
    ({ intent } = await collect("pending"));
    push = await pushFor(intent.id);
    settled = await pollUntil(token, intent.id, terminal, { timeoutMs: 1500 });
    check("A prompt nobody answers stays PROCESSING (500.001.1001 is not a failure)", settled?.status === "PROCESSING", settled?.status);

    const forged = await api("/payments/callbacks/mpesa_daraja", {
      method: "POST",
      body: { Body: { stkCallback: { MerchantRequestID: "x", CheckoutRequestID: push.checkoutRequestId, ResultCode: 0, ResultDesc: "ok", CallbackMetadata: { Item: [{ Name: "Amount", Value: 250 }, { Name: "MpesaReceiptNumber", Value: "FORGED0001" }, { Name: "PhoneNumber", Value: Number(MSISDN) }] } } } },
    });
    const afterForged = (await api(`/payments/intents/${intent.id}`, { token })).json?.data;
    check("A forged success callback is acknowledged (200) but books nothing", forged.status === 200 && afterForged?.status === "PROCESSING" && afterForged?.receiptRef == null && (await payCount(customer.id)) === before, `${forged.status} ${afterForged?.status}`);
    const forgedUnknown = await api("/payments/callbacks/mpesa_daraja", { method: "POST", body: { Body: { stkCallback: { CheckoutRequestID: "ws_CO_nobody", ResultCode: 0 } } } });
    check("A callback for an unknown reference is a 200", forgedUnknown.status === 200 && forgedUnknown.json?.ignored === "unknown reference");
    const garbage = await api("/payments/callbacks/mpesa_daraja", { method: "POST", raw: true, body: "<not json" });
    check("An unparseable callback body is a 200", garbage.status === 200);

    await dctl({ complete: { checkoutRequestId: push.checkoutRequestId, result: 0 } });
    settled = await pollUntil(token, intent.id, terminal);
    check("Once the customer pays, the intent settles with the real receipt", settled?.status === "SUCCEEDED" && settled.receiptRef === push.receipt && settled.receiptRef !== "FORGED0001" && (await payCount(customer.id)) === before + 1, `${settled?.status} ${settled?.receiptRef}`);

    ({ intent } = await collect("pending4999"));
    settled = await pollUntil(token, intent.id, terminal, { timeoutMs: 1200 });
    check("ResultCode 4999 is PENDING", settled?.status === "PROCESSING", settled?.status);
    push = await pushFor(intent.id);
    await dctl({ complete: { checkoutRequestId: push.checkoutRequestId, result: 1032 } });
    settled = await pollUntil(token, intent.id, terminal);
    check("…and completes as a cancellation", settled?.status === "FAILED" && /cancelled/i.test(settled.failureReason ?? ""));

    // ── M-Pesa: late success after failure ───────────────────────────
    console.log("\nM-Pesa · late success, callback-only, amount mismatch");
    before = await payCount(customer.id);
    ({ intent } = await collect("late-success"));
    push = await pushFor(intent.id);
    settled = await pollUntil(token, intent.id, terminal);
    check("A 1037 is recorded as FAILED first", settled?.status === "FAILED", settled?.status);
    await dctl({ complete: { checkoutRequestId: push.checkoutRequestId, result: 0 } });
    await waitFor(async () => (await callbacksFor(push.checkoutRequestId)).some((c) => c.resultCode === 0 && c.status === 200));
    settled = await pollUntil(token, intent.id, (d) => d.status === "SUCCEEDED", { timeoutMs: 5000 });
    check("A success callback after the failure re-verifies and books once", settled?.status === "SUCCEEDED" && settled.receiptRef === push.receipt && (await payCount(customer.id)) === before + 1, settled?.status);

    before = await payCount(customer.id);
    ({ intent } = await collect("callback-only"));
    settled = await pollUntil(token, intent.id, terminal);
    check("A callback that arrives before the query reflects it still settles (via verify)", settled?.status === "SUCCEEDED" && (await payCount(customer.id)) === before + 1, settled?.status);

    before = await payCount(customer.id);
    ({ intent } = await collect("mismatch"));
    // Daraja's query carries no amount, so only the callback can reveal the
    // mismatch: let it land before anything polls.
    push = await pushFor(intent.id);
    await waitFor(async () => (await callbacksFor(push.checkoutRequestId)).some((c) => c.status === 200));
    settled = await pollUntil(token, intent.id, terminal);
    check("A callback amount that differs fails the intent with 'amount mismatch' and books nothing", settled?.status === "FAILED" && /amount mismatch/.test(settled.failureReason ?? "") && (await payCount(customer.id)) === before, `${settled?.status}: ${settled?.failureReason}`);
    if (db) {
      const trail = await db.auditLog.findFirst({ where: { entity: "PaymentIntent", entityId: intent.id, action: "PAYMENT_FAILED" } });
      check("…and the mismatch is audited", Boolean(trail && /amount mismatch/.test(trail.changes ?? "")));
    } else skip("mismatch audit entry", "no database access");

    // ── M-Pesa: lost answers ─────────────────────────────────────────
    console.log("\nM-Pesa · STK accepted but the response was lost");
    before = await payCount(customer.id);
    ({ status, intent } = await collect("dropped"));
    check("A dropped response leaves the intent PROCESSING, not FAILED", status === 200 && intent?.status === "PROCESSING", `${status} ${intent?.status}`);
    if (db) {
      const row = await db.paymentIntent.findUnique({ where: { id: intent.id } });
      check("…under a lookup key, since the CheckoutRequestID never arrived", row?.providerRef === `lookup:${intent.id}`, row?.providerRef);
    } else skip("lookup key", "no database access");
    settled = await pollUntil(token, intent.id, terminal);
    check("The callback is adopted by phone + amount and the intent settles with its receipt", settled?.status === "SUCCEEDED" && Boolean(settled.receiptRef) && (await payCount(customer.id)) === before + 1, `${settled?.status} ${settled?.receiptRef}`);

    before = await payCount(customer.id);
    ({ status, intent } = await collect("hang"));
    // Either the timeout fired first (PROCESSING under a lookup key) or the
    // callback arrived while the push was still hanging and was adopted onto
    // the in-flight intent (already SUCCEEDED). Both are correct; FAILED is not.
    check("A hung push is cut off by PAYMENTS_TIMEOUT_MS and is never failed", status === 200 && ["PROCESSING", "SUCCEEDED"].includes(intent?.status), `${status} ${intent?.status}`);
    settled = await pollUntil(token, intent.id, terminal);
    check("…and settles once its callback arrives", settled?.status === "SUCCEEDED" && (await payCount(customer.id)) === before + 1, settled?.status);

    await dctl({ mode: "succeed" });
    await deleteCred("MPESA_DARAJA");
    await saveCred("MPESA_DARAJA", { ...DARAJA_CREDS, MPESA_BASE_URL: "http://127.0.0.1:45999" });
    r = await initiate({});
    check("A provider that cannot be reached at all fails the intent as 'provider unreachable'", r.status === 200 && r.json?.data?.status === "FAILED" && /^provider unreachable/.test(r.json?.data?.failureReason ?? ""), `${r.status} ${r.json?.data?.status}: ${r.json?.data?.failureReason}`);
    await deleteCred("MPESA_DARAJA");
    await saveCred("MPESA_DARAJA", DARAJA_CREDS);

    // ── M-Pesa: token expiry ─────────────────────────────────────────
    console.log("\nM-Pesa · expired access token");
    const oauthBefore = (await dstate()).requests.filter((q) => q.path.startsWith("/oauth/")).length;
    await dctl({ invalidateTokens: true });
    before = await payCount(customer.id);
    ({ status, intent } = await collect("succeed"));
    settled = await pollUntil(token, intent.id, terminal);
    const oauthAfter = (await dstate()).requests.filter((q) => q.path.startsWith("/oauth/")).length;
    check("A 401 evicts the cached token; the push is retried with a fresh one and settles", status === 200 && settled?.status === "SUCCEEDED" && oauthAfter > oauthBefore && (await payCount(customer.id)) === before + 1, `${settled?.status}, oauth calls +${oauthAfter - oauthBefore}`);

    // ── reconciliation ───────────────────────────────────────────────
    console.log("\nReconciliation");
    check("The runner refuses a missing token", (await api("/payments/reconcile", { method: "POST" })).status === 401);
    check("The runner refuses a wrong token", (await api("/payments/reconcile", { method: "POST", headers: { Authorization: "Bearer nope" } })).status === 401);
    const runner = () => api("/payments/reconcile", { method: "POST", headers: { Authorization: `Bearer ${RUNNER_TOKEN}` } });
    r = await runner();
    check("A sweep answers 200 with a summary", r.status === 200 && typeof r.json?.data?.rechecked === "number" && Array.isArray(r.json?.data?.errors), JSON.stringify(r.json?.data));

    if (db) {
      before = await payCount(customer.id);
      const { intent: due } = await collect("pending");
      const { intent: stale } = await collect("pending");
      const { intent: fresh } = await collect("pending");
      await db.paymentIntent.update({ where: { id: due.id }, data: { createdAt: new Date(Date.now() - 5 * 60_000) } });
      await db.paymentIntent.update({ where: { id: stale.id }, data: { createdAt: new Date(Date.now() - 25 * 3600_000) } });
      const duePush = await pushFor(due.id);
      await dctl({ complete: { checkoutRequestId: duePush.checkoutRequestId, result: 0, callback: false } });
      r = await runner();
      const dueAfter = (await api(`/payments/intents/${due.id}`, { token })).json?.data;
      const staleAfter = (await api(`/payments/intents/${stale.id}`, { token })).json?.data;
      const freshAfter = (await api(`/payments/intents/${fresh.id}`, { token })).json?.data;
      check("The sweep re-verifies a PROCESSING intent older than 2 minutes and books it", r.json?.data?.rechecked >= 1 && r.json?.data?.settled >= 1 && dueAfter?.status === "SUCCEEDED" && (await payCount(customer.id)) === before + 1, JSON.stringify({ sweep: r.json?.data, due: dueAfter?.status }));
      check("The sweep EXPIRES an intent older than 24 hours", r.json?.data?.expired >= 1 && staleAfter?.status === "EXPIRED" && /24 hours/.test(staleAfter?.failureReason ?? ""), `${staleAfter?.status}: ${staleAfter?.failureReason}`);
      check("A fresh PROCESSING intent is left to polling", freshAfter?.status === "PROCESSING");
      const freshPush = await pushFor(fresh.id);
      await dctl({ complete: { checkoutRequestId: freshPush.checkoutRequestId, result: 1032 } });
      await pollUntil(token, fresh.id, terminal);
    } else {
      skip("re-check after 2 minutes / expiry after 24 hours", "no database access to backdate rows");
    }

    // ── Paystack ─────────────────────────────────────────────────────
    console.log("\nPaystack");
    const EMAIL = "payer@example.com";
    const card = (extra = {}) => api("/payments/initiate", { method: "POST", token, body: { customerId: customer.id, provider: "PAYSTACK", amountCents: 25_050, payerEmail: EMAIL, clientUuid: uuid(), ...extra } });

    before = await payCount(customer.id);
    r = await card();
    intent = r.json?.data;
    check("Initiate returns PROCESSING with a redirectUrl", r.status === 200 && intent?.status === "PROCESSING" && /\/checkout\//.test(intent?.redirectUrl ?? ""), JSON.stringify({ status: intent?.status, redirectUrl: intent?.redirectUrl }));
    const init = (await pstate()).requests.find((q) => q.path === "/transaction/initialize" && q.body?.reference === intent.id);
    check("callback_url points at the return handler, with the reference", /\/api\/v1\/payments\/return\/paystack\?reference=/.test(init?.body?.callback_url ?? ""), init?.body?.callback_url);
    check("Cents are allowed for Paystack (minor units)", init?.body?.amount === 25_050 && init?.body?.currency === "KES");

    let hook = await pctl({ pay: { reference: intent.id, outcome: "success" } });
    check("A signed charge.success webhook is accepted (200)", hook.lastWebhookStatus === 200, String(hook.lastWebhookStatus));
    settled = await pollUntil(token, intent.id, terminal);
    pays = await paymentsFor(customer.id);
    booked = pays.find((p) => p.id === settled?.paymentId);
    check("The intent settles and one PAYSTACK payment is booked", settled?.status === "SUCCEEDED" && pays.length === before + 1 && booked?.method === "PAYSTACK" && booked?.reference === intent.id, JSON.stringify({ status: settled?.status, ref: booked?.reference }));
    hook = await pctl({ webhook: { reference: intent.id } });
    check("A replayed webhook is a 200 and books nothing more", hook.lastWebhookStatus === 200 && (await payCount(customer.id)) === before + 1);
    if (db) {
      const row = await db.paymentIntent.findUnique({ where: { id: intent.id } });
      check("The stored payload carries no card or customer details", Boolean(row?.providerPayload) && !/authorization|last4|payer@example/.test(row.providerPayload), (row?.providerPayload ?? "").slice(0, 120));
    } else skip("payload stripping", "no database access");

    // return redirect
    const ret = await api(`/payments/return/paystack?reference=${intent.id}&trxref=${intent.id}`, { redirect: "manual" });
    const location = ret.headers.get("location") ?? "";
    check("The return handler redirects to the status page as 'succeeded'", ret.status === 303 && /\/api\/v1\/payments\/return\/status\?s=succeeded/.test(location), `${ret.status} ${location}`);
    const page = await fetch(new URL(location, BASE));
    const html = await page.text();
    check("…which says 'Payment received' and shows the reference", page.status === 200 && /Payment received/.test(html) && html.includes(intent.id) && /text\/html/.test(page.headers.get("content-type") ?? ""));
    const unknownRet = await api("/payments/return/paystack?reference=nope", { redirect: "manual" });
    check("An unknown reference lands on 'Payment not found'", /s=unknown/.test(unknownRet.headers.get("location") ?? ""));

    // signature checks
    before = await payCount(customer.id);
    r = await card();
    intent = r.json?.data;
    await pctl({ pay: { reference: intent.id, outcome: "success", webhook: false } });
    hook = await pctl({ webhook: { reference: intent.id, signature: "bad" } });
    check("A webhook with a bad signature is refused with 401", hook.lastWebhookStatus === 401, String(hook.lastWebhookStatus));
    hook = await pctl({ webhook: { reference: intent.id, signature: "missing" } });
    check("A webhook with no signature is refused with 401", hook.lastWebhookStatus === 401, String(hook.lastWebhookStatus));
    if (db) {
      const row = await db.paymentIntent.findUnique({ where: { id: intent.id } });
      check("…and neither booked anything (the intent is still PROCESSING until verified)", row?.status === "PROCESSING" && (await payCount(customer.id)) === before, row?.status);
    } else skip("forged Paystack webhook books nothing", "no database access");
    hook = await pctl({ webhook: { reference: intent.id, event: "transfer.success" } });
    const pendingRet = await api(`/payments/return/paystack?reference=${intent.id}`, { redirect: "manual" });
    check("An unrelated event is acknowledged and ignored; the payer's return settles it (succeeded)", hook.lastWebhookStatus === 200 && /s=succeeded/.test(pendingRet.headers.get("location") ?? ""), pendingRet.headers.get("location"));
    check("…booking one payment", (await payCount(customer.id)) === before + 1);

    // currency and amount mismatches
    before = await payCount(customer.id);
    r = await card();
    intent = r.json?.data;
    await pctl({ pay: { reference: intent.id, outcome: "success", currency: "NGN" } });
    settled = await pollUntil(token, intent.id, terminal);
    check("A charge in another currency never settles", settled?.status === "FAILED" && /NGN/.test(settled.failureReason ?? "") && (await payCount(customer.id)) === before, `${settled?.status}: ${settled?.failureReason}`);
    r = await card();
    intent = r.json?.data;
    await pctl({ pay: { reference: intent.id, outcome: "success", amount: 25_150 } });
    settled = await pollUntil(token, intent.id, terminal);
    check("A charge for a different amount fails with 'amount mismatch'", settled?.status === "FAILED" && /amount mismatch/.test(settled.failureReason ?? "") && (await payCount(customer.id)) === before, `${settled?.status}: ${settled?.failureReason}`);
    r = await card();
    intent = r.json?.data;
    await pctl({ pay: { reference: intent.id, outcome: "failed" } });
    settled = await pollUntil(token, intent.id, terminal);
    check("charge.failed → FAILED", settled?.status === "FAILED", settled?.status);

    // reversal
    before = await payCount(customer.id);
    r = await card();
    intent = r.json?.data;
    await pctl({ pay: { reference: intent.id, outcome: "success" } });
    settled = await pollUntil(token, intent.id, (d) => d.status === "SUCCEEDED");
    check("A charge settles before the reversal", settled?.status === "SUCCEEDED" && (await payCount(customer.id)) === before + 1);
    hook = await pctl({ reverse: { reference: intent.id } });
    const reversed = await pollUntil(token, intent.id, (d) => d.status === "REVERSED", { timeoutMs: 5000 });
    check("refund.processed marks the intent REVERSED and leaves the ledger alone", hook.lastWebhookStatus === 200 && reversed?.status === "REVERSED" && reversed.paymentId === settled.paymentId && (await payCount(customer.id)) === before + 1, reversed?.status);

    // ── handsets and REST may not book gateway methods ───────────────
    console.log("\nManual records");
    r = await api("/sync/push", { method: "POST", token, body: { operations: [{ uuid: uuid(), type: "payment.create", payload: { customerId: customer.id, amountCents: 1000, method: "MPESA_STK", reference: "X" } }] } });
    let res0 = r.json?.data?.results?.[0];
    check("Sync push of a gateway method is refused", res0?.status === "failed" && /booked by the gateway/.test(res0?.error ?? ""), JSON.stringify(res0));
    r = await api("/sync/push", { method: "POST", token, body: { operations: [{ uuid: `intent:${uuid()}`, type: "payment.create", payload: { customerId: customer.id, amountCents: 1000, method: "CASH" } }] } });
    res0 = r.json?.data?.results?.[0];
    check("Sync push under an intent: uuid is refused", res0?.status === "failed", JSON.stringify(res0));
    r = await api("/payments", { method: "POST", token, body: { customerId: customer.id, amountCents: 1000, method: "PAYSTACK", clientUuid: uuid() } });
    check("REST POST /payments with a gateway method is a 422", r.status === 422, `${r.status}`);
    r = await api("/payments", { method: "POST", token, body: { customerId: customer.id, amountCents: 1000, method: "CASH", clientUuid: `intent:${uuid()}` } });
    check("REST POST /payments with an intent: clientUuid is a 422", r.status === 422, `${r.status}`);
    r = await api("/payments", { method: "POST", token, body: { customerId: customer.id, amountCents: 1000, method: "MPESA", reference: "paid-cash", clientUuid: uuid() } });
    check("A manual MPESA record needs a 10-character code", r.status === 422 && r.json?.error?.code === "INVALID_REFERENCE", r.json?.error?.message);
    const code = `QH${Date.now().toString(36).toUpperCase()}`.slice(0, 10).padEnd(10, "Z");
    r = await api("/payments", { method: "POST", token, body: { customerId: customer.id, amountCents: 1000, method: "MPESA", reference: code.toLowerCase(), clientUuid: uuid() } });
    check("…and is accepted with one, upper-cased", r.status === 201 && r.json?.data?.reference === code, `${r.status} ${r.json?.data?.reference}`);
    r = await api("/payments", { method: "POST", token, body: { customerId: customer.id, amountCents: 1000, method: "MPESA", reference: code, clientUuid: uuid() } });
    check("The same code again is a 409", r.status === 409 && r.json?.error?.code === "DUPLICATE_REFERENCE", r.json?.error?.message);
  } finally {
    console.log("\nRestore");
    if (!WITH_SERVER) {
      await deleteCred("MPESA_DARAJA");
      await deleteCred("PAYSTACK");
      console.log("  credentials removed");
    }
    await dctl({ reset: true }).catch(() => undefined);
    await pctl({ reset: true }).catch(() => undefined);
    if (daraja) await daraja.close();
    if (paystack) await paystack.close();
    if (prisma) await prisma.$disconnect();
  }

  // ── consistency ─────────────────────────────────────────────────────
  if (dbUrl) {
    console.log("\nConsistency");
    const result = spawnSync(process.execPath, [path.join(ROOT, "scripts", "check-consistency.mjs"), "--quiet"], {
      cwd: ROOT,
      env: { ...process.env, DATABASE_URL: dbUrl },
      encoding: "utf8",
    });
    check("check-consistency.mjs passes on the database the test wrote to", result.status === 0, result.status === 0 ? "" : (result.stdout + result.stderr).slice(-1500));
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exitCode = failed === 0 ? 0 : 1;
}

/**
 * A platform of our own, from a scratch copy of the sources, on a copy of the
 * dev database — so the test can run while someone else's `next dev` is up
 * from the checkout, and the shared database is never touched.
 */
async function withServer(fn) {
  const port = Number(new URL(BASE).port || 3290);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "raut-payments-smoke-"));
  const scratch = path.join(tmp, "platform");
  fs.mkdirSync(scratch);

  for (const dir of ["src", "prisma", "scripts", "public"]) {
    if (fs.existsSync(path.join(ROOT, dir))) fs.cpSync(path.join(ROOT, dir), path.join(scratch, dir), { recursive: true, filter: (src) => !/[\\/]xos\.db(-journal)?$/.test(src) });
  }
  for (const file of ["package.json", "tsconfig.json", "next.config.ts", "postcss.config.mjs", "tailwind.config.ts", "next-env.d.ts"]) {
    if (fs.existsSync(path.join(ROOT, file))) fs.copyFileSync(path.join(ROOT, file), path.join(scratch, file));
  }
  fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(scratch, "node_modules"), "junction");

  const dbFile = path.join(tmp, "xos.db");
  fs.copyFileSync(path.join(ROOT, "prisma", "xos.db"), dbFile);
  dbUrl = `file:${dbFile.replace(/\\/g, "/")}`;

  const env = {
    ...process.env,
    DATABASE_URL: dbUrl,
    AUTH_SECRET: process.env.AUTH_SECRET ?? readEnvFile("AUTH_SECRET") ?? randomBytes(24).toString("hex"),
    CREDENTIALS_KEY: process.env.CREDENTIALS_KEY ?? readEnvFile("CREDENTIALS_KEY") ?? randomBytes(32).toString("base64"),
    MPESA_BASE_URL: `http://127.0.0.1:${DARAJA_PORT}`,
    PAYSTACK_BASE_URL: `http://127.0.0.1:${PAYSTACK_PORT}`,
    PAYMENTS_RUNNER_TOKEN: RUNNER_TOKEN,
    PAYMENTS_TIMEOUT_MS: process.env.PAYMENTS_TIMEOUT_MS ?? "1500",
    PAYMENTS_ALLOW_CUSTOM_HOSTS: "1",
    PAYMENTS_INITIATE_PER_MINUTE: "500",
    PUBLIC_BASE_URL: `http://localhost:${port}`,
    SMS_PROVIDER: "console",
    NEXT_TELEMETRY_DISABLED: "1",
  };
  // The platform's own gateway keys must not leak in: the test exercises the
  // tenant-credential path.
  for (const k of Object.keys(env)) if (/^(PAYSTACK_(SECRET|PUBLIC)_KEY|MPESA_(CONSUMER|SHORTCODE|PASSKEY)|KCB_)/.test(k)) delete env[k];

  console.log(`Starting next dev on :${port} from ${scratch} against ${dbFile}`);
  const child = spawn(process.platform === "win32" ? "npx.cmd" : "npx", ["next", "dev", "-p", String(port)], {
    cwd: scratch,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  });
  let output = "";
  const serverLog = path.join(tmp, "server.log");
  child.stdout.on("data", (d) => { output += d; fs.appendFileSync(serverLog, d); });
  child.stderr.on("data", (d) => { output += d; fs.appendFileSync(serverLog, d); });

  const stop = () =>
    new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.on("exit", () => resolve());
      if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      else child.kill("SIGTERM");
      setTimeout(resolve, 5000);
    });

  try {
    const deadline = Date.now() + 180_000;
    let up = false;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) break;
      try {
        const r = await fetch(`${BASE}/api/v1/health`);
        if (r.ok) {
          up = true;
          break;
        }
      } catch {
        /* not yet */
      }
      await sleep(1000);
    }
    if (!up) {
      console.error(output.slice(-4000));
      throw new Error(`Platform did not come up on ${BASE}`);
    }
    return await fn();
  } finally {
    // Anything the platform logged as unhandled is worth seeing with the result.
    const noisy = output.split(/\r?\n/).filter((l) => /\[api\] unhandled|\[payments\]|Error:|PrismaClient/.test(l));
    if (noisy.length > 0) {
      console.log(`\nServer log (${noisy.length} notable lines):`);
      for (const l of noisy.slice(-40)) console.log(`  ${l.slice(0, 300)}`);
    }
    await stop();
    await sleep(500);
    for (let i = 0; i < 5; i++) {
      try {
        fs.rmSync(tmp, { recursive: true, force: true });
        break;
      } catch {
        await sleep(1000);
      }
    }
  }
}

function readEnvFile(key) {
  try {
    const line = fs
      .readFileSync(path.join(ROOT, ".env"), "utf8")
      .split(/\r?\n/)
      .find((l) => l.startsWith(`${key}=`));
    return line ? line.slice(key.length + 1).replace(/^"|"$/g, "") : undefined;
  } catch {
    return undefined;
  }
}

(WITH_SERVER ? withServer(main) : main()).catch((error) => {
  console.error(error);
  process.exit(1);
});
