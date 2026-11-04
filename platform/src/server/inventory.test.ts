import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

/**
 * Stock splitting, transfers in parts, receipts across locations and
 * multi-location counts, against a throwaway copy of the dev database.
 *
 * DATABASE_URL is pointed at the copy before any module is imported, because
 * `@/lib/db` builds its PrismaClient at import time. prisma/xos.db is never
 * touched.
 */
const dir = mkdtempSync(path.join(tmpdir(), "xos-inventory-"));
const file = path.join(dir, "xos.db");
copyFileSync(path.resolve(__dirname, "../../prisma/xos.db"), file);
process.env.DATABASE_URL = `file:${file.split(path.sep).join("/")}`;

type Inventory = typeof import("./inventory");
type Db = typeof import("@/lib/db")["db"];

let inv: Inventory;
let db: Db;

let companyId: string;
let otherCompanyId: string;
let otherLocationId: string;
let mainId: string;
let msaId: string;
let vanId: string;
let userId: string | null;
let seq = 0;

/** A fresh tracked product with a known cost and no stock anywhere. */
async function newProduct(opts: { costPriceCents: number; unitsPerPack?: number; company?: string }) {
  seq++;
  return db.product.create({
    data: {
      companyId: opts.company ?? companyId,
      sku: `TST-${Date.now()}-${seq}`,
      name: `Inventory test product ${seq}`,
      unitsPerPack: opts.unitsPerPack ?? 1,
      costPriceCents: opts.costPriceCents,
      sellPriceCents: opts.costPriceCents * 2,
      trackStock: true,
    },
  });
}

async function stockUp(productId: string, locationId: string, quantity: number) {
  await db.$transaction((tx) =>
    inv.applyMovement(tx, { companyId, productId, locationId, type: "OPENING", quantity, createdById: userId }),
  );
}

async function onHand(productId: string, locationId: string) {
  const s = await db.stockItem.findUnique({ where: { productId_locationId: { productId, locationId } } });
  return s?.quantity ?? 0;
}

/** Σ qty × unitCost over the movements that touch value, as the ledger sees them. */
async function inventoryLedgerBalance() {
  const acc = await db.account.findFirstOrThrow({ where: { companyId, systemKey: "INVENTORY" } });
  const lines = await db.journalLine.findMany({ where: { accountId: acc.id }, select: { debitCents: true, creditCents: true } });
  return lines.reduce((n, l) => n + l.debitCents - l.creditCents, 0);
}

const rejectsStatus = (p: Promise<unknown>, status: number, pattern?: RegExp) =>
  assert.rejects(p, (error: unknown) => {
    const e = error as { status?: number; message: string };
    assert.equal(e.status, status, `expected ${status}, got ${e.status}: ${e.message}`);
    if (pattern) assert.match(e.message, pattern);
    return true;
  });

