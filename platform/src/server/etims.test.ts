import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

/**
 * The transmission state machine, end to end against a real database.
 *
 * Runs on a **copy** of the dev database in the OS temp directory, so nothing
 * here touches `prisma/xos.db`. The environment is set before the modules are
 * imported — Prisma reads `DATABASE_URL` when the client is constructed, and
 * `tsx` honours `process.env` — which is why every import below is dynamic.
 *
 * Digitax is a scripted `fetch`: each test says what the next calls return
 * and then asserts on what was sent. The thing every scenario is really
 * checking is the count of `POST /sales-with-items`: one, or none.
 */

const SOURCE_DB = path.resolve(__dirname, "../../prisma/xos.db");
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "raut-etims-test-"));
const TMP_DB = path.join(tmpDir, "xos.db");
fs.copyFileSync(SOURCE_DB, TMP_DB);

process.env.DATABASE_URL = `file:${TMP_DB.replace(/\\/g, "/")}?connection_limit=1`;
process.env.CREDENTIALS_KEY = crypto.randomBytes(32).toString("base64");
process.env.DIGITAX_BASE_URL = "http://digitax.mock/ke/v2";
process.env.ETIMS_BACKOFF_BASE_MS = "0";
process.env.ETIMS_TIMEOUT_MS = "60";
delete process.env.PUBLIC_BASE_URL;

type Db = (typeof import("@/lib/db"))["db"];
type Etims = typeof import("./etims");

let db: Db;
let etims: Etims;
let companyId: string;
let customerId: string;
let productIds: string[];
let locationId: string;

// ── scripted Digitax ─────────────────────────────────────────────────────

interface Call {
  method: string;
  path: string;
  body: Record<string, unknown> | undefined;
  headers: Record<string, string>;
}

type Reply = { status: number; json?: unknown; text?: string; hang?: boolean; delayMs?: number };
type Handler = (call: Call) => Reply | Promise<Reply>;

const calls: Call[] = [];
const handlers: Array<{ method: string; test: RegExp; handle: Handler }> = [];
const mockSales = new Map<string, Record<string, unknown>>(); // by sale id
const salesByTrader = new Map<string, string>(); // trader number → sale id

function on(method: string, test: RegExp, handle: Handler) {
  handlers.unshift({ method, test, handle });
}

function digitaxSale(trader: string, status: string) {
  const id = `dx-${crypto.randomUUID().slice(0, 8)}`;
  const sale = {
    id,
    trader_invoice_number: trader,
    status,
    receipt_signature: status === "COMPLETED" ? `SIG${id.toUpperCase()}` : null,
    invoice_number: 1234,
    serial_number: "KRACU0100000001",
    receipt_number: 77,
    etims_url: status === "COMPLETED" ? `https://etims.kra.go.ke/r/${id}` : null,
  };
  mockSales.set(id, sale);
  salesByTrader.set(trader, id);
  return sale;
}

/** The default Digitax: everything works, items register, sales complete. */
function defaultHandlers() {
  handlers.length = 0;
  on("POST", /^\/items$/, (c) => ({
    status: 201,
    json: { id: `item-${crypto.randomUUID().slice(0, 6)}`, etims_item_code: `KE1${String(c.body?.item_name).slice(0, 4).toUpperCase()}`, status: "COMPLETE" },
  }));
  on("POST", /^\/customers$/, () => ({ status: 201, json: { id: `cust-${crypto.randomUUID().slice(0, 6)}` } }));
  on("POST", /^\/sales-with-items$/, (c) => {
    const trader = String(c.body?.trader_invoice_number);
    if (salesByTrader.has(trader)) return { status: 409, json: { message: "Sale with this trader_invoice_number already exists" } };
    return { status: 201, json: digitaxSale(trader, "COMPLETED") };
  });
  on("POST", /^\/credit-notes$/, (c) => {
    const trader = String(c.body?.trader_invoice_number);
    if (!mockSales.has(String(c.body?.sale_id))) return { status: 400, json: { message: "Unknown sale_id" } };
    if (salesByTrader.has(trader)) return { status: 409, json: { message: "duplicate" } };
    return { status: 201, json: digitaxSale(trader, "COMPLETED") };
  });
  on("GET", /^\/sales\/([^?]+)$/, (c) => {
    const id = decodeURIComponent(c.path.split("/")[2]);
    const sale = mockSales.get(id);
    return sale ? { status: 200, json: sale } : { status: 404, json: { message: "Not found" } };
  });
  on("GET", /^\/sales\?trader_invoice_number=/, (c) => {
    const trader = decodeURIComponent(c.path.split("=")[1]);
    const id = salesByTrader.get(trader);
    return id ? { status: 200, json: { data: [mockSales.get(id)] } } : { status: 200, json: { data: [] } };
  });
  on("PUT", /^\/stock\/adjust$/, () => ({ status: 200, json: { stock_quantity: 10 } }));
  on("GET", /^\/etims-info$/, () => ({ status: 200, json: { tax_pin: "P051234567X", branch_office_name: "HQ" } }));
}

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  const rel = url.pathname.replace(/^\/ke\/v2/, "") + url.search;
  const call: Call = {
    method: init?.method ?? "GET",
    path: rel,
    body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined,
    headers: Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]),
    ),
  };
  calls.push(call);
  const h = handlers.find((x) => x.method === call.method && x.test.test(rel));
  if (!h) return new Response(JSON.stringify({ message: `mock: no route ${call.method} ${rel}` }), { status: 404 });
  const reply = await h.handle(call);
  if (reply.hang) {
    return new Promise<Response>((_r, reject) => {
      init?.signal?.addEventListener("abort", () => {
        const e = new Error("aborted");
        e.name = "AbortError";
        reject(e);
      });
    });
  }
  if (reply.delayMs) await new Promise((r) => setTimeout(r, reply.delayMs));
  const text = reply.text ?? JSON.stringify(reply.json ?? {});
  return new Response(text, { status: reply.status, headers: { "content-type": "application/json" } });
}) as typeof fetch;

