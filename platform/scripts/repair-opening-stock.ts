/**
 * Books an OPENING movement, with its ledger entry, for every stock item that
 * holds a quantity but has no movement history.
 *
 * Stock that was loaded straight into StockItem (an early seed, a hand edit)
 * has a quantity the valuation report sees but the ledger never did: every
 * sale then relieves inventory at cost against stock that was never booked
 * in, and the inventory account drifts negative. check-consistency.mjs flags
 * these as "quantity N with no movements".
 *
 * The repair goes through `applyMovement`, the same path a goods receipt
 * uses, so the movement, the running balance and the journal entry are made
 * by production code rather than by hand. The item's quantity is zeroed first
 * inside the same transaction, because applyMovement increments.
 *
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/repair-opening-stock.ts [--apply] [--company <slug>]
 *
 * Without --apply it only reports what it would do.
 */

import { db } from "../src/lib/db";
import { applyMovement } from "../src/server/inventory";

const apply = process.argv.includes("--apply");
const slugArg = process.argv.indexOf("--company");
const slug = slugArg >= 0 ? process.argv[slugArg + 1] : null;

async function main() {
  const companies = await db.company.findMany({
    where: slug ? { slug } : {},
    select: { id: true, slug: true, name: true },
    orderBy: { slug: "asc" },
  });

  let repaired = 0;
  let valueCents = 0;

  for (const company of companies) {
    const items = await db.stockItem.findMany({
      where: { companyId: company.id, quantity: { not: 0 } },
      include: {
        product: { select: { name: true, sku: true, costPriceCents: true, trackStock: true } },
        location: { select: { name: true } },
      },
      orderBy: [{ location: { name: "asc" } }, { product: { name: "asc" } }],
    });

    const orphans = [];
    for (const item of items) {
      const moved = await db.stockMovement.count({
        where: { productId: item.productId, locationId: item.locationId },
      });
      if (moved === 0) orphans.push(item);
    }
    if (orphans.length === 0) continue;

    console.log(`\n${company.name} (${company.slug}): ${orphans.length} item(s) without movements`);
    for (const item of orphans) {
      const cost = item.product.costPriceCents;
      const value = Math.abs(item.quantity) * cost;
      console.log(
        `  ${item.location.name.padEnd(18)} ${item.product.sku.padEnd(12)} qty ${String(item.quantity).padStart(5)} @ ${(cost / 100).toFixed(2)} = KES ${(value / 100).toLocaleString("en-KE")}`,
      );
      valueCents += value;

      if (!apply) continue;

      await db.$transaction(async (tx) => {
        // applyMovement increments; start from zero so the balance lands on
        // exactly the quantity the item already showed.
        await tx.stockItem.update({ where: { id: item.id }, data: { quantity: 0 } });
        await applyMovement(tx, {
          companyId: company.id,
          productId: item.productId,
          locationId: item.locationId,
          type: "OPENING",
          quantity: item.quantity,
          unitCostCents: cost,
          refType: "DataRepair",
          refId: item.id,
          note: "Opening balance booked retrospectively (stock existed before movement history)",
        });
      });
      repaired++;
    }
  }

  console.log(
    `\n${apply ? "Repaired" : "Would repair"} ${apply ? repaired : "the items above"}; opening value KES ${(valueCents / 100).toLocaleString("en-KE")}.` +
      (apply ? "" : " Re-run with --apply to book them."),
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
