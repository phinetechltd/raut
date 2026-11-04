import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

/**
 * Delivery notes against a throwaway copy of the dev database.
 *
 * DATABASE_URL is pointed at the copy before any module is imported, because
 * `@/lib/db` builds its PrismaClient at import time. prisma/xos.db is never
 * touched.
 */
const dir = mkdtempSync(path.join(tmpdir(), "xos-delivery-"));
const file = path.join(dir, "xos.db");
copyFileSync(path.resolve(__dirname, "../../prisma/xos.db"), file);
process.env.DATABASE_URL = `file:${file.split(path.sep).join("/")}`;

type Sales = typeof import("./sales");
type Delivery = typeof import("./delivery");
type Db = typeof import("@/lib/db")["db"];

let sales: Sales;
let delivery: Delivery;
let db: Db;

let companyId: string;
let otherCompanyId: string;
let productId: string;
let userId: string | null;
let seq = 0;

async function newCustomer(company = companyId) {
  seq++;
  return db.customer.create({
    data: {
      companyId: company,
      code: `DNT-${Date.now()}-${seq}`,
      name: `Delivery test customer ${seq}`,
      address: "Plot 12, Industrial Area",
      town: "Nakuru",
      paymentTermsDays: 14,
    },
  });
}

/** An issued invoice for `quantity` units, no stock location so nothing moves. */
async function invoiceFor(customerId: string, quantity = 10, issue = true) {
  return sales.createInvoice({
    companyId,
    customerId,
    lines: [{ productId, quantity, unitPriceCents: 5_000 }],
    issue,
    createdById: userId,
  });
}

const rejectsWith = (p: Promise<unknown>, status: number, pattern?: RegExp) =>
  assert.rejects(p, (error: unknown) => {
    const e = error as { status?: number; message: string };
    assert.equal(e.status, status, `expected ${status}, got ${e.status}: ${e.message}`);
    if (pattern) assert.match(e.message, pattern);
    return true;
  });