/** POSTs of sales — optionally only those for one trader invoice number. */
const salePosts = (number?: string) =>
  calls.filter(
    (c) => c.method === "POST" && c.path === "/sales-with-items" && (!number || c.body?.trader_invoice_number === number),
  );
const notePosts = (number?: string) =>
  calls.filter(
    (c) => c.method === "POST" && c.path === "/credit-notes" && (!number || c.body?.trader_invoice_number === number),
  );

// ── fixtures ─────────────────────────────────────────────────────────────

let seq = 0;
async function makeInvoice(opts: {
  etimsStatus?: string;
  status?: string;
  lines?: Array<{ productId: string; quantity: number; unitPriceCents: number; discountCents?: number }>;
  issueDate?: Date;
  customerId?: string;
} = {}) {
  seq++;
  const lines = opts.lines ?? [{ productId: productIds[0], quantity: 3, unitPriceCents: 10_000 }];
  const computed = lines.map((l) => {
    const gross = l.quantity * l.unitPriceCents;
    const net = gross - (l.discountCents ?? 0);
    const tax = Math.round(net * 0.16);
    return { ...l, taxRateBp: 1600, lineTotalCents: net + tax, discountCents: l.discountCents ?? 0 };
  });
  const total = computed.reduce((s, l) => s + l.lineTotalCents, 0);
  return db.invoice.create({
    data: {
      companyId,
      customerId: opts.customerId ?? customerId,
      number: `TST-${process.pid}-${Date.now()}-${seq}`,
      status: opts.status ?? "ISSUED",
      issueDate: opts.issueDate ?? new Date(),
      subtotalCents: total,
      totalCents: total,
      etimsStatus: opts.etimsStatus ?? "QUEUED",
      lines: {
        create: computed.map((l) => ({
          productId: l.productId,
          description: "Test line",
          quantity: l.quantity,
          baseQuantity: l.quantity,
          unitPriceCents: l.unitPriceCents,
          discountCents: l.discountCents,
          taxRateBp: l.taxRateBp,
          lineTotalCents: l.lineTotalCents,
        })),
      },
    },
    include: { lines: true },
  });
}

async function makeCreditNote(invoice: { id: string; customerId: string; lines: Array<{ id: string; productId: string; lineTotalCents: number }> }) {
  seq++;
  const line = invoice.lines[0];
  return db.creditNote.create({
    data: {
      companyId,
      invoiceId: invoice.id,
      customerId: invoice.customerId,
      number: `CN-${process.pid}-${Date.now()}-${seq}`,
      status: "ISSUED",
      reason: "Test return",
      totalCents: line.lineTotalCents,
      lines: {
        create: [
          {
            productId: line.productId,
            invoiceLineId: line.id,
            description: "Returned",
            quantity: 1,
            baseQuantity: 1,
            unitPriceCents: 10_000,
            taxRateBp: 1600,
            lineTotalCents: Math.round(line.lineTotalCents / 3),
          },
        ],
      },
    },
  });
}

const invoiceOf = (id: string) => db.invoice.findUniqueOrThrow({ where: { id } });
const noteOf = (id: string) => db.creditNote.findUniqueOrThrow({ where: { id } });
const submissionsOf = (docType: string, docId: string) =>
  db.etimsSubmission.findMany({ where: { companyId, docType, docId }, orderBy: { createdAt: "asc" } });

// ── setup ────────────────────────────────────────────────────────────────

