import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

/**
 * The money paths — payments, allocations, gateway settlement, orders and the
 * customer balance — exercised against a throwaway copy of the dev database.
 *
 * DATABASE_URL is pointed at the copy before any module is imported, because
 * `@/lib/db` builds its PrismaClient at import time. prisma/xos.db is never
 * touched.
 */
const dir = mkdtempSync(path.join(tmpdir(), "xos-money-"));
const file = path.join(dir, "xos.db");
copyFileSync(path.resolve(__dirname, "../../prisma/xos.db"), file);
process.env.DATABASE_URL = `file:${file.split(path.sep).join("/")}`;

type Sales = typeof import("./sales");
type Collections = typeof import("./collections");
type CreditNotes = typeof import("./credit-notes");
type Db = typeof import("@/lib/db")["db"];

let sales: Sales;
let collections: Collections;
let creditNotes: CreditNotes;
let db: Db;

let companyId: string;
let otherCompanyId: string;
let productId: string;
let userId: string | null;
let customerSeq = 0;

async function newCustomer(company = companyId) {
  customerSeq++;
  return db.customer.create({
    data: {
      companyId: company,
      code: `TST-${Date.now()}-${customerSeq}`,
      name: `Money test customer ${customerSeq}`,
      phone: null,
      paymentTermsDays: 30,
    },
  });
}

/** An issued invoice for one unit, with no stock location so nothing moves. */
async function invoiceFor(customerId: string, unitPriceCents = 10_000, issue = true) {
  return sales.createInvoice({
    companyId,
    customerId,
    lines: [{ productId, quantity: 1, unitPriceCents }],
    issue,
    createdById: userId,
  });
}

/** The balance the invariant says the customer should carry. */
async function expectedBalance(customerId: string) {
  const [inv, pay, cn] = await Promise.all([
    db.invoice.aggregate({ where: { customerId, status: { not: "DRAFT" } }, _sum: { totalCents: true } }),
    db.payment.aggregate({ where: { customerId }, _sum: { amountCents: true } }),
    db.creditNote.aggregate({ where: { customerId, status: { not: "CANCELLED" } }, _sum: { totalCents: true } }),
  ]);
  return (inv._sum.totalCents ?? 0) - (pay._sum.amountCents ?? 0) - (cn._sum.totalCents ?? 0);
}

const rejects422 = (p: Promise<unknown>, pattern?: RegExp) =>
  assert.rejects(p, (error: unknown) => {
    const e = error as { status?: number; message: string };
    assert.equal(e.status, 422, `expected 422, got ${e.status}: ${e.message}`);
    if (pattern) assert.match(e.message, pattern);
    return true;
  });

