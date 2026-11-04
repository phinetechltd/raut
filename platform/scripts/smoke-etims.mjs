/**
 * End-to-end eTIMS smoke test: the platform against a mock Digitax.
 *
 *   node scripts/smoke-etims.mjs [baseUrl]        (default http://localhost:3250)
 *
 * Starts `mock-digitax.mjs` in-process (or uses MOCK_DIGITAX_URL if set), then
 * drives the real API: stores a Digitax credential for the demo company,
 * switches eTIMS on, and walks every path a flaky tax API can take — happy,
 * PENDING-then-COMPLETED, timeout-that-landed, 409, give-up, callbacks, the
 * runner — asserting over HTTP that no sale is ever filed twice.
 *
 * The platform under test must be started with:
 *
 *   DIGITAX_BASE_URL=http://127.0.0.1:4700/ke/v2   (the mock)
 *   ETIMS_RUNNER_TOKEN=<token>                      (same value as this script's ETIMS_RUNNER_TOKEN)
 *   ETIMS_TIMEOUT_MS=1500  ETIMS_BACKOFF_BASE_MS=0  (so timeouts and retries happen inside the test)
 *   CREDENTIALS_KEY=<32 bytes, base64>              (so a credential can be stored)
 *
 * and, to keep the shared dev database untouched, a DATABASE_URL pointing at a
 * copy. `--with-server` (what `npm run test:etims` passes) does all of that:
 * copies prisma/xos.db to the temp directory, starts `next dev -p 3250` with
 * the environment above, runs the test and stops the server again.
 *
 * Everything the test changes on the company — credential, config — is put
 * back at the end.
 *
 * One caveat for `--with-server`: `next dev` writes to `.next/` in the
 * checkout, and two dev servers sharing one `.next` clobber each other's
 * routes (404s and "Cannot find module for page"). Run it when no other
 * `next dev` is running from this directory, or start your own server with the
 * environment above and point this script at it instead.
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { startMock } from "./mock-digitax.mjs";

const args = process.argv.slice(2);
const WITH_SERVER = args.includes("--with-server");
const BASE = args.find((a) => !a.startsWith("--")) ?? "http://localhost:3250";
const RUNNER_TOKEN = process.env.ETIMS_RUNNER_TOKEN ?? "smoke-runner-token";
const MOCK_PORT = Number(process.env.MOCK_DIGITAX_PORT ?? 4700);
const PASSWORD = "Raut@2026";
const PIN = "P051234567X";

let passed = 0;
let failed = 0;

function check(name, condition, detail = "") {
  if (condition) {
    passed++;
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function api(path, { method = "GET", token, body, headers = {} } = {}) {
  const res = await fetch(`${BASE}/api/v1${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

const uuid = () => `smoke-etims-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log(`\nRaut eTIMS smoke test → ${BASE}\n`);

  // ── mock ────────────────────────────────────────────────────────────
  let mock;
  let mockUrl = process.env.MOCK_DIGITAX_URL;
  if (!mockUrl) {
    mock = await startMock({ port: MOCK_PORT });
    mockUrl = mock.url;
  }
  const control = async (body) => (await fetch(`${mockUrl}/__control`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
  const mockLog = async () => (await (await fetch(`${mockUrl}/__control`)).json()).requests;
  const salePostsFor = async (number) =>
    (await mockLog()).filter((r) => r.method === "POST" && r.path === "/sales-with-items" && r.body?.trader_invoice_number === number);
  const notePostsFor = async (number) =>
    (await mockLog()).filter((r) => r.method === "POST" && r.path === "/credit-notes" && r.body?.trader_invoice_number === number);
  await control({ reset: true });
  console.log(`Mock Digitax at ${mockUrl}`);

  // ── sign in ─────────────────────────────────────────────────────────
  console.log("\nSetup");
  const health = await api("/health");
  check("Platform is healthy", health.json?.data?.status === "healthy");

  const login = await api("/auth/login", { method: "POST", body: { email: "admin@tarisolutions.co.ke", password: PASSWORD } });
  const token = login.json?.data?.accessToken;
  check("Admin signs in", Boolean(token), login.json?.error?.message ?? "");
  if (!token) throw new Error("cannot continue without a session");

  const original = (await api("/etims/config", { token })).json?.data?.config ?? null;
  const customers = (await api("/customers?limit=5", { token })).json?.data ?? [];
  const products = (await api("/products?limit=5", { token })).json?.data ?? [];
  const customer = customers.find((c) => !c.taxPin) ?? customers[0];
  const product = products.find((p) => p.active !== false) ?? products[0];
  check("A customer and a product are available", Boolean(customer?.id && product?.id));

  const invoiceOf = async (id) => (await api(`/invoices/${id}`, { token })).json?.data?.invoice;
  const raise = async (quantity = 3, unitPriceCents = 10_000) => {
    const r = await api("/invoices", {
      method: "POST",
      token,
      body: { customerId: customer.id, issue: true, clientUuid: uuid(), lines: [{ productId: product.id, quantity, unitPriceCents }] },
    });
    const id = r.json?.data?.invoice?.id ?? r.json?.data?.id;
    return { status: r.status, id, invoice: id ? await invoiceOf(id) : null };
  };
  const run = () => api("/etims/run", { method: "POST", headers: { Authorization: `Bearer ${RUNNER_TOKEN}` } });
  const transmit = (docType, docId) => api("/etims/transmit", { method: "POST", token, body: { docType, docId } });

  try {
    // ── credentials ───────────────────────────────────────────────────
    console.log("\nCredentials");
    const saved = await api("/settings/credentials", {
      method: "POST",
      token,
      body: { provider: "DIGITAX", values: { DIGITAX_API_KEY: "smoke-api-key", DIGITAX_TIN: PIN } },
    });
    check("A Digitax credential can be stored", saved.status === 200, saved.json?.error?.message ?? "");

    let test = await api("/settings/credentials", { method: "PATCH", token, body: { provider: "DIGITAX", action: "test" } });
    check("Testing the key asks Digitax who it belongs to", test.json?.data?.ok === true && /Authenticated as P051234567X/.test(test.json?.data?.note ?? ""), test.json?.data?.note);
    check("The test hit GET /etims-info with the key", (await mockLog()).some((r) => r.path === "/etims-info" && r.headers["x-api-key"] === "smoke-api-key"));

    await control({ taxPin: "A000000000Z" });
    test = await api("/settings/credentials", { method: "PATCH", token, body: { provider: "DIGITAX", action: "test" } });
    check("A key registered to another PIN fails the test, naming both", test.json?.data?.ok === false && /belongs to PIN A000000000Z, not P051234567X/.test(test.json?.data?.note ?? ""), test.json?.data?.note);
    await control({ taxPin: PIN });

    // A malformed TIN is refused where it is typed, so it can never reach the
    // test action or the enable switch; the stored, valid TIN stays in force.
    const badSave = await api("/settings/credentials", { method: "POST", token, body: { provider: "DIGITAX", values: { DIGITAX_API_KEY: "smoke-api-key", DIGITAX_TIN: "NOT-A-PIN" } } });
    check("A malformed TIN is refused at save (422 INVALID_KRA_PIN)", badSave.status === 422 && badSave.json?.error?.code === "INVALID_KRA_PIN", `HTTP ${badSave.status} ${badSave.json?.error?.code ?? ""}`);
    test = await api("/settings/credentials", { method: "PATCH", token, body: { provider: "DIGITAX", action: "test" } });
    check("The stored TIN is untouched by a refused save", test.json?.data?.ok === true && /Authenticated as P051234567X/.test(test.json?.data?.note ?? ""), test.json?.data?.note);

    // ── configuration ─────────────────────────────────────────────────
    console.log("\nConfiguration");
    const yesterday = new Date(Date.now() - 86_400_000).toISOString();
    const on = await api("/etims/config", { method: "PUT", token, body: { enabled: true, environment: "SANDBOX", autoTransmit: true, activeFrom: yesterday } });
    check("eTIMS switched on against the mock", on.status === 200 && on.json?.data?.config?.enabled === true, on.json?.error?.message ?? "");
    const cfg = await api("/etims/config", { token });
    check("The settings report the stored PIN as valid", cfg.json?.data?.taxPinValid === true && cfg.json?.data?.taxPin === PIN);

    const badTax = await api("/etims/config", { method: "PUT", token, body: { defaultTaxTypeCode: "Z" } });
    check("An unknown default tax type is a 422, not a 500", badTax.status === 422 && badTax.json?.error?.code === "INVALID_ETIMS_CODE", `HTTP ${badTax.status}`);
    const badClass = await api("/etims/config", { method: "PUT", token, body: { defaultItemClassCode: "12345678" } });
    check("A default classification outside the table is a 422", badClass.status === 422, `HTTP ${badClass.status}`);
    const badUnit = await api("/etims/config", { method: "PUT", token, body: { defaultQuantityUnit: "XX" } });
    check("An unknown quantity unit is a 422", badUnit.status === 422, `HTTP ${badUnit.status}`);

    const classified = await api(`/products/${product.id}`, { method: "PATCH", token, body: { etimsTaxTypeCode: "B", etimsItemClassCode: "99010000", etimsItemTypeCode: "2" } });
    check("A product's eTIMS classification can be set", classified.status === 200 && classified.json?.data?.etimsTaxTypeCode === "B" && classified.json?.data?.etimsItemClassCode === "99010000", `HTTP ${classified.status}`);
    const badProduct = await api(`/products/${product.id}`, { method: "PATCH", token, body: { etimsTaxTypeCode: "Q" } });
    check("A bad product tax type is a 422", badProduct.status === 422 && badProduct.json?.error?.code === "INVALID_ETIMS_CODE", `HTTP ${badProduct.status}`);
    const cleared = await api(`/products/${product.id}`, { method: "PATCH", token, body: { etimsTaxTypeCode: null, etimsItemClassCode: null, etimsItemTypeCode: null } });
    check("The override can be cleared back to the company default", cleared.status === 200 && cleared.json?.data?.etimsTaxTypeCode === null);

    // ── happy path ────────────────────────────────────────────────────
    console.log("\nHappy path");
    const a = await raise();
    check("An invoice issues and is filed on issue", a.status === 201 && a.invoice?.etimsStatus === "ACCEPTED", `HTTP ${a.status} status ${a.invoice?.etimsStatus} ${a.invoice?.etimsError ?? ""}`);
    check("It carries the mock's control code and QR", /^SIG/.test(a.invoice?.etimsControlCode ?? "") && Boolean(a.invoice?.etimsQrUrl));
    let posts = await salePostsFor(a.invoice?.number);
    check("Exactly one POST /sales-with-items reached Digitax", posts.length === 1, `${posts.length}`);
    check("It carried Idempotency-Key = trader invoice number", posts[0]?.headers["idempotency-key"] === a.invoice?.number);
    const item = posts[0]?.body?.items?.[0];
    check("The line references the Digitax item, not the local product id", typeof item?.id === "string" && item.id !== product.id && /^(itm-|KE1)/.test(item.id), item?.id);
    check("quantity × unit_price reconciles to total_amount to the cent", item && Math.round(item.quantity * item.unit_price * 100) === Math.round(item.total_amount * 100), `${item?.quantity} × ${item?.unit_price} = ${item?.total_amount}`);
    check("taxable_amount + tax_amount = total_amount", item && Math.round((item.taxable_amount + item.tax_amount) * 100) === Math.round(item.total_amount * 100));
    check("sale_date is a calendar date", /^\d{4}-\d{2}-\d{2}$/.test(posts[0]?.body?.sale_date ?? ""));

    const resend = await transmit("SALE", a.id);
    check("Re-sending an accepted invoice is a 200 no-op", resend.status === 200 && resend.json?.data?.ok === true);
    posts = await salePostsFor(a.invoice?.number);
    check("…and still only one POST", posts.length === 1, `${posts.length}`);

    const missing = await transmit("SALE", "does-not-exist");
    check("Transmitting something that is not filed is a 422 with a reason (mobile contract)", missing.status === 422 && missing.json?.error?.code === "ETIMS_NOT_FILED", `HTTP ${missing.status} ${missing.json?.error?.code ?? ""}`);

    // ── PENDING then COMPLETED ────────────────────────────────────────
    console.log("\nPENDING at Digitax, completed later");
    await control({ mode: "pending" });
    const b = await raise();
    check("A sale Digitax holds as PENDING stays QUEUED with its Digitax id", b.invoice?.etimsStatus === "QUEUED" && Boolean(b.invoice?.etimsSaleId), `status ${b.invoice?.etimsStatus} saleId ${b.invoice?.etimsSaleId}`);
    const pendingTransmit = await transmit("SALE", b.id);
    check("A manual send while PENDING is a 422 that says it is awaiting KRA", pendingTransmit.status === 422 && pendingTransmit.json?.error?.details?.status === "QUEUED", `HTTP ${pendingTransmit.status} ${pendingTransmit.json?.error?.message ?? ""}`);
    let r = await run();
    check("The runner reads it back rather than re-posting", r.status === 200 && (await salePostsFor(b.invoice?.number)).length === 1, `HTTP ${r.status}`);
    check("…and reports it as awaiting", (r.json?.data?.awaiting ?? 0) >= 1, JSON.stringify(r.json?.data));
    await control({ completePending: true, mode: "ok" });
    r = await run();
    const bAfter = await invoiceOf(b.id);
    check("Once KRA completes it the runner marks it ACCEPTED", bAfter?.etimsStatus === "ACCEPTED" && Boolean(bAfter?.etimsControlCode), `status ${bAfter?.etimsStatus}`);
    check("With exactly one POST across the whole episode", (await salePostsFor(b.invoice?.number)).length === 1);

    // ── credit note waits for the invoice ─────────────────────────────
    console.log("\nCredit note behind a pending invoice");
    await control({ mode: "pending" });
    const c = await raise(2, 5_000);
    await control({ mode: "ok" });
    const cInvoice = await invoiceOf(c.id);
    const cnUuid = uuid();
    const cnBody = { invoiceId: c.id, reason: "Smoke: returned", restock: false, clientUuid: cnUuid, lines: [{ invoiceLineId: cInvoice?.lines?.[0]?.id, quantity: 1 }] };
    const cn = await api("/credit-notes", { method: "POST", token, body: cnBody });
    const note = cn.json?.data?.creditNote;
    check("A credit note against a pending invoice is raised but waits", (cn.status === 200 || cn.status === 201) && note?.etimsStatus === "QUEUED" && /Waiting for invoice/.test(note?.etimsError ?? ""), `HTTP ${cn.status} ${note?.etimsStatus} ${note?.etimsError ?? cn.json?.error?.message ?? ""}`);
    check("No credit note was posted", (await notePostsFor(note?.number)).length === 0);
    const replay = await api("/credit-notes", { method: "POST", token, body: cnBody });
    check("Replaying the same clientUuid returns the same credit note, not a second one", replay.json?.data?.creditNote?.id === note?.id && replay.json?.data?.replayed === true, `${replay.json?.data?.creditNote?.id} vs ${note?.id}`);
    await control({ completePending: true });
    r = await run();
    const noteAfter = (await invoiceOf(c.id))?.creditNotes?.find((n) => n.id === note?.id);
    check("After the invoice completes, the sweep files the note", noteAfter?.etimsStatus === "ACCEPTED" && Boolean(noteAfter?.etimsControlCode), `status ${noteAfter?.etimsStatus}`);
    check("Exactly one POST /credit-notes", (await notePostsFor(note?.number)).length === 1);
    const notePost = (await notePostsFor(note?.number))[0];
    check("It references the Digitax sale id and carries its own Idempotency-Key", notePost?.body?.sale_id === (await invoiceOf(c.id))?.etimsSaleId && notePost?.headers["idempotency-key"] === note?.number);

    // ── timeout that landed ───────────────────────────────────────────
    console.log("\nA timeout that actually reached Digitax");
    await control({ mode: "timeout" });
    const d = await raise();
    check("The invoice still issues when Digitax does not answer", d.status === 201 && d.invoice?.etimsStatus === "QUEUED" && /Timed out/.test(d.invoice?.etimsError ?? ""), `status ${d.invoice?.etimsStatus}: ${d.invoice?.etimsError ?? ""}`);
    await control({ mode: "ok" });
    r = await run();
    const dAfter = await invoiceOf(d.id);
    check("The next attempt finds it by trader number instead of posting again", dAfter?.etimsStatus === "ACCEPTED" && (await salePostsFor(d.invoice?.number)).length === 1, `status ${dAfter?.etimsStatus}, posts ${(await salePostsFor(d.invoice?.number)).length}`);
    check("…via GET /sales?trader_invoice_number", (await mockLog()).some((x) => x.method === "GET" && x.path === `/sales?trader_invoice_number=${encodeURIComponent(d.invoice?.number)}`));

    // ── 409 ───────────────────────────────────────────────────────────
    console.log("\n409 from Digitax");
    await control({ mode: "conflict", lookupSupported: false });
    const e = await raise();
    check("A 409 the platform cannot read back is parked as SUBMITTED, never REJECTED", e.invoice?.etimsStatus === "SUBMITTED", `status ${e.invoice?.etimsStatus}: ${e.invoice?.etimsError ?? ""}`);
    const submittedTransmit = await transmit("SALE", e.id);
    check("A manual send of a SUBMITTED invoice is refused (422) and does not POST", submittedTransmit.status === 422 && (await salePostsFor(e.invoice?.number)).length === 1, `HTTP ${submittedTransmit.status}`);
    await control({ mode: "ok", lookupSupported: true });
    r = await run();
    const eAfter = await invoiceOf(e.id);
    check("Once it can be read back it is ACCEPTED with one POST in total", eAfter?.etimsStatus === "ACCEPTED" && (await salePostsFor(e.invoice?.number)).length === 1, `status ${eAfter?.etimsStatus}`);

    // ── give up ───────────────────────────────────────────────────────
    console.log("\nGiving up");
    await control({ mode: "error500" });
    const f = await raise();
    check("A 5xx leaves the invoice QUEUED with the error on it", f.invoice?.etimsStatus === "QUEUED" && /Internal Server Error/.test(f.invoice?.etimsError ?? ""), `${f.invoice?.etimsStatus}: ${f.invoice?.etimsError}`);
    let sawAllFailed = false;
    for (let i = 0; i < 8; i++) {
      r = await run();
      if (r.status === 502 && r.json?.error?.code === "ETIMS_RUN_FAILED") sawAllFailed = true;
      if ((await invoiceOf(f.id))?.etimsStatus === "REJECTED") break;
    }
    const fAfter = await invoiceOf(f.id);
    check("After eight attempts it is REJECTED with a clear message", fAfter?.etimsStatus === "REJECTED" && /Gave up after 8 attempts/.test(fAfter?.etimsError ?? ""), `${fAfter?.etimsStatus}: ${fAfter?.etimsError ?? ""}`);
    check("Eight POSTs, no more", (await salePostsFor(f.invoice?.number)).length === 8, `${(await salePostsFor(f.invoice?.number)).length}`);
    check("A sweep in which everything failed answers 502 ETIMS_RUN_FAILED", sawAllFailed);
    r = await run();
    check("The runner leaves a REJECTED invoice alone", (await salePostsFor(f.invoice?.number)).length === 8);
    await control({ mode: "ok" });
    const manual = await transmit("SALE", f.id);
    check("A person can retry it once the cause is fixed", manual.status === 200 && (await invoiceOf(f.id))?.etimsStatus === "ACCEPTED", `HTTP ${manual.status}`);

    const log = (await api("/etims/submissions", { token })).json?.data;
    const fRows = (log?.rows ?? []).filter((x) => x.docType === "SALE" && x.docId === f.id);
    check("Every attempt is in the log with its attempt number", fRows.length >= 9 && fRows.some((x) => x.attempt === 9) && fRows.every((x) => x.request), `${fRows.length} rows`);

    // ── callbacks ─────────────────────────────────────────────────────
    console.log("\nCallbacks");
    await control({ mode: "pending" });
    const g = await raise();
    await control({ mode: "ok", completePending: true });
    const forged = await api("/etims/callbacks", { method: "POST", body: { data: { id: g.invoice?.etimsSaleId, receipt_signature: "FORGED", status: "COMPLETED" } } });
    const gAfter = await invoiceOf(g.id);
    check("A callback makes the platform re-read the sale", forged.status === 200 && forged.json?.data?.reconciled === 1 && gAfter?.etimsStatus === "ACCEPTED", JSON.stringify(forged.json?.data));
    check("Nothing from the callback body is written to the invoice", gAfter?.etimsControlCode !== "FORGED" && /^SIG/.test(gAfter?.etimsControlCode ?? ""));
    check("…and it did not cause a POST", (await salePostsFor(g.invoice?.number)).length === 1);
    const byNumber = await api("/etims/callbacks", { method: "POST", body: { trader_invoice_number: g.invoice?.number } });
    check("A callback by trader number is accepted too", byNumber.status === 200 && byNumber.json?.data?.received === true);
    const unknown = await api("/etims/callbacks", { method: "POST", body: { id: "nope" } });
    check("An unknown reference is a 200 that says so", unknown.status === 200 && unknown.json?.data?.ignored === true);
    const burst = await Promise.all(Array.from({ length: 45 }, () => api("/etims/callbacks", { method: "POST", body: { id: "nope" }, headers: { "x-forwarded-for": "203.0.113.9" } })));
    check("A burst from one address is rate limited", burst.some((x) => x.status === 429), `${burst.filter((x) => x.status === 429).length} × 429`);

    // ── runner auth ───────────────────────────────────────────────────
    console.log("\nRunner");
    check("The runner refuses a missing token", (await api("/etims/run", { method: "POST" })).status === 401);
    check("The runner refuses a wrong token", (await api("/etims/run", { method: "POST", headers: { Authorization: "Bearer nope" } })).status === 401);
    r = await run();
    check("A quiet sweep is a 200 with a summary", r.status === 200 && typeof r.json?.data?.processed === "number" && Array.isArray(r.json?.data?.errors), JSON.stringify(r.json?.data));
  } finally {
    // ── restore ───────────────────────────────────────────────────────
    console.log("\nRestore");
    await api("/etims/config", { method: "PUT", token, body: { enabled: false } });
    const del = await api("/settings/credentials", { method: "PATCH", token, body: { provider: "DIGITAX", action: "delete" } });
    check("The Digitax credential is removed again", del.status === 200);
    if (original) {
      const back = await api("/etims/config", {
        method: "PUT",
        token,
        body: {
          enabled: original.enabled,
          environment: original.environment,
          autoTransmit: original.autoTransmit,
          activeFrom: original.activeFrom ?? null,
          defaultItemClassCode: original.defaultItemClassCode,
          defaultTaxTypeCode: original.defaultTaxTypeCode,
        },
      });
      check("The eTIMS settings are back as they were", back.status === 200 && back.json?.data?.config?.enabled === original.enabled, `HTTP ${back.status} ${back.json?.error?.message ?? ""}`);
    }
    await control({ reset: true });
    if (mock) await mock.close();
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exitCode = failed === 0 ? 0 : 1;
}

/**
 * Starts a platform of our own on a copy of the dev database, so the test can
 * run from a cold checkout and the shared database is never touched.
 */