before(async () => {
  db = (await import("@/lib/db")).db;
  etims = await import("./etims");
  const { saveCredential } = await import("./credentials");

  // The company that has eTIMS licensed. Whether the switch happens to be on
  // in the dev database at this moment is not under test, so it is forced on.
  const licence = await db.companyModule.findFirstOrThrow({ where: { moduleKey: "ETIMS", enabled: true } });
  companyId = licence.companyId;
  await db.etimsConfig.upsert({
    where: { companyId },
    create: { companyId, enabled: true, environment: "SANDBOX", autoTransmit: true },
    update: {},
  });

  // Start from a quiet queue: whatever the dev database holds is not under test.
  await db.invoice.updateMany({ where: { companyId, etimsStatus: { in: ["QUEUED", "SUBMITTED"] } }, data: { etimsStatus: "NOT_APPLICABLE" } });
  await db.creditNote.updateMany({ where: { companyId, etimsStatus: { in: ["QUEUED", "SUBMITTED"] } }, data: { etimsStatus: "NOT_APPLICABLE" } });
  await db.etimsConfig.update({
    where: { companyId },
    data: { enabled: true, environment: "SANDBOX", autoTransmit: true, activeFrom: new Date(Date.now() - 60_000) },
  });

  await saveCredential({
    companyId,
    provider: "DIGITAX",
    values: { DIGITAX_API_KEY: "test-api-key", DIGITAX_TIN: "P051234567X" },
  });

  const customer = await db.customer.findFirstOrThrow({ where: { companyId, taxPin: null } });
  customerId = customer.id;
  productIds = (await db.product.findMany({ where: { companyId, active: true, trackStock: true }, take: 3, orderBy: { sku: "asc" } })).map((p) => p.id);
  locationId = (await db.stockLocation.findFirstOrThrow({ where: { companyId } })).id;
  assert.equal(productIds.length, 3);
});

beforeEach(() => {
  calls.length = 0;
  defaultHandlers();
});