describe("inventory: split, transfer, receive, count", () => {
  before(async () => {
    ({ db } = await import("@/lib/db"));
    inv = await import("./inventory");

    const tari = await db.company.findUniqueOrThrow({ where: { slug: "tari" } });
    companyId = tari.id;
    const locations = await db.stockLocation.findMany({ where: { companyId }, orderBy: { name: "asc" } });
    mainId = locations.find((l) => l.code === "MAIN")!.id;
    msaId = locations.find((l) => l.code === "MSA-ST")!.id;
    vanId = locations.find((l) => l.type === "VAN")!.id;
    const user = await db.user.findFirst({ where: { companyId }, select: { id: true } });
    userId = user?.id ?? null;

    const other = await db.company.create({
      data: { name: "Other Tenant", slug: `other-inv-${Date.now()}`, status: "ACTIVE" },
    });
    otherCompanyId = other.id;
    const otherLoc = await db.stockLocation.create({
      data: { companyId: otherCompanyId, name: "Elsewhere", code: "ELSE", type: "WAREHOUSE" },
    });
    otherLocationId = otherLoc.id;
  });

  after(async () => {
    await db.$disconnect();
  });

  // ── repack ─────────────────────────────────────────────────────────────

  describe("repackStock", () => {
    it("carries the value across and preserves quantities, defaulting to the pack size", async () => {
      const carton = await newProduct({ costPriceCents: 124_000, unitsPerPack: 12 });
      const piece = await newProduct({ costPriceCents: 10_000 });
      await stockUp(carton.id, mainId, 5);
      await stockUp(piece.id, mainId, 6);
      const ledgerBefore = await inventoryLedgerBalance();

      const r = await db.$transaction((tx) =>
        inv.repackStock(tx, { companyId, locationId: mainId, fromProductId: carton.id, fromQuantity: 2, toProductId: piece.id, userId }),
      );

      assert.equal(r.in.quantity, 24, "defaults to fromQuantity × unitsPerPack");
      assert.equal(r.out.quantity, -2);
      assert.equal(r.valueCents, 248_000);
      assert.equal(r.in.unitCostCents, Math.floor(248_000 / 24));
      // 248000 / 24 = 10333.33 → 10333 × 24 = 247992, 8 cents over
      assert.equal(r.remainderCents, 8);
      assert.equal(-r.out.quantity * r.out.unitCostCents, r.in.quantity * r.in.unitCostCents + r.remainderCents);
      assert.equal(r.out.refType, "REPACK");
      assert.equal(r.out.refId, r.refId);
      assert.equal(r.in.refId, r.refId);

      assert.equal(await onHand(carton.id, mainId), 3);
      assert.equal(await onHand(piece.id, mainId), 30);

      // Weighted average: (6 × 10000 + 248000) / 30 = 10266.67 → 10267
      const repriced = await db.product.findUniqueOrThrow({ where: { id: piece.id } });
      assert.equal(repriced.costPriceCents, 10_267);
      assert.equal(r.targetCostPriceCents, 10_267);
      const source = await db.product.findUniqueOrThrow({ where: { id: carton.id } });
      assert.equal(source.costPriceCents, 124_000, "the source keeps its cost");

      // The ledger lost exactly the rounding, booked under its own sourceKind.
      const entry = await db.journalEntry.findFirst({
        where: { companyId, refType: "StockMovement", refId: r.in.id, sourceKind: "REPACK_ROUNDING" },
        include: { lines: true },
      });
      assert.ok(entry, "rounding entry exists");
      assert.equal(entry!.lines.reduce((n, l) => n + l.creditCents, 0), 8);
      assert.equal(await inventoryLedgerBalance(), ledgerBefore - 8);
    });

    it("posts no rounding entry when the value divides evenly", async () => {
      const carton = await newProduct({ costPriceCents: 120_000, unitsPerPack: 12 });
      const piece = await newProduct({ costPriceCents: 0 });
      await stockUp(carton.id, msaId, 1);
      const ledgerBefore = await inventoryLedgerBalance();
      const r = await db.$transaction((tx) =>
        inv.repackStock(tx, { companyId, locationId: msaId, fromProductId: carton.id, fromQuantity: 1, toProductId: piece.id, userId }),
      );
      assert.equal(r.remainderCents, 0);
      assert.equal(r.in.unitCostCents, 10_000);
      const entry = await db.journalEntry.findFirst({ where: { refId: r.in.id, sourceKind: "REPACK_ROUNDING" } });
      assert.equal(entry, null);
      assert.equal(await inventoryLedgerBalance(), ledgerBefore);
      const repriced = await db.product.findUniqueOrThrow({ where: { id: piece.id } });
      assert.equal(repriced.costPriceCents, 10_000, "empty pool takes the incoming cost");
    });

    it("accepts an explicit target quantity and leaves everything untouched when refused", async () => {
      const a = await newProduct({ costPriceCents: 500, unitsPerPack: 1 });
      const b = await newProduct({ costPriceCents: 100 });
      await stockUp(a.id, mainId, 4);

      // No pack size and no toQuantity: nothing to go on.
      await rejectsStatus(
        db.$transaction((tx) => inv.repackStock(tx, { companyId, locationId: mainId, fromProductId: a.id, fromQuantity: 1, toProductId: b.id })),
        422,
        /how many/i,
      );
      const r = await db.$transaction((tx) =>
        inv.repackStock(tx, { companyId, locationId: mainId, fromProductId: a.id, fromQuantity: 1, toProductId: b.id, toQuantity: 3 }),
      );
      assert.equal(r.in.quantity, 3);
      assert.equal(r.in.unitCostCents, 166);
      assert.equal(r.remainderCents, 2);
    });

    it("refuses more than is on hand at that location, the same product, and untracked products", async () => {
      const a = await newProduct({ costPriceCents: 500, unitsPerPack: 6 });
      const b = await newProduct({ costPriceCents: 100 });
      await stockUp(a.id, mainId, 2);
      await stockUp(a.id, msaId, 50);

      await rejectsStatus(
        db.$transaction((tx) => inv.repackStock(tx, { companyId, locationId: mainId, fromProductId: a.id, fromQuantity: 3, toProductId: b.id })),
        422,
        /only 2/i,
      );
      assert.equal(await onHand(a.id, mainId), 2, "nothing moved");
      assert.equal(await onHand(b.id, mainId), 0);

      await rejectsStatus(
        db.$transaction((tx) => inv.repackStock(tx, { companyId, locationId: mainId, fromProductId: a.id, fromQuantity: 1, toProductId: a.id })),
        422,
        /different products/i,
      );

      const service = await db.product.create({
        data: { companyId, sku: `SVC-${Date.now()}`, name: "Service", trackStock: false, costPriceCents: 0 },
      });
      await rejectsStatus(
        db.$transaction((tx) => inv.repackStock(tx, { companyId, locationId: mainId, fromProductId: a.id, fromQuantity: 1, toProductId: service.id })),
        422,
        /does not track stock/i,
      );
      await rejectsStatus(
        db.$transaction((tx) => inv.repackStock(tx, { companyId, locationId: mainId, fromProductId: a.id, fromQuantity: 0, toProductId: b.id })),
        422,
      );
    });

    it("refuses products and locations from another tenant as not found", async () => {
      const a = await newProduct({ costPriceCents: 500, unitsPerPack: 6 });
      const foreign = await newProduct({ costPriceCents: 100, company: otherCompanyId });
      await stockUp(a.id, mainId, 2);

      await rejectsStatus(
        db.$transaction((tx) => inv.repackStock(tx, { companyId, locationId: mainId, fromProductId: a.id, fromQuantity: 1, toProductId: foreign.id })),
        404,
      );
      await rejectsStatus(
        db.$transaction((tx) => inv.repackStock(tx, { companyId, locationId: otherLocationId, fromProductId: a.id, fromQuantity: 1, toProductId: a.id + "x" })),
        404,
      );
      // And the other tenant cannot reach ours.
      await rejectsStatus(
        db.$transaction((tx) => inv.repackStock(tx, { companyId: otherCompanyId, locationId: otherLocationId, fromProductId: a.id, fromQuantity: 1, toProductId: foreign.id })),
        404,
      );
      assert.equal(await onHand(a.id, mainId), 2);
    });
  });

  // ── transfers ──────────────────────────────────────────────────────────

  describe("transfers", () => {
    it("derives status from the counters", () => {
      const d = inv.deriveTransferStatus;
      assert.equal(d([{ quantity: 10, dispatched: 0, received: 0 }]), "DRAFT");
      assert.equal(d([{ quantity: 10, dispatched: 4, received: 0 }]), "PARTIALLY_DISPATCHED");
      assert.equal(d([{ quantity: 10, dispatched: 10, received: 0 }]), "IN_TRANSIT");
      assert.equal(d([{ quantity: 10, dispatched: 4, received: 4 }]), "PARTIALLY_RECEIVED");
      assert.equal(d([{ quantity: 10, dispatched: 10, received: 6 }]), "PARTIALLY_RECEIVED");
      assert.equal(d([{ quantity: 10, dispatched: 10, received: 10 }]), "RECEIVED");
      assert.equal(d([{ quantity: 10, dispatched: 10, received: 6 }], { shortClosed: true }), "RECEIVED");
      // Two lines: one complete, one untouched.
      assert.equal(d([{ quantity: 5, dispatched: 5, received: 5 }, { quantity: 5, dispatched: 0, received: 0 }]), "PARTIALLY_RECEIVED");
    });

    it("dispatches and receives in parts, moving stock and timestamps as it goes", async () => {
      const a = await newProduct({ costPriceCents: 1_000 });
      const b = await newProduct({ costPriceCents: 2_000 });
      await stockUp(a.id, mainId, 20);
      await stockUp(b.id, mainId, 10);

      const t = await db.$transaction((tx) =>
        inv.createTransfer(tx, {
          companyId,
          fromLocationId: mainId,
          toLocationId: msaId,
          lines: [{ productId: a.id, quantity: 10 }, { productId: b.id, quantity: 4 }],
          createdById: userId,
        }),
      );
      assert.equal(t.status, "DRAFT");
      assert.match(t.number, /^TRF-\d{4}$/);
      const [la, lb] = t.lines;

      const s1 = await inv.dispatchTransfer(t.id, userId, { companyId, lines: [{ lineId: la!.id, quantity: 4 }] });
      assert.equal(s1.status, "PARTIALLY_DISPATCHED");
      assert.ok(s1.dispatchedAt);
      assert.equal(s1.receivedAt, null);
      assert.equal(await onHand(a.id, mainId), 16);
      assert.equal(await onHand(a.id, msaId), 0);

      const s2 = await inv.receiveTransfer(t.id, userId, { companyId, lines: [{ lineId: la!.id, quantity: 3 }] });
      assert.equal(s2.status, "PARTIALLY_RECEIVED");
      assert.equal(await onHand(a.id, msaId), 3);

      // Everything outstanding on every line.
      const s3 = await inv.dispatchTransfer(t.id, userId, { companyId });
      assert.equal(s3.status, "PARTIALLY_RECEIVED");
      assert.deepEqual(s3.lines.map((l) => l.dispatched), [10, 4]);
      assert.equal(await onHand(a.id, mainId), 10);
      assert.equal(await onHand(b.id, mainId), 6);

      const s4 = await inv.receiveTransfer(t.id, userId, { companyId });
      assert.equal(s4.status, "RECEIVED");
      assert.ok(s4.receivedAt);
      assert.deepEqual(s4.lines.map((l) => l.received), [10, 4]);
      assert.equal(await onHand(a.id, msaId), 10);
      assert.equal(await onHand(b.id, msaId), 4);

      // Movement symmetry: Σ OUT at source = −dispatched, Σ IN at dest = received.
      const moves = await db.stockMovement.findMany({ where: { refType: "TRANSFER", refId: t.id } });
      const sum = (type: string, loc: string, prod: string) =>
        moves.filter((m) => m.type === type && m.locationId === loc && m.productId === prod).reduce((n, m) => n + m.quantity, 0);
      assert.equal(sum("TRANSFER_OUT", mainId, a.id), -10);
      assert.equal(sum("TRANSFER_IN", msaId, a.id), 10);
      assert.equal(sum("TRANSFER_OUT", mainId, b.id), -4);
      assert.equal(sum("TRANSFER_IN", msaId, b.id), 4);
      assert.ok(moves.every((m) => m.unitCostCents === 0), "transfers carry no value");

      await rejectsStatus(inv.dispatchTransfer(t.id, userId, { companyId }), 409);
      await rejectsStatus(inv.receiveTransfer(t.id, userId, { companyId }), 409);
    });

    it("refuses over-dispatch, over-receipt, foreign lines and bad quantities without moving anything", async () => {
      const a = await newProduct({ costPriceCents: 1_000 });
      await stockUp(a.id, mainId, 5);
      const t = await db.$transaction((tx) =>
        inv.createTransfer(tx, { companyId, fromLocationId: mainId, toLocationId: vanId, lines: [{ productId: a.id, quantity: 5 }] }),
      );
      const line = t.lines[0]!;

      await rejectsStatus(inv.dispatchTransfer(t.id, userId, { companyId, lines: [{ lineId: line.id, quantity: 6 }] }), 422, /only 5 remain/i);
      await rejectsStatus(inv.dispatchTransfer(t.id, userId, { companyId, lines: [{ lineId: line.id, quantity: 0 }] }), 422);
      await rejectsStatus(inv.dispatchTransfer(t.id, userId, { companyId, lines: [{ lineId: "nope", quantity: 1 }] }), 422);
      await rejectsStatus(
        inv.dispatchTransfer(t.id, userId, { companyId, lines: [{ lineId: line.id, quantity: 1 }, { lineId: line.id, quantity: 1 }] }),
        422,
        /more than once/i,
      );
      // Nothing is in transit yet, so nothing can be received.
      await rejectsStatus(inv.receiveTransfer(t.id, userId, { companyId, lines: [{ lineId: line.id, quantity: 1 }] }), 422);
      assert.equal(await onHand(a.id, mainId), 5);
      const fresh = await db.stockTransfer.findUniqueOrThrow({ where: { id: t.id }, include: { lines: true } });
      assert.equal(fresh.status, "DRAFT");
      assert.equal(fresh.lines[0]!.dispatched, 0);

      await inv.dispatchTransfer(t.id, userId, { companyId, lines: [{ lineId: line.id, quantity: 2 }] });
      await rejectsStatus(inv.receiveTransfer(t.id, userId, { companyId, lines: [{ lineId: line.id, quantity: 3 }] }), 422, /only 2 remain/i);
    });

    it("is scoped by company and refuses same-location or duplicate-product drafts", async () => {
      const a = await newProduct({ costPriceCents: 1_000 });
      await stockUp(a.id, mainId, 5);
      const t = await db.$transaction((tx) =>
        inv.createTransfer(tx, { companyId, fromLocationId: mainId, toLocationId: msaId, lines: [{ productId: a.id, quantity: 5 }] }),
      );
      await rejectsStatus(inv.dispatchTransfer(t.id, userId, { companyId: otherCompanyId }), 404);
      await rejectsStatus(inv.cancelTransfer(t.id, otherCompanyId), 404);
      await rejectsStatus(inv.closeTransferShort(t.id, userId, { companyId: otherCompanyId }), 404);

      await rejectsStatus(
        db.$transaction((tx) => inv.createTransfer(tx, { companyId, fromLocationId: mainId, toLocationId: mainId, lines: [{ productId: a.id, quantity: 1 }] })),
        422,
      );
      await rejectsStatus(
        db.$transaction((tx) =>
          inv.createTransfer(tx, { companyId, fromLocationId: mainId, toLocationId: msaId, lines: [{ productId: a.id, quantity: 1 }, { productId: a.id, quantity: 2 }] }),
        ),
        422,
        /once/i,
      );
      await rejectsStatus(
        db.$transaction((tx) => inv.createTransfer(tx, { companyId, fromLocationId: mainId, toLocationId: otherLocationId, lines: [{ productId: a.id, quantity: 1 }] })),
        404,
      );
    });

    it("claims a concurrent dispatch only once", async () => {
      const a = await newProduct({ costPriceCents: 1_000 });
      await stockUp(a.id, mainId, 5);
      const t = await db.$transaction((tx) =>
        inv.createTransfer(tx, { companyId, fromLocationId: mainId, toLocationId: msaId, lines: [{ productId: a.id, quantity: 5 }] }),
      );
      const line = t.lines[0]!;
      const results = await Promise.allSettled([
        inv.dispatchTransfer(t.id, userId, { companyId, lines: [{ lineId: line.id, quantity: 5 }] }),
        inv.dispatchTransfer(t.id, userId, { companyId, lines: [{ lineId: line.id, quantity: 5 }] }),
      ]);
      const won = results.filter((r) => r.status === "fulfilled").length;
      assert.equal(won, 1, `exactly one dispatch should win, got ${won}`);
      const fresh = await db.stockTransferLine.findUniqueOrThrow({ where: { id: line.id } });
      assert.equal(fresh.dispatched, 5, "never over-claimed");
      assert.equal(await onHand(a.id, mainId), 0);
      const outs = await db.stockMovement.count({ where: { refId: t.id, type: "TRANSFER_OUT" } });
      assert.equal(outs, 1);
    });

    it("cancels only drafts", async () => {
      const a = await newProduct({ costPriceCents: 1_000 });
      await stockUp(a.id, mainId, 5);
      const t = await db.$transaction((tx) =>
        inv.createTransfer(tx, { companyId, fromLocationId: mainId, toLocationId: msaId, lines: [{ productId: a.id, quantity: 5 }] }),
      );
      const c = await inv.cancelTransfer(t.id, companyId);
      assert.equal(c.status, "CANCELLED");
      await rejectsStatus(inv.dispatchTransfer(t.id, userId, { companyId }), 409, /cancelled/i);
      await rejectsStatus(inv.cancelTransfer(t.id, companyId), 409);

      const t2 = await db.$transaction((tx) =>
        inv.createTransfer(tx, { companyId, fromLocationId: mainId, toLocationId: msaId, lines: [{ productId: a.id, quantity: 2 }] }),
      );
      await inv.dispatchTransfer(t2.id, userId, { companyId });
      await rejectsStatus(inv.cancelTransfer(t2.id, companyId), 409, /only draft/i);
    });

    it("closes short: the shortfall returns to the source on paper and is written off there", async () => {
      const a = await newProduct({ costPriceCents: 1_500 });
      await stockUp(a.id, mainId, 10);
      const t = await db.$transaction((tx) =>
        inv.createTransfer(tx, { companyId, fromLocationId: mainId, toLocationId: msaId, lines: [{ productId: a.id, quantity: 8 }] }),
      );
      const line = t.lines[0]!;
      await rejectsStatus(inv.closeTransferShort(t.id, userId, { companyId }), 409, /nothing in transit/i);

      await inv.dispatchTransfer(t.id, userId, { companyId, lines: [{ lineId: line.id, quantity: 6 }] });
      await inv.receiveTransfer(t.id, userId, { companyId, lines: [{ lineId: line.id, quantity: 4 }] });
      const ledgerBefore = await inventoryLedgerBalance();

      const closed = await inv.closeTransferShort(t.id, userId, { companyId, note: "Two fell off the truck" });
      assert.equal(closed.status, "RECEIVED");
      assert.ok(closed.shortClosedAt);
      assert.ok(closed.receivedAt);
      assert.equal(closed.lines[0]!.dispatched, 6);
      assert.equal(closed.lines[0]!.received, 4);

      // Source: 10 − 6 out + 2 back − 2 written off = 4. Destination: 4.
      assert.equal(await onHand(a.id, mainId), 4);
      assert.equal(await onHand(a.id, msaId), 4);
      const moves = await db.stockMovement.findMany({ where: { refType: "TRANSFER", refId: t.id } });
      const back = moves.filter((m) => m.type === "TRANSFER_IN" && m.locationId === mainId);
      const wo = moves.filter((m) => m.type === "WRITE_OFF");
      assert.equal(back.reduce((n, m) => n + m.quantity, 0), 2);
      assert.equal(wo.length, 1);
      assert.equal(wo[0]!.quantity, -2);
      assert.equal(wo[0]!.locationId, mainId);
      assert.equal(wo[0]!.unitCostCents, 1_500, "written off at the product's cost");
      assert.equal(await inventoryLedgerBalance(), ledgerBefore - 3_000, "the loss is posted");

      await rejectsStatus(inv.closeTransferShort(t.id, userId, { companyId }), 409, /already/i);
      await rejectsStatus(inv.dispatchTransfer(t.id, userId, { companyId }), 409, /closed short/i);
      await rejectsStatus(inv.receiveTransfer(t.id, userId, { companyId }), 409);
    });
  });

  // ── goods receipts ─────────────────────────────────────────────────────

  describe("goods receipts", () => {
    async function poFor(lines: Array<{ productId: string; quantity: number; unitCostCents: number }>) {
      const supplier = await db.supplier.findFirstOrThrow({ where: { companyId } });
      seq++;
      return db.purchaseOrder.create({
        data: {
          companyId,
          supplierId: supplier.id,
          number: `TPO-${Date.now()}-${seq}`,
          status: "SENT",
          lines: {
            create: lines.map((l) => ({
              productId: l.productId,
              description: "test",
              quantity: l.quantity,
              unitCostCents: l.unitCostCents,
              lineTotalCents: l.quantity * l.unitCostCents,
            })),
          },
        },
        include: { lines: { orderBy: { id: "asc" } } },
      });
    }

    it("splits a receipt across locations and fills duplicate PO lines in order", async () => {
      const p = await newProduct({ costPriceCents: 900 });
      const po = await poFor([
        { productId: p.id, quantity: 10, unitCostCents: 1_000 },
        { productId: p.id, quantity: 5, unitCostCents: 1_000 },
      ]);
      const ledgerBefore = await inventoryLedgerBalance();

      const grn = await db.$transaction((tx) =>
        inv.createGoodsReceipt(tx, {
          companyId,
          poId: po.id,
          locationId: mainId,
          lines: [
            { productId: p.id, quantity: 8 },
            { productId: p.id, quantity: 4, locationId: msaId },
          ],
          createdById: userId,
        }),
      );
      assert.equal(grn.status, "DRAFT");
      assert.match(grn.number, /^GRN-\d{4}$/);
      assert.equal(grn.supplierId, po.supplierId, "supplier comes from the PO");
      assert.equal(grn.lines[0]!.unitCostCents, 1_000, "cost defaults to the PO line's");
      assert.equal(grn.lines[0]!.locationId, null, "header location is stored as null");
      assert.equal(grn.lines[1]!.locationId, msaId);
      assert.equal(await onHand(p.id, mainId), 0, "a draft moves nothing");

      const posted = await inv.postGoodsReceipt(grn.id, userId, { companyId });
      assert.equal(posted.status, "POSTED");
      assert.equal(await onHand(p.id, mainId), 8);
      assert.equal(await onHand(p.id, msaId), 4);

      const lines = await db.purchaseOrderLine.findMany({ where: { poId: po.id }, orderBy: { id: "asc" } });
      assert.deepEqual(lines.map((l) => l.received), [10, 2], "first line filled before the second");
      const poAfter = await db.purchaseOrder.findUniqueOrThrow({ where: { id: po.id } });
      assert.equal(poAfter.status, "PARTIALLY_RECEIVED");

      const product = await db.product.findUniqueOrThrow({ where: { id: p.id } });
      assert.equal(product.costPriceCents, 1_000, "landed cost becomes the cost basis");
      assert.equal(await inventoryLedgerBalance(), ledgerBefore + 12_000);

      const moves = await db.stockMovement.findMany({ where: { refType: "GRN", refId: grn.id } });
      assert.equal(moves.filter((m) => m.locationId === mainId).reduce((n, m) => n + m.quantity, 0), 8);
      assert.equal(moves.filter((m) => m.locationId === msaId).reduce((n, m) => n + m.quantity, 0), 4);

      await rejectsStatus(inv.postGoodsReceipt(grn.id, userId, { companyId }), 409, /already posted/i);
    });

    it("matches an explicit PO line and refuses over-receipt unless allowed", async () => {
      const p = await newProduct({ costPriceCents: 900 });
      const q = await newProduct({ costPriceCents: 300 });
      const po = await poFor([
        { productId: p.id, quantity: 3, unitCostCents: 1_000 },
        { productId: q.id, quantity: 2, unitCostCents: 400 },
      ]);
      const [lp, lq] = po.lines;

      await rejectsStatus(
        db.$transaction((tx) => inv.createGoodsReceipt(tx, { companyId, poId: po.id, locationId: mainId, lines: [{ productId: p.id, quantity: 4 }] })),
        422,
        /only 3 remain/i,
      );
      await rejectsStatus(
        db.$transaction((tx) => inv.createGoodsReceipt(tx, { companyId, poId: po.id, locationId: mainId, lines: [{ productId: p.id, quantity: 1, poLineId: lq!.id }] })),
        422,
        /differs/i,
      );
      const stray = await newProduct({ costPriceCents: 1 });
      await rejectsStatus(
        db.$transaction((tx) => inv.createGoodsReceipt(tx, { companyId, poId: po.id, locationId: mainId, lines: [{ productId: stray.id, quantity: 1 }] })),
        422,
        /not on the purchase order/i,
      );
      assert.equal(await db.goodsReceipt.count({ where: { poId: po.id } }), 0, "no draft left behind");

      const grn = await db.$transaction((tx) =>
        inv.createGoodsReceipt(tx, {
          companyId,
          poId: po.id,
          locationId: mainId,
          allowOver: true,
          lines: [
            { productId: p.id, quantity: 4, poLineId: lp!.id },
            { productId: q.id, quantity: 2, unitCostCents: 350 },
          ],
        }),
      );
      // Over-receipt was allowed at creation but must be allowed again at post.
      await rejectsStatus(inv.postGoodsReceipt(grn.id, userId, { companyId }), 422, /only 3 remain/i);
      const still = await db.goodsReceipt.findUniqueOrThrow({ where: { id: grn.id } });
      assert.equal(still.status, "DRAFT", "the claim rolled back with the refusal");

      const posted = await inv.postGoodsReceipt(grn.id, userId, { companyId, allowOver: true });
      assert.equal(posted.status, "POSTED");
      const lines = await db.purchaseOrderLine.findMany({ where: { poId: po.id }, orderBy: { id: "asc" } });
      assert.deepEqual(lines.map((l) => l.received), [4, 2]);
      const poAfter = await db.purchaseOrder.findUniqueOrThrow({ where: { id: po.id } });
      assert.equal(poAfter.status, "RECEIVED");
      const qProduct = await db.product.findUniqueOrThrow({ where: { id: q.id } });
      assert.equal(qProduct.costPriceCents, 350, "an explicit line cost wins");
    });

    it("stands free of a purchase order and is scoped by tenant", async () => {
      const p = await newProduct({ costPriceCents: 700 });
      const supplier = await db.supplier.findFirstOrThrow({ where: { companyId } });
      await rejectsStatus(
        db.$transaction((tx) => inv.createGoodsReceipt(tx, { companyId, locationId: mainId, lines: [{ productId: p.id, quantity: 1 }] })),
        422,
        /supplier/i,
      );
      const grn = await db.$transaction((tx) =>
        inv.createGoodsReceipt(tx, { companyId, supplierId: supplier.id, locationId: vanId, lines: [{ productId: p.id, quantity: 3 }] }),
      );
      assert.equal(grn.lines[0]!.unitCostCents, 700, "falls back to the product's cost");
      await rejectsStatus(inv.postGoodsReceipt(grn.id, userId, { companyId: otherCompanyId }), 404);
      await rejectsStatus(
        db.$transaction((tx) => inv.createGoodsReceipt(tx, { companyId, supplierId: supplier.id, locationId: otherLocationId, lines: [{ productId: p.id, quantity: 3 }] })),
        404,
      );
      await inv.postGoodsReceipt(grn.id, userId, { companyId });
      assert.equal(await onHand(p.id, vanId), 3);
    });
  });

  // ── multi-location adjustment ──────────────────────────────────────────

  describe("adjustAcrossLocations", () => {
    it("writes a valued adjustment per location when the lines do not net to zero", async () => {
      const p = await newProduct({ costPriceCents: 250 });
      await stockUp(p.id, mainId, 10);
      const ledgerBefore = await inventoryLedgerBalance();
      const r = await db.$transaction((tx) =>
        inv.adjustAcrossLocations(tx, {
          companyId,
          productId: p.id,
          lines: [{ locationId: mainId, quantity: -3 }, { locationId: msaId, quantity: 5 }],
          note: "count",
          userId,
        }),
      );
      assert.equal(r.kind, "ADJUSTMENT");
      assert.equal(r.movements.length, 2);
      assert.ok(r.movements.every((m) => m.type === "ADJUSTMENT" && m.unitCostCents === 250));
      assert.equal(await onHand(p.id, mainId), 7);
      assert.equal(await onHand(p.id, msaId), 5);
      assert.equal(await inventoryLedgerBalance(), ledgerBefore + 2 * 250);
    });

    it("records a zero-net count as a completed transfer that posts nothing", async () => {
      const p = await newProduct({ costPriceCents: 250 });
      await stockUp(p.id, mainId, 10);
      const ledgerBefore = await inventoryLedgerBalance();
      const r = await db.$transaction((tx) =>
        inv.adjustAcrossLocations(tx, {
          companyId,
          productId: p.id,
          lines: [{ locationId: mainId, quantity: -4 }, { locationId: msaId, quantity: 3 }, { locationId: vanId, quantity: 1 }],
          userId,
        }),
      );
      assert.equal(r.kind, "RELOCATION");
      assert.equal(r.transfers.length, 2, "one source, two destinations → two transfers");
      assert.ok(r.transfers.every((t) => t.status === "RECEIVED"));
      assert.deepEqual(
        r.transfers.map((t) => [t.toLocationId, t.lines[0]!.quantity]),
        [[msaId, 3], [vanId, 1]],
      );
      assert.equal(await onHand(p.id, mainId), 6);
      assert.equal(await onHand(p.id, msaId), 3);
      assert.equal(await onHand(p.id, vanId), 1);
      assert.equal(await inventoryLedgerBalance(), ledgerBefore, "a relocation changes no value");
      const adjustments = await db.stockMovement.count({ where: { productId: p.id, type: "ADJUSTMENT" } });
      assert.equal(adjustments, 0);
    });

    it("refuses zero lines, repeated locations and foreign ids", async () => {
      const p = await newProduct({ costPriceCents: 250 });
      await rejectsStatus(
        db.$transaction((tx) => inv.adjustAcrossLocations(tx, { companyId, productId: p.id, lines: [{ locationId: mainId, quantity: 0 }] })),
        422,
      );
      await rejectsStatus(
        db.$transaction((tx) =>
          inv.adjustAcrossLocations(tx, { companyId, productId: p.id, lines: [{ locationId: mainId, quantity: 1 }, { locationId: mainId, quantity: -1 }] }),
        ),
        422,
        /once/i,
      );
      await rejectsStatus(
        db.$transaction((tx) => inv.adjustAcrossLocations(tx, { companyId, productId: p.id, lines: [{ locationId: otherLocationId, quantity: 1 }] })),
        404,
      );
      await rejectsStatus(
        db.$transaction((tx) => inv.adjustAcrossLocations(tx, { companyId: otherCompanyId, productId: p.id, lines: [{ locationId: otherLocationId, quantity: 1 }] })),
        404,
      );
    });
  });
});