describe("delivery notes", () => {
  before(async () => {
    ({ db } = await import("@/lib/db"));
    sales = await import("./sales");
    delivery = await import("./delivery");

    const tari = await db.company.findUniqueOrThrow({ where: { slug: "tari" } });
    companyId = tari.id;
    const other = await db.company.create({
      data: { name: "Other Delivery Tenant", slug: `other-dn-${Date.now()}`, status: "ACTIVE" },
    });
    otherCompanyId = other.id;

    const product = await db.product.findFirstOrThrow({ where: { companyId, active: true, taxRateBp: 1600 } });
    productId = product.id;
    const user = await db.user.findFirst({ where: { companyId }, select: { id: true } });
    userId = user?.id ?? null;
  });

  after(async () => {
    await db.$disconnect();
  });

  it("needs an invoice or an order", async () => {
    await rejectsWith(delivery.createDeliveryNote({ companyId }), 400, /invoice or the order/i);
  });

  it("creates from an issued invoice with every line at its full undelivered quantity", async () => {
    const c = await newCustomer();
    const inv = await invoiceFor(c.id, 10);

    const note = await delivery.createDeliveryNote({ companyId, invoiceId: inv.id, createdById: userId });
    assert.match(note.number, /^DN-\d{4}$/);
    assert.equal(note.status, "ISSUED");
    assert.equal(note.customerId, c.id);
    assert.equal(note.invoiceId, inv.id);
    assert.equal(note.deliveryAddress, "Plot 12, Industrial Area, Nakuru", "the address is snapshotted");
    assert.equal(note.lines.length, 1);
    assert.equal(note.lines[0].orderedQty, 10);
    assert.equal(note.lines[0].deliveredQty, 10);
    assert.equal(note.lines[0].baseQuantity, 10);
    assert.equal(note.lines[0].invoiceLineId, inv.lines[0].id);
    assert.equal(note.lines[0].returnedQty, 0);

    // A delivery note never moves stock: the invoice did.
    const movements = await db.stockMovement.count({ where: { refType: "DELIVERY_NOTE", refId: note.id } });
    assert.equal(movements, 0);

    const trail = await db.auditLog.findFirst({ where: { entity: "DeliveryNote", entityId: note.id, action: "CREATE" } });
    assert.ok(trail, "creation is audited");
  });

  it("refuses to deliver more than was sold", async () => {
    const c = await newCustomer();
    const inv = await invoiceFor(c.id, 10);
    await rejectsWith(
      delivery.createDeliveryNote({
        companyId,
        invoiceId: inv.id,
        lines: [{ invoiceLineId: inv.lines[0].id, deliveredQty: 11 }],
      }),
      409,
      /only 10 remain/i,
    );
    assert.equal(await db.deliveryNote.count({ where: { invoiceId: inv.id } }), 0, "nothing was written");
  });

  it("delivers in parts: a second note defaults to the remainder, a third finds nothing left", async () => {
    const c = await newCustomer();
    const inv = await invoiceFor(c.id, 10);
    const lineId = inv.lines[0].id;

    const first = await delivery.createDeliveryNote({
      companyId,
      invoiceId: inv.id,
      lines: [{ invoiceLineId: lineId, deliveredQty: 4 }],
    });
    assert.equal(first.lines[0].deliveredQty, 4);

    // Over the remainder across notes, not just this one.
    await rejectsWith(
      delivery.createDeliveryNote({ companyId, invoiceId: inv.id, lines: [{ invoiceLineId: lineId, deliveredQty: 7 }] }),
      409,
      /only 6 remain/i,
    );

    const second = await delivery.createDeliveryNote({ companyId, invoiceId: inv.id });
    assert.equal(second.lines[0].deliveredQty, 6, "defaults to what is left");
    assert.notEqual(second.number, first.number);

    await rejectsWith(delivery.createDeliveryNote({ companyId, invoiceId: inv.id }), 409, /nothing left/i);
  });

  it("DELIVERED requires the receiver's name and stamps the time", async () => {
    const c = await newCustomer();
    const inv = await invoiceFor(c.id, 3);
    const note = await delivery.createDeliveryNote({ companyId, invoiceId: inv.id });

    await rejectsWith(delivery.markDelivered(companyId, note.id, { receivedByName: "   " }), 400, /who received/i);
    const still = await db.deliveryNote.findUniqueOrThrow({ where: { id: note.id } });
    assert.equal(still.status, "ISSUED");

    const delivered = await delivery.markDelivered(
      companyId,
      note.id,
      { receivedByName: "Mama Njeri", receivedByPhone: "0712 000 000", receivedBySignature: "M. Njeri" },
      userId,
    );
    assert.equal(delivered.status, "DELIVERED");
    assert.equal(delivered.receivedByName, "Mama Njeri");
    assert.equal(delivered.receivedByPhone, "0712 000 000");
    assert.ok(delivered.deliveredAt instanceof Date);

    // Delivered twice is a conflict, not a second delivery.
    await rejectsWith(delivery.markDelivered(companyId, note.id, { receivedByName: "Again" }), 409, /delivered/i);
  });

  it("RETURNED records returnedQty per line and frees the quantity for another trip", async () => {
    const c = await newCustomer();
    const inv = await invoiceFor(c.id, 10);
    const note = await delivery.createDeliveryNote({ companyId, invoiceId: inv.id });
    await delivery.markDelivered(companyId, note.id, { receivedByName: "Shopkeeper" });

    // Over what went out on this note.
    await rejectsWith(
      delivery.markReturned(companyId, note.id, { lines: [{ lineId: note.lines[0].id, returnedQty: 11 }] }),
      409,
      /only 10 were delivered/i,
    );

    const returned = await delivery.markReturned(companyId, note.id, {
      lines: [{ lineId: note.lines[0].id, returnedQty: 2 }],
      notes: "Two cartons dented",
    });
    assert.equal(returned.status, "RETURNED");
    assert.equal(returned.lines[0].returnedQty, 2);
    assert.equal(returned.lines[0].deliveredQty, 10, "what went out is not rewritten");

    const again = await delivery.createDeliveryNote({ companyId, invoiceId: inv.id });
    assert.equal(again.lines[0].deliveredQty, 2, "the returned two can go out again");

    // A return cannot be recorded on a note that was never delivered.
    await rejectsWith(
      delivery.markReturned(companyId, again.id, { lines: [{ lineId: again.lines[0].id, returnedQty: 1 }] }),
      409,
    );
  });

  it("cancels an issued note and refuses to cancel a delivered one", async () => {
    const c = await newCustomer();
    const inv = await invoiceFor(c.id, 5);
    const note = await delivery.createDeliveryNote({ companyId, invoiceId: inv.id });

    const cancelled = await delivery.cancelDeliveryNote(companyId, note.id, userId);
    assert.equal(cancelled.status, "CANCELLED");

    const fresh = await delivery.createDeliveryNote({ companyId, invoiceId: inv.id });
    assert.equal(fresh.lines[0].deliveredQty, 5, "a cancelled note never went out");

    await delivery.markDelivered(companyId, fresh.id, { receivedByName: "Signed" });
    await rejectsWith(delivery.cancelDeliveryNote(companyId, fresh.id), 409, /cannot be cancelled/i);
    await rejectsWith(delivery.issueDeliveryNote(companyId, fresh.id), 409);
  });

  it("holds a draft until issued", async () => {
    const c = await newCustomer();
    const inv = await invoiceFor(c.id, 2);
    const draft = await delivery.createDeliveryNote({ companyId, invoiceId: inv.id, issue: false });
    assert.equal(draft.status, "DRAFT");
    const issued = await delivery.issueDeliveryNote(companyId, draft.id);
    assert.equal(issued.status, "ISSUED");
  });

  it("refuses a draft invoice and a cancelled one", async () => {
    const c = await newCustomer();
    const draft = await invoiceFor(c.id, 1, false);
    await rejectsWith(delivery.createDeliveryNote({ companyId, invoiceId: draft.id }), 409, /issue the invoice/i);
  });

  it("from an order: DELIVERED marks the lines fulfilled and the order partially, then fully, fulfilled", async () => {
    const c = await newCustomer();
    const order = await sales.createSalesOrder({
      companyId,
      customerId: c.id,
      lines: [{ productId, quantity: 10, unitPriceCents: 5_000 }],
      createdById: userId,
    });
    assert.equal(order.status, "CONFIRMED");
    const orderLineId = order.lines[0].id;

    const part = await delivery.createDeliveryNote({
      companyId,
      orderId: order.id,
      lines: [{ orderLineId, deliveredQty: 4 }],
    });
    assert.equal(part.orderId, order.id);
    assert.equal(part.invoiceId, null);
    assert.equal(part.lines[0].orderLineId, orderLineId);

    // Issued is not delivered: the order does not move yet.
    let o = await db.salesOrder.findUniqueOrThrow({ where: { id: order.id }, include: { lines: true } });
    assert.equal(o.status, "CONFIRMED");
    assert.equal(o.lines[0].fulfilled, 0);

    await delivery.markDelivered(companyId, part.id, { receivedByName: "Receiving clerk" });
    o = await db.salesOrder.findUniqueOrThrow({ where: { id: order.id }, include: { lines: true } });
    assert.equal(o.status, "PARTIALLY_FULFILLED");
    assert.equal(o.lines[0].fulfilled, 4);

    const rest = await delivery.createDeliveryNote({ companyId, orderId: order.id });
    assert.equal(rest.lines[0].deliveredQty, 6);
    await delivery.markDelivered(companyId, rest.id, { receivedByName: "Receiving clerk" });
    o = await db.salesOrder.findUniqueOrThrow({ where: { id: order.id }, include: { lines: true } });
    assert.equal(o.status, "FULFILLED");
    assert.equal(o.lines[0].fulfilled, 10);

    // Nothing moved: an order delivery is a dispatch record until it is invoiced.
    assert.equal(await db.stockMovement.count({ where: { refType: "DELIVERY_NOTE" } }), 0);
  });

  it("refuses an order that has already been invoiced", async () => {
    const c = await newCustomer();
    const order = await sales.createSalesOrder({
      companyId,
      customerId: c.id,
      lines: [{ productId, quantity: 2, unitPriceCents: 5_000 }],
    });
    await sales.createInvoice({
      companyId,
      customerId: c.id,
      orderId: order.id,
      lines: [{ productId, quantity: 2, unitPriceCents: 5_000 }],
    });
    await rejectsWith(delivery.createDeliveryNote({ companyId, orderId: order.id }), 409, /from the invoice/i);
  });

  it("keeps tenants apart: another company's invoice, note and references are not found", async () => {
    const c = await newCustomer();
    const inv = await invoiceFor(c.id, 2);
    const note = await delivery.createDeliveryNote({ companyId, invoiceId: inv.id });

    await rejectsWith(delivery.createDeliveryNote({ companyId: otherCompanyId, invoiceId: inv.id }), 404);
    await rejectsWith(delivery.markDelivered(otherCompanyId, note.id, { receivedByName: "Intruder" }), 404);
    await rejectsWith(delivery.cancelDeliveryNote(otherCompanyId, note.id), 404);
    await rejectsWith(
      delivery.markReturned(otherCompanyId, note.id, { lines: [{ lineId: note.lines[0].id, returnedQty: 1 }] }),
      404,
    );

    // A vehicle from another tenant cannot be put on this company's note.
    const foreignVan = await db.vehicle.create({
      data: { companyId: otherCompanyId, plate: `KZZ ${Date.now() % 1000}X`, type: "VAN" },
    });
    const inv2 = await invoiceFor(c.id, 1);
    await rejectsWith(
      delivery.createDeliveryNote({ companyId, invoiceId: inv2.id, vehicleId: foreignVan.id }),
      404,
      /vehicle/i,
    );

    const untouched = await db.deliveryNote.findUniqueOrThrow({ where: { id: note.id } });
    assert.equal(untouched.status, "ISSUED");
  });
});
