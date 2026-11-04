import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  chargedLine,
  computeLine,
  computeTotals,
  creditLineAmounts,
  deriveInvoiceStatus,
  inclusiveTax,
  outstandingCents,
} from "./money";

/**
 * The single money engine. Orders, invoices and purchase orders all price a
 * line through `computeLine`, and the field app's `Money.lineTotal` mirrors it
 * in Dart — so these figures are the reference every other calculation in the
 * system has to agree with.
 */
describe("computeLine", () => {
  it("adds VAT on top of a tax-exclusive price", () => {
    const t = computeLine({ quantity: 10, unitPriceCents: 10_000, taxRateBp: 1600 });
    assert.deepEqual(t, {
      grossCents: 100_000,
      discountCents: 0,
      netCents: 100_000,
      taxCents: 16_000,
      lineTotalCents: 116_000,
    });
  });

  it("charges VAT on the discounted consideration, and the total is already net of the discount", () => {
    const t = computeLine({ quantity: 10, unitPriceCents: 10_000, discountCents: 10_000, taxRateBp: 1600 });
    assert.equal(t.netCents, 90_000);
    assert.equal(t.taxCents, 14_400);
    // The stored line total. Anything that takes the discount off this figure
    // again is counting it twice.
    assert.equal(t.lineTotalCents, 104_400);
  });

  it("never discounts below zero", () => {
    const t = computeLine({ quantity: 1, unitPriceCents: 500, discountCents: 9_999, taxRateBp: 1600 });
    assert.equal(t.discountCents, 500);
    assert.equal(t.lineTotalCents, 0);
  });

  it("charges nothing on an exempt or zero-rated line", () => {
    const t = computeLine({ quantity: 3, unitPriceCents: 3_333, taxRateBp: 0 });
    assert.equal(t.taxCents, 0);
    assert.equal(t.lineTotalCents, 9_999);
  });

  it("rolls lines into document totals that add up", () => {
    const d = computeTotals([
      { quantity: 10, unitPriceCents: 10_000, discountCents: 10_000, taxRateBp: 1600 },
      { quantity: 2, unitPriceCents: 2_500, taxRateBp: 0 },
    ]);
    assert.equal(d.subtotalCents, 105_000);
    assert.equal(d.discountCents, 10_000);
    assert.equal(d.taxCents, 14_400);
    assert.equal(d.totalCents, d.subtotalCents - d.discountCents + d.taxCents);
  });
});

/** Ten units at KES 100, KES 100 off the line, 16% VAT: invoiced at KES 1,044. */
const discounted = {
  quantity: 10,
  unitPriceCents: 10_000,
  discountCents: 10_000,
  taxRateBp: 1600,
  lineTotalCents: 104_400,
};

describe("chargedLine", () => {
  it("splits a stored line into what the customer was actually charged", () => {
    const c = chargedLine(discounted);
    assert.equal(c.netCents, 90_000);
    assert.equal(c.taxCents, 14_400);
    assert.equal(c.lineTotalCents, 104_400);
    // What KRA must be told: taxable 900.00 + VAT 144.00 = 1,044.00. Filing
    // (total − discount) as the taxable base under-reported both.
    assert.equal(c.netCents + c.taxCents, c.lineTotalCents);
  });

  it("trusts the stored total when the formula does not reproduce it", () => {
    // A line written before computeLine was the only engine. What the customer
    // paid wins, and VAT is split out of it the way KRA derives it.
    const c = chargedLine({ quantity: 1, unitPriceCents: 10_000, discountCents: 0, taxRateBp: 1600, lineTotalCents: 11_700 });
    assert.equal(c.lineTotalCents, 11_700);
    assert.equal(c.taxCents, inclusiveTax(11_700, 1600));
    assert.equal(c.netCents + c.taxCents, 11_700);
  });
});