describe("money paths", () => {
  before(async () => {
    ({ db } = await import("@/lib/db"));
    sales = await import("./sales");
    collections = await import("./collections");
    creditNotes = await import("./credit-notes");

    const tari = await db.company.findUniqueOrThrow({ where: { slug: "tari" } });
    companyId = tari.id;
    const other = await db.company.create({
      data: { name: "Other Tenant", slug: `other-${Date.now()}`, status: "ACTIVE" },
    });
    otherCompanyId = other.id;

    const product = await db.product.findFirstOrThrow({
      where: { companyId, active: true, taxRateBp: 1600 },
    });
    productId = product.id;
    const user = await db.user.findFirst({ where: { companyId }, select: { id: true } });
    userId = user?.id ?? null;
  });

  after(async () => {
    await db.$disconnect();
  });

  // ── recordPayment: allocation validation ──────────────────────────────

  describe("recordPayment validates allocations", () => {
    it("rejects a customer from another company as not found", async () => {
      const foreign = await newCustomer(otherCompanyId);
      await assert.rejects(
        sales.recordPayment({ companyId, customerId: foreign.id, amountCents: 1_000 }),
        (e: { status?: number }) => e.status === 404,
      );
    });

    it("rejects CREDIT_NOTE as a payment method", async () => {
      const c = await newCustomer();
      await rejects422(
        sales.recordPayment({ companyId, customerId: c.id, amountCents: 1_000, method: "CREDIT_NOTE" }),
        /credit note/i,
      );
    });

    it("rejects an unknown invoice instead of silently skipping it", async () => {
      const c = await newCustomer();
      await rejects422(
        sales.recordPayment({
          companyId,
          customerId: c.id,
          amountCents: 1_000,
          allocations: [{ invoiceId: "does-not-exist", amountCents: 1_000 }],
        }),
        /unknown invoice/i,
      );
      assert.equal(await db.payment.count({ where: { customerId: c.id } }), 0, "nothing was booked");
    });

    it("rejects allocations that total more than the payment", async () => {
      const c = await newCustomer();
      const inv = await invoiceFor(c.id); // 11,600 incl. VAT
      await rejects422(
        sales.recordPayment({
          companyId,
          customerId: c.id,
          amountCents: 5_000,
          allocations: [{ invoiceId: inv.id, amountCents: 6_000 }],
        }),
        /allocations total/i,
      );
    });

    it("rejects an allocation above what the invoice still owes", async () => {
      const c = await newCustomer();
      const inv = await invoiceFor(c.id);
      await rejects422(
        sales.recordPayment({
          companyId,
          customerId: c.id,
          amountCents: inv.totalCents + 100,
          allocations: [{ invoiceId: inv.id, amountCents: inv.totalCents + 100 }],
        }),
        /outstanding/i,
      );
    });

    it("rejects an invoice belonging to a different customer", async () => {
      const a = await newCustomer();
      const b = await newCustomer();
      const inv = await invoiceFor(a.id);
      await rejects422(
        sales.recordPayment({
          companyId,
          customerId: b.id,
          amountCents: 1_000,
          allocations: [{ invoiceId: inv.id, amountCents: 1_000 }],
        }),
        /different customer/i,
      );
    });

    it("rejects a draft invoice", async () => {
      const c = await newCustomer();
      const draft = await invoiceFor(c.id, 10_000, false);
      assert.equal(draft.status, "DRAFT");
      await rejects422(
        sales.recordPayment({
          companyId,
          customerId: c.id,
          amountCents: 1_000,
          allocations: [{ invoiceId: draft.id, amountCents: 1_000 }],
        }),
        /draft/i,
      );
    });

    it("books a valid explicit allocation and settles the invoice", async () => {
      const c = await newCustomer();
      const inv = await invoiceFor(c.id);
      const { payment, customer } = await sales.recordPayment({
        companyId,
        customerId: c.id,
        amountCents: inv.totalCents,
        method: "CASH",
        allocations: [{ invoiceId: inv.id, amountCents: inv.totalCents }],
      });
      const after = await db.invoice.findUniqueOrThrow({ where: { id: inv.id } });
      assert.equal(after.paidCents, inv.totalCents);
      assert.equal(after.status, "PAID");
      assert.equal(customer.balanceCents, 0);
      assert.equal(customer.balanceCents, await expectedBalance(c.id));

      const entry = await db.journalEntry.findFirst({
        where: { refType: "Payment", refId: payment.id, sourceKind: "RECEIPT" },
      });
      assert.ok(entry, "the receipt was posted in the same transaction");
    });
  });

  // ── settleIntent: double settlement ───────────────────────────────────

  describe("settleIntent", () => {
    async function processingIntent(customerId: string, amountCents = 25_000) {
      return db.paymentIntent.create({
        data: {
          companyId,
          customerId,
          provider: "MPESA_DARAJA",
          amountCents,
          status: "PROCESSING",
          providerRef: `ws_CO_${Date.now()}_${Math.random().toString(36).slice(2)}`,
          payerPhone: "254700000000",
        },
      });
    }

    const succeeded = async () => ({ status: "SUCCEEDED" as const, receiptRef: "QWE123" });

    it("books exactly one payment when a callback and a poll settle at once", async () => {
      const c = await newCustomer();
      await invoiceFor(c.id, 20_000);
      const intent = await processingIntent(c.id);

      const results = await Promise.all([
        collections.settleIntent(intent.id, { verify: succeeded }),
        collections.settleIntent(intent.id, { verify: succeeded }),
        collections.settleIntent(intent.id, { verify: succeeded }),
      ]);

      const payments = await db.payment.findMany({ where: { customerId: c.id } });
      assert.equal(payments.length, 1, "one payment, not one per caller");
      assert.equal(payments[0].amountCents, 25_000);
      assert.equal(payments[0].clientUuid, collections.intentClientUuid(intent.id));
      assert.equal(payments[0].method, "MPESA_STK");

      const final = await db.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } });
      assert.equal(final.status, "SUCCEEDED");
      assert.equal(final.paymentId, payments[0].id);
      assert.equal(final.receiptRef, "QWE123");
      // Every caller ends up looking at the same settled intent.
      for (const r of results) assert.ok(["SUCCEEDED", "SETTLING"].includes(r.status));

      const customer = await db.customer.findUniqueOrThrow({ where: { id: c.id } });
      assert.equal(customer.balanceCents, await expectedBalance(c.id));
    });

    it("is a no-op once settled, even if the provider is asked again", async () => {
      const c = await newCustomer();
      const intent = await processingIntent(c.id, 5_000);
      await collections.settleIntent(intent.id, { verify: succeeded });
      let verifyCalls = 0;
      const again = await collections.settleIntent(intent.id, {
        verify: async () => {
          verifyCalls++;
          return succeeded();
        },
      });
      assert.equal(again.status, "SUCCEEDED");
      assert.equal(verifyCalls, 0, "a terminal intent never asks the provider");
      assert.equal(await db.payment.count({ where: { customerId: c.id } }), 1);
    });

    it("releases the claim when booking fails so the next poll can retry", async () => {
      const c = await newCustomer();
      // An intent whose own amount recordPayment refuses (zero), so the
      // provider's verdict is accepted but the booking itself fails. (A verdict
      // amount that differs from the intent is no longer a booking error — it
      // is refused as an amount mismatch; see collections.test.ts.)
      const intent = await processingIntent(c.id, 0);
      await assert.rejects(collections.settleIntent(intent.id, { verify: succeeded }));
      const released = await db.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } });
      assert.equal(released.status, "PROCESSING");
      assert.equal(released.paymentId, null);

      await db.paymentIntent.update({ where: { id: intent.id }, data: { amountCents: 7_000 } });
      const settled = await collections.settleIntent(intent.id, { verify: succeeded });
      assert.equal(settled.status, "SUCCEEDED");
      assert.equal(await db.payment.count({ where: { customerId: c.id } }), 1);
    });

    it("records a failed verdict without booking anything", async () => {
      const c = await newCustomer();
      const intent = await processingIntent(c.id);
      const failed = await collections.settleIntent(intent.id, {
        verify: async () => ({ status: "FAILED", failureReason: "Cancelled by user" }),
      });
      assert.equal(failed.status, "FAILED");
      assert.equal(failed.failureReason, "Cancelled by user");
      assert.equal(await db.payment.count({ where: { customerId: c.id } }), 0);
    });
  });

  // ── createSalesOrder: atomicity ───────────────────────────────────────

  describe("createSalesOrder", () => {
    it("writes the order, its lines and the activity together", async () => {
      const c = await newCustomer();
      const order = await sales.createSalesOrder({
        companyId,
        customerId: c.id,
        lines: [{ productId, quantity: 2, unitPriceCents: 1_000 }],
        createdById: userId,
      });
      assert.equal(order.lines.length, 1);
      assert.equal(order.totalCents, 2_320);
      const activity = await db.customerActivity.findFirst({
        where: { customerId: c.id, type: "ORDER", subject: `Order ${order.number}` },
      });
      assert.ok(activity, "activity entry committed with the order");
    });

    it("leaves nothing behind — not even a burnt number — when the write fails", async () => {
      const c = await newCustomer();
      const before = await db.documentCounter.findUnique({
        where: { companyId_docType: { companyId, docType: "ORDER" } },
      });
      const ordersBefore = await db.salesOrder.count({ where: { companyId } });
      const activitiesBefore = await db.customerActivity.count({ where: { customerId: c.id } });

      // A visit that does not exist violates the foreign key *after* the
      // number has been taken inside the transaction.
      await assert.rejects(
        sales.createSalesOrder({
          companyId,
          customerId: c.id,
          lines: [{ productId, quantity: 1 }],
          visitId: "visit-that-does-not-exist",
        }),
      );

      const after = await db.documentCounter.findUnique({
        where: { companyId_docType: { companyId, docType: "ORDER" } },
      });
      assert.equal(after?.nextValue, before?.nextValue, "the counter rolled back with the order");
      assert.equal(await db.salesOrder.count({ where: { companyId } }), ordersBefore);
      assert.equal(await db.customerActivity.count({ where: { customerId: c.id } }), activitiesBefore);
    });

    it("rejects a customer from another company", async () => {
      const foreign = await newCustomer(otherCompanyId);
      await assert.rejects(
        sales.createSalesOrder({ companyId, customerId: foreign.id, lines: [{ productId, quantity: 1 }] }),
        (e: { status?: number }) => e.status === 404,
      );
    });
  });

  // ── customer balance and credit-note outstanding ──────────────────────

  describe("customer balance and credit notes", () => {
    it("recomputes the balance after every write instead of incrementing it", async () => {
      const c = await newCustomer();
      const inv = await invoiceFor(c.id, 10_000); // 11,600
      let cust = await db.customer.findUniqueOrThrow({ where: { id: c.id } });
      assert.equal(cust.balanceCents, 11_600);

      // Drift the stored figure the way a half-applied replay would, then let
      // the next write put it right.
      await db.customer.update({ where: { id: c.id }, data: { balanceCents: 999_999 } });
      await sales.recordPayment({ companyId, customerId: c.id, amountCents: 1_600 });
      cust = await db.customer.findUniqueOrThrow({ where: { id: c.id } });
      assert.equal(cust.balanceCents, 10_000);
      assert.equal(cust.balanceCents, await expectedBalance(c.id));

      const line = (await db.invoiceLine.findFirstOrThrow({ where: { invoiceId: inv.id } })).id;
      await creditNotes.createCreditNote({
        companyId,
        invoiceId: inv.id,
        reason: "Damaged",
        restock: false,
        lines: [{ invoiceLineId: line, quantity: 1 }],
      });
      cust = await db.customer.findUniqueOrThrow({ where: { id: c.id } });
      // Fully credited: the customer paid 1,600 against goods that came back,
      // so they now hold a 1,600 credit.
      assert.equal(cust.balanceCents, -1_600);
      assert.equal(cust.balanceCents, await expectedBalance(c.id));
      const cancelled = await db.invoice.findUniqueOrThrow({ where: { id: inv.id } });
      assert.equal(cancelled.status, "CANCELLED");
    });

    it("treats credited amounts as outstanding reduction when allocating and deriving status", async () => {
      const c = await newCustomer();
      // Two units so one can come back.
      const inv = await sales.createInvoice({
        companyId,
        customerId: c.id,
        lines: [{ productId, quantity: 2, unitPriceCents: 10_000 }],
        createdById: userId,
      }); // 23,200 incl. VAT
      const line = (await db.invoiceLine.findFirstOrThrow({ where: { invoiceId: inv.id } })).id;

      const note = await creditNotes.createCreditNote({
        companyId,
        invoiceId: inv.id,
        reason: "One returned",
        restock: false,
        lines: [{ invoiceLineId: line, quantity: 1 }],
      });
      assert.equal(note.totalCents, 11_600);

      // Outstanding is now 11,600, not 23,200. An explicit allocation of the
      // old figure must be refused…
      await rejects422(
        sales.recordPayment({
          companyId,
          customerId: c.id,
          amountCents: 23_200,
          allocations: [{ invoiceId: inv.id, amountCents: 23_200 }],
        }),
        /outstanding/i,
      );

      // …and auto-allocation of a round payment only takes what is owed.
      const { customer } = await sales.recordPayment({
        companyId,
        customerId: c.id,
        amountCents: 15_000,
      });
      const allocated = await db.paymentAllocation.aggregate({
        where: { invoiceId: inv.id },
        _sum: { amountCents: true },
      });
      assert.equal(allocated._sum.amountCents, 11_600);

      const after = await db.invoice.findUniqueOrThrow({ where: { id: inv.id } });
      assert.equal(after.paidCents, 11_600);
      assert.equal(after.status, "PAID", "paid + credited covers the total");

      // 23,200 invoiced − 15,000 paid − 11,600 credited = −3,400 on account.
      assert.equal(customer.balanceCents, -3_400);
      assert.equal(customer.balanceCents, await expectedBalance(c.id));
    });

    it("marks a part-credited, part-paid invoice PAID as soon as nothing is owed", async () => {
      const c = await newCustomer();
      const inv = await sales.createInvoice({
        companyId,
        customerId: c.id,
        lines: [{ productId, quantity: 2, unitPriceCents: 10_000 }],
      });
      await sales.recordPayment({
        companyId,
        customerId: c.id,
        amountCents: 11_600,
        allocations: [{ invoiceId: inv.id, amountCents: 11_600 }],
      });
      let mid = await db.invoice.findUniqueOrThrow({ where: { id: inv.id } });
      assert.equal(mid.status, "PARTIALLY_PAID");

      const line = (await db.invoiceLine.findFirstOrThrow({ where: { invoiceId: inv.id } })).id;
      await creditNotes.createCreditNote({
        companyId,
        invoiceId: inv.id,
        reason: "Other unit returned",
        restock: false,
        lines: [{ invoiceLineId: line, quantity: 1 }],
      });
      mid = await db.invoice.findUniqueOrThrow({ where: { id: inv.id } });
      assert.equal(mid.status, "PAID");
      const cust = await db.customer.findUniqueOrThrow({ where: { id: c.id } });
      assert.equal(cust.balanceCents, 0);
    });
  });
});