after(async () => {
  await db.$disconnect();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── scenarios ────────────────────────────────────────────────────────────

describe("transmitInvoice", () => {
  it("files a queued invoice once, registering its items first, and records everything", async () => {
    const inv = await makeInvoice();
    const r = await etims.transmitInvoice(inv.id, companyId);
    assert.equal(r.ok, true, r.reason);

    const after = await invoiceOf(inv.id);
    assert.equal(after.etimsStatus, "ACCEPTED");
    assert.ok(after.etimsSaleId?.startsWith("dx-"));
    assert.ok(after.etimsControlCode);
    assert.ok(after.etimsQrUrl);
    assert.equal(after.etimsError, null);

    assert.equal(salePosts().length, 1);
    const sent = salePosts()[0];
    assert.equal(sent.headers["idempotency-key"], inv.number);
    assert.equal(sent.headers["x-api-key"], "test-api-key");
    const body = sent.body!;
    assert.equal(body.trader_invoice_number, inv.number);
    assert.equal(body.sale_date, new Date(inv.issueDate.getTime() + 3 * 3600_000).toISOString().slice(0, 10), "Nairobi calendar date");
    const item = (body.items as Array<Record<string, number | string>>)[0];
    assert.match(String(item.id), /^KE1/, "the Digitax item code, never the local product id");
    assert.equal(Math.round(Number(item.unit_price) * Number(item.quantity) * 100), Math.round(Number(item.total_amount) * 100));
    assert.equal(Math.round((Number(item.taxable_amount) + Number(item.tax_amount)) * 100), Math.round(Number(item.total_amount) * 100));
    assert.equal(item.item_tax_type_code, "B");

    const product = await db.product.findUniqueOrThrow({ where: { id: productIds[0] } });
    assert.equal(product.etimsStatus, "REGISTERED");
    assert.ok(product.etimsItemCode?.startsWith("KE1"));

    const subs = await submissionsOf("SALE", inv.id);
    assert.equal(subs.length, 1);
    assert.equal(subs[0].status, "ACCEPTED");
    assert.equal(subs[0].attempt, 1);
    assert.ok(subs[0].request);
  });

  it("is a no-op for an accepted invoice", async () => {
    const inv = await makeInvoice();
    await etims.transmitInvoice(inv.id, companyId);
    calls.length = 0;
    const r = await etims.transmitInvoice(inv.id, companyId, { manual: true });
    assert.equal(r.ok, true);
    assert.equal(calls.length, 0);
    assert.equal((await submissionsOf("SALE", inv.id)).length, 1);
  });

  it("refuses drafts, NOT_APPLICABLE and pre-start invoices without a POST", async () => {
    const draft = await makeInvoice({ status: "DRAFT" });
    const na = await makeInvoice({ etimsStatus: "NOT_APPLICABLE" });
    const old = await makeInvoice({ issueDate: new Date(Date.now() - 7 * 86_400_000) });
    const cancelled = await makeInvoice({ status: "CANCELLED" });

    for (const inv of [draft, na, old, cancelled]) {
      const r = await etims.transmitInvoice(inv.id, companyId, { manual: true });
      assert.equal(r.ok, false, inv.id);
    }
    assert.equal(salePosts().length, 0);
    assert.equal((await invoiceOf(old.id)).etimsStatus, "NOT_APPLICABLE", "pre-start is parked, with a reason");
    assert.match((await invoiceOf(old.id)).etimsError ?? "", /before the eTIMS start date/);
    assert.equal((await invoiceOf(cancelled.id)).etimsStatus, "NOT_APPLICABLE");
  });

  it("reconciles a sale left PENDING at Digitax via GET, never a second POST", async () => {
    let pendingId = "";
    on("POST", /^\/sales-with-items$/, (c) => {
      const sale = digitaxSale(String(c.body?.trader_invoice_number), "PENDING");
      pendingId = String(sale.id);
      return { status: 201, json: sale };
    });

    const inv = await makeInvoice();
    const r1 = await etims.transmitInvoice(inv.id, companyId);
    assert.equal(r1.ok, false);
    assert.equal(r1.status, "QUEUED");
    let after = await invoiceOf(inv.id);
    assert.equal(after.etimsStatus, "QUEUED");
    assert.equal(after.etimsSaleId, pendingId);
    assert.match(after.etimsError ?? "", /Awaiting KRA/);
    assert.equal((await submissionsOf("SALE", inv.id))[0].status, "SENT", "not ACCEPTED until KRA says so");

    // KRA answers.
    mockSales.get(pendingId)!.status = "COMPLETED";
    mockSales.get(pendingId)!.receipt_signature = "SIGNED";

    const r2 = await etims.transmitInvoice(inv.id, companyId);
    assert.equal(r2.ok, true, r2.reason);
    after = await invoiceOf(inv.id);
    assert.equal(after.etimsStatus, "ACCEPTED");
    assert.equal(after.etimsControlCode, "SIGNED");

    assert.equal(salePosts().length, 1, "exactly one POST across both calls");
    assert.equal(calls.filter((c) => c.method === "GET" && c.path === `/sales/${pendingId}`).length, 1);
  });

  it("never re-sends a SUBMITTED invoice; it is read back by its number", async () => {
    const inv = await makeInvoice({ etimsStatus: "SUBMITTED" });
    // Nothing at Digitax under that number yet.
    let r = await etims.transmitInvoice(inv.id, companyId, { manual: true });
    assert.equal(r.ok, false);
    assert.equal((await invoiceOf(inv.id)).etimsStatus, "SUBMITTED");
    assert.equal(salePosts().length, 0);

    // Now Digitax does have it.
    digitaxSale(inv.number, "COMPLETED");
    r = await etims.transmitInvoice(inv.id, companyId, { manual: true });
    assert.equal(r.ok, true, r.reason);
    assert.equal((await invoiceOf(inv.id)).etimsStatus, "ACCEPTED");
    assert.equal(salePosts().length, 0, "still no POST");
  });

  it("treats a 409 as filed and reconciles it, never as REJECTED", async () => {
    const inv = await makeInvoice();
    // Digitax already holds the sale (a previous attempt we never heard back from).
    digitaxSale(inv.number, "COMPLETED");

    const r = await etims.transmitInvoice(inv.id, companyId);
    assert.equal(r.ok, true, r.reason);
    const after = await invoiceOf(inv.id);
    assert.equal(after.etimsStatus, "ACCEPTED");
    assert.equal(after.etimsSaleId, salesByTrader.get(inv.number));
    assert.equal(salePosts().length, 1);
    const subs = await submissionsOf("SALE", inv.id);
    assert.equal(subs[0].httpStatus, 409);
    assert.equal(subs[0].status, "SENT");
  });

  it("parks a 409 it cannot read back as SUBMITTED, and a later sweep finishes it", async () => {
    on("GET", /^\/sales\?trader_invoice_number=/, () => ({ status: 404, json: { message: "lookup unsupported" } }));
    const inv = await makeInvoice();
    digitaxSale(inv.number, "COMPLETED");

    const r = await etims.transmitInvoice(inv.id, companyId);
    assert.equal(r.ok, false);
    assert.equal(r.status, "SUBMITTED");
    assert.equal((await invoiceOf(inv.id)).etimsStatus, "SUBMITTED");

    defaultHandlers();
    const summary = await etims.runPending();
    assert.equal((await invoiceOf(inv.id)).etimsStatus, "ACCEPTED");
    assert.equal(salePosts(inv.number).length, 1);
    assert.ok(summary.invoices >= 1);
  });

  it("looks a timed-out send up by trader number before posting again", async () => {
    // The first POST lands at Digitax but the answer never arrives.
    on("POST", /^\/sales-with-items$/, (c) => {
      digitaxSale(String(c.body?.trader_invoice_number), "COMPLETED");
      return { status: 0, hang: true };
    });
    const inv = await makeInvoice();
    const r1 = await etims.transmitInvoice(inv.id, companyId);
    assert.equal(r1.ok, false);
    assert.equal(r1.status, "QUEUED");
    const subs = await submissionsOf("SALE", inv.id);
    assert.equal(subs[0].status, "PENDING");
    assert.equal(subs[0].httpStatus, null);
    assert.match(subs[0].error ?? "", /Timed out/);

    defaultHandlers();
    const r2 = await etims.transmitInvoice(inv.id, companyId);
    assert.equal(r2.ok, true, r2.reason);
    assert.equal((await invoiceOf(inv.id)).etimsStatus, "ACCEPTED");
    assert.equal(salePosts().length, 1, "the second attempt asked instead of posting");
    assert.equal(calls.filter((c) => c.path.startsWith("/sales?trader_invoice_number=")).length, 1);
  });

  it("gives up after MAX_ATTEMPTS retryable failures and parks the invoice as REJECTED with a clear error", async () => {
    on("POST", /^\/sales-with-items$/, () => ({ status: 503, json: { message: "Service Unavailable" } }));
    const inv = await makeInvoice();

    for (let i = 1; i < etims.MAX_ATTEMPTS; i++) {
      const r = await etims.transmitInvoice(inv.id, companyId);
      assert.equal(r.status, "QUEUED", `attempt ${i} stays queued`);
    }
    const last = await etims.transmitInvoice(inv.id, companyId);
    assert.equal(last.ok, false);
    assert.equal(last.status, "REJECTED");
    const after = await invoiceOf(inv.id);
    assert.equal(after.etimsStatus, "REJECTED");
    assert.match(after.etimsError ?? "", new RegExp(`Gave up after ${etims.MAX_ATTEMPTS} attempts`));
    assert.match(after.etimsError ?? "", /retry manually/);
    assert.equal(salePosts().length, etims.MAX_ATTEMPTS);

    // The runner leaves it alone...
    calls.length = 0;
    await etims.runPending();
    assert.equal(salePosts().length, 0);
    assert.equal((await invoiceOf(inv.id)).etimsStatus, "REJECTED");

    // ...and a person can retry once the cause is fixed.
    defaultHandlers();
    const manual = await etims.transmitInvoice(inv.id, companyId, { manual: true });
    assert.equal(manual.ok, true, manual.reason);
    assert.equal((await invoiceOf(inv.id)).etimsStatus, "ACCEPTED");
  });

  it("rejects a permanent 4xx at once, with Digitax's reason", async () => {
    on("POST", /^\/sales-with-items$/, () => ({
      status: 422,
      json: { errors: { customer_tin: ["is not registered"] } },
    }));
    const inv = await makeInvoice();
    const r = await etims.transmitInvoice(inv.id, companyId);
    assert.equal(r.status, "REJECTED");
    assert.equal((await invoiceOf(inv.id)).etimsError, "customer_tin: is not registered");
    assert.equal((await submissionsOf("SALE", inv.id))[0].retryAfter, null);
  });

  it("makes exactly one POST when several callers transmit the same invoice at once", async () => {
    on("POST", /^\/sales-with-items$/, (c) => ({
      status: 201,
      json: digitaxSale(String(c.body?.trader_invoice_number), "COMPLETED"),
      delayMs: 150,
    }));
    const inv = await makeInvoice();

    const results = await Promise.all([
      etims.transmitInvoice(inv.id, companyId),
      etims.transmitInvoice(inv.id, companyId, { manual: true }),
      etims.transmitInvoice(inv.id, companyId),
      etims.transmitInvoice(inv.id, companyId, { manual: true }),
    ]);

    assert.equal(salePosts().length, 1, "the lock let one through");
    assert.equal(results.filter((r) => r.ok).length, 1);
    assert.equal(results.filter((r) => /already in progress/.test(r.reason ?? "")).length, 3);
    assert.equal((await invoiceOf(inv.id)).etimsStatus, "ACCEPTED");
    const subs = await submissionsOf("SALE", inv.id);
    assert.deepEqual(subs.map((s) => s.attempt), [1]);
    // The lock is released afterwards.
    assert.equal(await db.idempotencyKey.count({ where: { key: `etims-lock:SALE:${inv.id}` } }), 0);
  });

  it("does not send a sale whose item could not be registered, and the attempt is retryable", async () => {
    on("POST", /^\/items$/, () => ({ status: 400, json: { message: "item_class_code is not valid" } }));
    const inv = await makeInvoice({ lines: [{ productId: productIds[1], quantity: 1, unitPriceCents: 5000 }] });

    const r = await etims.transmitInvoice(inv.id, companyId);
    assert.equal(r.ok, false);
    assert.equal(r.status, "QUEUED");
    assert.equal(salePosts().length, 0, "no sale with a local product id");
    const after = await invoiceOf(inv.id);
    assert.equal(after.etimsStatus, "QUEUED");
    assert.match(after.etimsError ?? "", /not registered with eTIMS: item_class_code is not valid/);

    const product = await db.product.findUniqueOrThrow({ where: { id: productIds[1] } });
    assert.equal(product.etimsStatus, "FAILED");
    assert.equal(product.etimsItemCode, null);

    const sale = await submissionsOf("SALE", inv.id);
    assert.equal(sale.length, 1);
    assert.equal(sale[0].status, "PENDING");
    assert.equal(sale[0].request, null, "nothing was sent");

    // A permanent item rejection is not hammered on the next attempt...
    calls.length = 0;
    await etims.transmitInvoice(inv.id, companyId);
    assert.equal(calls.filter((c) => c.path === "/items").length, 0);

    // ...until the product is edited, after which it goes through.
    defaultHandlers();
    await db.product.update({ where: { id: productIds[1] }, data: { etimsItemClassCode: "99010000", etimsStatus: "UNREGISTERED", etimsError: null } });
    const ok = await etims.transmitInvoice(inv.id, companyId);
    assert.equal(ok.ok, true, ok.reason);
    assert.equal(salePosts().length, 1);
  });

  it("marks items REGISTERED only when Digitax says COMPLETE", async () => {
    on("POST", /^\/items$/, () => ({ status: 201, json: { id: "item-pending", status: "PENDING" } }));
    const inv = await makeInvoice({ lines: [{ productId: productIds[2], quantity: 2, unitPriceCents: 7500 }] });
    const r = await etims.transmitInvoice(inv.id, companyId);
    assert.equal(r.ok, true, r.reason);
    const product = await db.product.findUniqueOrThrow({ where: { id: productIds[2] } });
    assert.equal(product.etimsItemCode, "item-pending");
    assert.equal(product.etimsStatus, "PENDING", "Digitax has it; KRA has not confirmed");
    const item = await db.etimsSubmission.findFirst({ where: { companyId, docType: "ITEM", docId: productIds[2] }, orderBy: { createdAt: "desc" } });
    assert.equal(item?.status, "SENT");
  });

  it("rejects a sale to a customer with a malformed PIN with a readable error, without sending", async () => {
    const bad = await db.customer.create({
      data: { companyId, code: `BADPIN-${Date.now()}`, name: "Bad PIN Ltd", taxPin: "P0512345X" },
    });
    const inv = await makeInvoice({ customerId: bad.id });
    const r = await etims.transmitInvoice(inv.id, companyId);
    assert.equal(r.status, "REJECTED");
    assert.match((await invoiceOf(inv.id)).etimsError ?? "", /"P0512345X", which is not a valid PIN/);
    assert.equal(salePosts().length, 0);
    assert.equal(calls.filter((c) => c.path === "/customers").length, 0);
  });
});

describe("queueInvoice", () => {
  it("queues an invoice with the configuration problem written on it rather than dropping it", async () => {
    await db.etimsConfig.update({ where: { companyId }, data: { environment: "LIVE" } });
    await db.tenantCredential.update({ where: { companyId_provider: { companyId, provider: "DIGITAX" } }, data: { active: false } });
    try {
      const inv = await makeInvoice({ etimsStatus: "NOT_APPLICABLE" });
      await etims.queueInvoice(inv.id, companyId);
      const after = await invoiceOf(inv.id);
      assert.equal(after.etimsStatus, "QUEUED");
      assert.match(after.etimsError ?? "", /no Digitax API key stored/);
      assert.equal(salePosts().length, 0);

      // transmit on a misconfigured company says why, and does not throw.
      const r = await etims.transmitInvoice(inv.id, companyId);
      assert.equal(r.ok, false);
      assert.match(r.reason ?? "", /no Digitax API key stored/);
    } finally {
      await db.etimsConfig.update({ where: { companyId }, data: { environment: "SANDBOX" } });
      await db.tenantCredential.update({ where: { companyId_provider: { companyId, provider: "DIGITAX" } }, data: { active: true } });
    }
  });

  it("auto-transmits a freshly issued invoice", async () => {
    const inv = await makeInvoice({ etimsStatus: "NOT_APPLICABLE" });
    await etims.queueInvoice(inv.id, companyId);
    assert.equal((await invoiceOf(inv.id)).etimsStatus, "ACCEPTED");
    assert.equal(salePosts().length, 1);
  });

  it("refuses a malformed stored TIN before anything is sent", async () => {
    const { saveCredential } = await import("./credentials");
    await saveCredential({ companyId, provider: "DIGITAX", values: { DIGITAX_API_KEY: "k", DIGITAX_TIN: "NOT-A-PIN" } });
    try {
      const inv = await makeInvoice({ etimsStatus: "NOT_APPLICABLE" });
      await etims.queueInvoice(inv.id, companyId);
      const after = await invoiceOf(inv.id);
      assert.equal(after.etimsStatus, "QUEUED");
      assert.match(after.etimsError ?? "", /"NOT-A-PIN" is not a valid KRA PIN/);
      assert.equal(calls.length, 0);
    } finally {
      await saveCredential({ companyId, provider: "DIGITAX", values: { DIGITAX_API_KEY: "test-api-key", DIGITAX_TIN: "P051234567X" } });
    }
  });
});

describe("credit notes", () => {
  it("waits for the invoice to be accepted, then files once", async () => {
    on("POST", /^\/sales-with-items$/, (c) => ({
      status: 201,
      json: digitaxSale(String(c.body?.trader_invoice_number), "PENDING"),
    }));
    const inv = await makeInvoice();
    await etims.transmitInvoice(inv.id, companyId);
    assert.equal((await invoiceOf(inv.id)).etimsStatus, "QUEUED");
    // The sweep below also drains whatever else is queued, so the sale under
    // test is found by its own number rather than by "the last one posted".
    const pendingId = salesByTrader.get(inv.number)!;
    assert.equal((await invoiceOf(inv.id)).etimsSaleId, pendingId);

    const note = await makeCreditNote(inv);
    await etims.queueCreditNote(note.id, companyId);
    let n = await noteOf(note.id);
    assert.equal(n.etimsStatus, "QUEUED");
    assert.match(n.etimsError ?? "", /Waiting for invoice/);

    const blocked = await etims.transmitCreditNote(note.id, companyId, { manual: true });
    assert.equal(blocked.ok, false);
    assert.match(blocked.reason ?? "", /Waiting for invoice/);
    assert.equal(notePosts().length, 0);

    // The runner does not pick a blocked note at all.
    let summary = await etims.runPending();
    assert.equal(notePosts().length, 0);
    assert.equal(salePosts(inv.number).length, 1, "and the invoice was not re-posted");

    // KRA completes the sale; the next sweep reconciles the invoice and then files the note.
    mockSales.get(pendingId)!.status = "COMPLETED";
    mockSales.get(pendingId)!.receipt_signature = "OK";
    summary = await etims.runPending();
    assert.equal((await invoiceOf(inv.id)).etimsStatus, "ACCEPTED");
    n = await noteOf(note.id);
    assert.equal(n.etimsStatus, "ACCEPTED", n.etimsError ?? "");
    assert.ok(n.etimsControlCode);
    assert.equal(notePosts().length, 1);
    assert.ok(summary.creditNotes >= 1);
    assert.equal(notePosts()[0].body?.sale_id, pendingId);
    assert.equal(notePosts()[0].headers["idempotency-key"], note.number);
    const items = notePosts()[0].body?.items as Array<Record<string, number>>;
    assert.equal(Math.round(items[0].unit_price * items[0].quantity * 100), Math.round(items[0].total_amount * 100));
  });

  it("backs off, caps attempts and reconciles a 409 like an invoice", async () => {
    const inv = await makeInvoice();
    await etims.transmitInvoice(inv.id, companyId);
    const note = await makeCreditNote(inv);
    await etims.queueCreditNote(note.id, companyId);

    on("POST", /^\/credit-notes$/, () => ({ status: 500, json: { message: "boom" } }));
    for (let i = 0; i < etims.MAX_ATTEMPTS; i++) await etims.transmitCreditNote(note.id, companyId);
    let n = await noteOf(note.id);
    assert.equal(n.etimsStatus, "REJECTED");
    assert.match(n.etimsError ?? "", /Gave up after/);
    const subs = await submissionsOf("CREDIT_NOTE", note.id);
    assert.equal(subs.length, etims.MAX_ATTEMPTS);
    assert.ok(subs.every((s) => s.status === "PENDING" && s.retryAfter !== null));

    // Digitax actually has it: manual retry gets a 409 and reconciles.
    defaultHandlers();
    digitaxSale(note.number, "COMPLETED");
    const r = await etims.transmitCreditNote(note.id, companyId, { manual: true });
    assert.equal(r.ok, true, r.reason);
    n = await noteOf(note.id);
    assert.equal(n.etimsStatus, "ACCEPTED");
    assert.notEqual(n.etimsStatus, "REJECTED");
  });

  it("does not file a note against an invoice that was never marked for filing", async () => {
    const inv = await makeInvoice({ etimsStatus: "NOT_APPLICABLE" });
    const note = await makeCreditNote(inv);
    await etims.queueCreditNote(note.id, companyId);
    assert.equal((await noteOf(note.id)).etimsStatus, "NOT_APPLICABLE");
    const r = await etims.transmitCreditNote(note.id, companyId, { manual: true });
    assert.equal(r.ok, false);
    assert.equal(notePosts().length, 0);
  });
});

describe("runPending", () => {
  it("reports a summary, honours backoff and does not starve the queue behind deferred documents", async () => {
    process.env.ETIMS_BACKOFF_BASE_MS = "600000";
    try {
      on("POST", /^\/sales-with-items$/, (c) => {
        if (String(c.body?.trader_invoice_number).includes("-A-")) return { status: 503, json: { message: "down" } };
        return { status: 201, json: digitaxSale(String(c.body?.trader_invoice_number), "COMPLETED") };
      });
      // Three that will fail and be deferred, then one that can go.
      const failing: string[] = [];
      for (let i = 0; i < 3; i++) {
        const inv = await makeInvoice();
        await db.invoice.update({ where: { id: inv.id }, data: { number: `${inv.number}-A-${i}` } });
        failing.push(inv.id);
      }
      const good = await makeInvoice();

      let s = await etims.runPending(2);
      // The limit counts documents *attempted*, not rows read, so a tiny limit
      // still works its way past the failing ones to the good one.
      assert.equal(s.processed, 2);
      assert.ok(typeof s.durationMs === "number");
      let rounds = 0;
      while ((await invoiceOf(good.id)).etimsStatus !== "ACCEPTED" && rounds++ < 6) s = await etims.runPending(2);
      assert.equal((await invoiceOf(good.id)).etimsStatus, "ACCEPTED");
      for (const id of failing) assert.equal((await invoiceOf(id)).etimsStatus, "QUEUED");
      assert.equal(salePosts().filter((c) => String(c.body?.trader_invoice_number).includes("-A-")).length, 3, "each failing one was tried once");

      // Now everything failing is inside its backoff: none of them is attempted.
      calls.length = 0;
      s = await etims.runPending();
      assert.equal(salePosts().filter((c) => String(c.body?.trader_invoice_number).includes("-A-")).length, 0);
      assert.ok(s.deferred >= 3, `deferred ${s.deferred}`);
      assert.ok(s.errors.every((e) => !failing.includes(e.docId)), "no failure reported for a deferred document");

      // Tidy: park them so later tests see a quiet queue.
      await db.invoice.updateMany({ where: { id: { in: failing } }, data: { etimsStatus: "NOT_APPLICABLE" } });
    } finally {
      process.env.ETIMS_BACKOFF_BASE_MS = "0";
    }
  });

  it("reports stock movements once, excludes accepted and rejected ones in the query, and does not swallow failures", async () => {
    await db.etimsConfig.update({ where: { companyId }, data: { activeFrom: new Date() } });
    await new Promise((r) => setTimeout(r, 5));
    const make = (quantity: number, type = "OPENING") =>
      db.stockMovement.create({ data: { companyId, productId: productIds[0], locationId, type, quantity, balanceAfter: quantity } });

    const okMove = await make(10);
    const badMove = await make(-4, "ADJUSTMENT");
    on("PUT", /^\/stock\/adjust$/, (c) => (c.body?.action === "DEDUCT" ? { status: 400, json: { message: "no stock" } } : { status: 200, json: { stock_quantity: 10 } }));

    let s = await etims.runPending();
    assert.equal(s.stock, 1);
    const stockErrors = s.errors.filter((e) => e.docType === "STOCK");
    assert.equal(stockErrors.length, 1);
    assert.equal(stockErrors[0].docId, badMove.id);
    assert.match(stockErrors[0].reason, /no stock/);
    assert.equal((await submissionsOf("STOCK", okMove.id))[0].status, "ACCEPTED");
    assert.equal((await submissionsOf("STOCK", badMove.id))[0].status, "REJECTED");

    // Neither is sent again.
    calls.length = 0;
    s = await etims.runPending();
    assert.equal(calls.filter((c) => c.path === "/stock/adjust").length, 0);
    assert.equal(s.stock, 0);

    // A retryable failure backs off and is retried later, up to the cap.
    const flaky = await make(3);
    on("PUT", /^\/stock\/adjust$/, () => ({ status: 503, json: { message: "later" } }));
    for (let i = 0; i < etims.MAX_ATTEMPTS; i++) await etims.runPending();
    assert.equal((await submissionsOf("STOCK", flaky.id)).length, etims.MAX_ATTEMPTS);
    calls.length = 0;
    await etims.runPending();
    assert.equal(calls.filter((c) => c.path === "/stock/adjust").length, 0, "capped");
  });
});

describe("callbacks", () => {
  it("reconcileInvoice reads the truth from Digitax rather than the hint", async () => {
    let pendingId = "";
    on("POST", /^\/sales-with-items$/, (c) => {
      const sale = digitaxSale(String(c.body?.trader_invoice_number), "PENDING");
      pendingId = String(sale.id);
      return { status: 201, json: sale };
    });
    const inv = await makeInvoice();
    await etims.transmitInvoice(inv.id, companyId);
    mockSales.get(pendingId)!.status = "COMPLETED";
    mockSales.get(pendingId)!.receipt_signature = "TRUTH";

    const r = await etims.reconcileInvoice(inv.id, companyId);
    assert.equal(r.ok, true);
    const after = await invoiceOf(inv.id);
    assert.equal(after.etimsControlCode, "TRUTH");
    assert.equal(salePosts().length, 1);

    // Nothing to reconcile for a never-sent document; nothing is posted.
    const fresh = await makeInvoice();
    const none = await etims.reconcileInvoice(fresh.id, companyId);
    assert.equal(none.ok, false);
    assert.equal(salePosts().length, 1);
  });
});