describe("creditLineAmounts", () => {
  it("credits a fully returned discounted line to the cent", () => {
    // The old formula took the discount off a total that already excluded it:
    // this return credited 944.00 against 1,044.00 charged, and cancelled the
    // invoice with the difference still sitting on the customer's balance.
    const c = creditLineAmounts(discounted, [], 10);
    assert.equal(c.totalCents, 104_400);
    assert.equal(c.taxCents, 14_400);
    assert.equal(c.netCents, 90_000);
  });

  it("splits a partial return proportionally and gives the rest to the return that completes the line", () => {
    const first = creditLineAmounts(discounted, [], 3);
    assert.equal(first.totalCents, 31_320);
    assert.equal(first.taxCents, 4_320);

    const rest = creditLineAmounts(discounted, [{ quantity: 3, lineTotalCents: first.totalCents }], 7);
    assert.equal(first.totalCents + rest.totalCents, 104_400);
    assert.equal(first.taxCents + rest.taxCents, 14_400);
  });

  it("returns a line one unit at a time without losing a cent to rounding", () => {
    // 3 × KES 33.33 + 16% VAT = 115.99, which does not divide by three.
    const line = { quantity: 3, unitPriceCents: 3_333, discountCents: 0, taxRateBp: 1600, lineTotalCents: 11_599 };
    const prior: Array<{ quantity: number; lineTotalCents: number }> = [];
    let total = 0;
    let tax = 0;
    for (let i = 0; i < 3; i++) {
      const c = creditLineAmounts(line, prior, 1);
      prior.push({ quantity: 1, lineTotalCents: c.totalCents });
      total += c.totalCents;
      tax += c.taxCents;
    }
    assert.equal(total, 11_599);
    assert.equal(tax, computeLine(line).taxCents);
  });

  it("makes the customer whole on the completing return after an under-credit by the old formula", () => {
    // Five units credited before the fix at round((104,400 − 10,000) / 10) each.
    const prior = [{ quantity: 5, lineTotalCents: 9_440 * 5 }];
    const c = creditLineAmounts(discounted, prior, 5);
    assert.equal(prior[0].lineTotalCents + c.totalCents, 104_400);
  });

  it("credits no VAT on an exempt line", () => {
    const line = { quantity: 4, unitPriceCents: 2_500, discountCents: 0, taxRateBp: 0, lineTotalCents: 10_000 };
    assert.equal(creditLineAmounts(line, [], 1).taxCents, 0);
    assert.equal(creditLineAmounts(line, [], 4).taxCents, 0);
  });

  it("refuses a quantity that is not a positive whole number", () => {
    assert.throws(() => creditLineAmounts(discounted, [], 0), /positive/);
    assert.throws(() => creditLineAmounts(discounted, [], -1), /positive/);
    assert.throws(() => creditLineAmounts(discounted, [], 1.5), /positive/);
  });

  it("refuses to credit more than remains uncredited", () => {
    assert.throws(
      () => creditLineAmounts(discounted, [{ quantity: 8, lineTotalCents: 83_520 }], 3),
      /only 2 remain/,
    );
  });
});

/**
 * A credit note reduces what is owed exactly as a payment does. Allocation,
 * status derivation and the invoices API all read these two functions, so a
 * part-returned invoice cannot be over-collected by any of them.
 */
describe("outstandingCents and credited-aware status", () => {
  it("nets credits off the outstanding figure and never goes below zero", () => {
    assert.equal(outstandingCents({ totalCents: 23_200, paidCents: 0, creditedCents: 11_600 }), 11_600);
    assert.equal(outstandingCents({ totalCents: 23_200, paidCents: 11_600, creditedCents: 11_600 }), 0);
    assert.equal(outstandingCents({ totalCents: 23_200, paidCents: 20_000, creditedCents: 11_600 }), 0);
    assert.equal(outstandingCents({ totalCents: 23_200, paidCents: 5_000 }), 18_200);
  });

  it("marks an invoice PAID once paid plus credited covers the total", () => {
    const base = { totalCents: 23_200, dueDate: null, current: "PARTIALLY_PAID" };
    assert.equal(deriveInvoiceStatus({ ...base, paidCents: 11_600, creditedCents: 11_600 }), "PAID");
    assert.equal(deriveInvoiceStatus({ ...base, paidCents: 11_600, creditedCents: 0 }), "PARTIALLY_PAID");
    assert.equal(deriveInvoiceStatus({ ...base, paidCents: 0, creditedCents: 11_600, current: "ISSUED" }), "ISSUED");
  });

  it("leaves DRAFT and CANCELLED alone and respects the due date", () => {
    const past = new Date(Date.now() - 86_400_000);
    assert.equal(deriveInvoiceStatus({ totalCents: 100, paidCents: 100, dueDate: null, current: "CANCELLED" }), "CANCELLED");
    assert.equal(deriveInvoiceStatus({ totalCents: 100, paidCents: 0, dueDate: null, current: "DRAFT" }), "DRAFT");
    assert.equal(deriveInvoiceStatus({ totalCents: 100, paidCents: 0, dueDate: past, current: "ISSUED" }), "OVERDUE");
    assert.equal(deriveInvoiceStatus({ totalCents: 100, paidCents: 40, dueDate: past, current: "ISSUED" }), "OVERDUE");
  });
});