async function withServer(fn) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const port = Number(new URL(BASE).port || 3250);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "raut-etims-smoke-"));
  const dbFile = path.join(tmp, "xos.db");
  fs.copyFileSync(path.join(root, "prisma", "xos.db"), dbFile);

  const env = {
    ...process.env,
    DATABASE_URL: `file:${dbFile.replace(/\\/g, "/")}`,
    DIGITAX_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/ke/v2`,
    ETIMS_RUNNER_TOKEN: RUNNER_TOKEN,
    ETIMS_TIMEOUT_MS: process.env.ETIMS_TIMEOUT_MS ?? "1500",
    ETIMS_BACKOFF_BASE_MS: "0",
    CREDENTIALS_KEY: process.env.CREDENTIALS_KEY ?? readEnvFile(root, "CREDENTIALS_KEY") ?? randomBytes(32).toString("base64"),
    PUBLIC_BASE_URL: `http://localhost:${port}`,
    NEXT_TELEMETRY_DISABLED: "1",
  };

  console.log(`Starting next dev on :${port} against ${dbFile}`);
  const child = spawn(process.platform === "win32" ? "npx.cmd" : "npx", ["next", "dev", "-p", String(port)], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  });
  let output = "";
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));

  const stop = () =>
    new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.on("exit", () => resolve());
      if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      else child.kill("SIGTERM");
      setTimeout(resolve, 5000);
    });

  try {
    const deadline = Date.now() + 120_000;
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
    await stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function readEnvFile(root, key) {
  try {
    const line = fs
      .readFileSync(path.join(root, ".env"), "utf8")
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
