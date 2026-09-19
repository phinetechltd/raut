import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { computeLine, computeTotals } from "./money";

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
