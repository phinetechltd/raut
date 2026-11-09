import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

/**
 * Quotation lifecycle — create, edit-while-draft, status transitions and
 * conversion to an order or invoice — against a throwaway copy of the dev DB.
 */
const dir = mkdtempSync(path.join(tmpdir(), "xos-quote-"));
const file = path.join(dir, "xos.db");
copyFileSync(path.resolve(__dirname, "../../prisma/xos.db"), file);
process.env.DATABASE_URL = `file:${file.split(path.sep).join("/")}`;

type Quotes = typeof import("./quotations");
type Db = typeof import("@/lib/db")["db"];
type Principal = import("@/lib/rbac").Principal;

let q: Quotes;
let db: Db;
let admin: Principal;
let companyId: string;
let customerId: string;
let productIds: string[];

const rejectsStatus = (p: Promise<unknown>, status: number, pattern?: RegExp) =>
  assert.rejects(p, (error: unknown) => {
    const e = error as { status?: number; message: string };
    assert.equal(e.status, status, `expected ${status}, got ${e.status}: ${e.message}`);
    if (pattern) assert.match(e.message, pattern);
    return true;
  });

describe("quotations: lifecycle and conversion", () => {
  before(async () => {
    ({ db } = await import("@/lib/db"));
    q = await import("./quotations");
    const tari = await db.company.findUniqueOrThrow({ where: { slug: "tari" } });
    companyId = tari.id;
    const adminUser = await db.user.findFirstOrThrow({ where: { companyId, role: "COMPANY_ADMIN" } });
    admin = { userId: adminUser.id, companyId, role: "COMPANY_ADMIN", enabledModules: new Set(["SALES_POS", "CRM", "INVENTORY", "ETIMS"]) };
    const customer = await db.customer.findFirstOrThrow({ where: { companyId, status: "ACTIVE" } });
    customerId = customer.id;
    const products = await db.product.findMany({ where: { companyId, active: true }, take: 2 });
    productIds = products.map((p) => p.id);
  });

  after(async () => {
    await db.$disconnect();
  });

  const draftLines = () => [
    { productId: productIds[0]!, quantity: 3 },
    { productId: productIds[1]!, quantity: 1, unitPriceCents: 25_000, discountCents: 1_000 },
  ];

  it("creates a numbered draft with computed totals", async () => {
    const quote = await q.createQuotation(admin, { customerId, lines: draftLines() });
    assert.ok(quote.number.startsWith("QT-"));
    assert.equal(quote.status, "DRAFT");
    assert.equal(quote.lines.length, 2);
    assert.ok(quote.totalCents > 0);
    assert.equal(quote.subtotalCents - quote.discountCents + quote.taxCents, quote.totalCents, "totals balance");
  });

  it("can be created already sent", async () => {
    const quote = await q.createQuotation(admin, { customerId, lines: draftLines(), send: true });
    assert.equal(quote.status, "SENT");
  });

  it("edits only while a draft", async () => {
    const quote = await q.createQuotation(admin, { customerId, lines: draftLines() });
    const edited = await q.updateQuotation(admin, quote.id, { note: "Revised", lines: [{ productId: productIds[0]!, quantity: 10 }] });
    assert.equal(edited.note, "Revised");
    assert.equal(edited.lines.length, 1);
    assert.equal(edited.lines[0]!.quantity, 10);

    await q.setQuotationStatus(admin, quote.id, "SENT");
    await rejectsStatus(q.updateQuotation(admin, quote.id, { note: "too late" }), 409, /draft/i);
  });

  it("enforces the status transitions", async () => {
    const quote = await q.createQuotation(admin, { customerId, lines: draftLines() });
    await rejectsStatus(q.setQuotationStatus(admin, quote.id, "ACCEPTED"), 409, /cannot move/i);
    await q.setQuotationStatus(admin, quote.id, "SENT");
    const accepted = await q.setQuotationStatus(admin, quote.id, "ACCEPTED");
    assert.equal(accepted.status, "ACCEPTED");
  });

  it("converts to an order, links it and locks the quote", async () => {
    const quote = await q.createQuotation(admin, { customerId, lines: draftLines(), send: true });
    const result = await q.convertQuotation(admin, quote.id, {});
    assert.equal(result.kind, "order");

    const order = await db.salesOrder.findUniqueOrThrow({ where: { id: result.id } });
    assert.equal(order.quotationId, quote.id, "order points back to the quotation");

    const reloaded = await db.quotation.findUniqueOrThrow({ where: { id: quote.id } });
    assert.equal(reloaded.status, "CONVERTED");

    await rejectsStatus(q.convertQuotation(admin, quote.id, {}), 409, /already been converted/i);
  });

  it("converts straight to an issued invoice", async () => {
    const quote = await q.createQuotation(admin, { customerId, lines: draftLines(), send: true });
    const result = await q.convertQuotation(admin, quote.id, { toInvoice: true });
    assert.equal(result.kind, "invoice");
    const invoice = await db.invoice.findUniqueOrThrow({ where: { id: result.id } });
    assert.equal(invoice.status, "ISSUED");
  });
});
