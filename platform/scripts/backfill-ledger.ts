/**
 * Replays existing documents into the ledger.
 *
 * A company that was trading before the ledger existed has invoices, payments,
 * receipts and expenses that never produced a journal entry. Without this, the
 * trial balance reflects only what has happened since the deploy, and every
 * report built on it is wrong for the period that matters most.
 *
 * It deliberately imports the *same* posting rules the live write paths use.
 * A backfill with its own copy of the rules drifts from production the first
 * time either changes, and the difference shows up as an unexplained variance
 * months later.
 *
 * Idempotent by construction — `postEntry` is a no-op when a document has
 * already been posted for that kind — so it is safe to re-run, and safe to run
 * while the system is live.
 *
 *   npx tsx scripts/backfill-ledger.ts [--company <slug>] [--dry]
 */
import { PrismaClient } from "@prisma/client";

import {
  postCogs,
  postExpense,
  postGoodsReceiptEntry,
  postInvoice,
  postOpeningStock,
  postPayment,
  postStockAdjustment,
} from "../src/server/posting";
import { ensureChartOfAccounts, trialBalanceTotals } from "../src/server/ledger";

const db = new PrismaClient();

const args = process.argv.slice(2);
const dryRun = args.includes("--dry");
// indexOf returns -1 when the flag is absent, and args[0] is not the slug.
const flag = args.indexOf("--company");
const slug = flag >= 0 ? args[flag + 1] : undefined;

const fmt = (cents: number) =>
  `KES ${(cents / 100).toLocaleString("en-KE", { minimumFractionDigits: 2 })}`;

async function backfillCompany(companyId: string, name: string) {
  console.log(`\n${name}`);

  const created = await ensureChartOfAccounts(companyId);
  if (created > 0) console.log(`  chart of accounts: ${created} created`);

  const counts = { invoices: 0, cogs: 0, payments: 0, receipts: 0, expenses: 0 };

  // postEntry returns the existing entry when a document is already posted, so
  // the counters below say "documents replayed", not "entries written". Take
  // the difference in entries to report what actually changed — otherwise a
  // second run reads as though it re-posted everything.
  const entriesBefore = await db.journalEntry.count({ where: { companyId } });

  // Chronological, because a period that gets closed later must contain the
  // entries that belong in it. Documents are replayed one transaction each
  // rather than one big one: a single failure should not discard the rest.
  const invoices = await db.invoice.findMany({
    where: { companyId, status: { not: "DRAFT" } },
    orderBy: { issueDate: "asc" },
  });
  for (const inv of invoices) {
    if (dryRun) { counts.invoices++; continue; }
    await db.$transaction(async (tx) => {
      const entry = await postInvoice(tx, inv, inv.createdById);
      if (entry) counts.invoices++;
    }, { timeout: 15_000 });
  }

  // Cost of sales comes from the movements, which carry the actual unit cost.
  const movements = await db.stockMovement.findMany({
    where: {
      companyId,
      type: { in: ["SALE", "RETURN", "ADJUSTMENT", "WRITE_OFF", "OPENING"] },
    },
    orderBy: { createdAt: "asc" },
  });
  for (const m of movements) {
    if (m.unitCostCents === 0) continue;
    if (dryRun) { counts.cogs++; continue; }
    await db.$transaction(async (tx) => {
      const entry =
        m.type === "SALE" || m.type === "RETURN"
          ? await postCogs(tx, m, m.createdById)
          : m.type === "OPENING"
            ? await postOpeningStock(tx, m, m.createdById)
            : await postStockAdjustment(tx, m, m.createdById);
      if (entry) counts.cogs++;
    }, { timeout: 15_000 });
  }

  const receipts = await db.goodsReceipt.findMany({
    where: { companyId, status: "POSTED" },
    include: { lines: true },
    orderBy: { receivedAt: "asc" },
  });
  for (const grn of receipts) {
    const valueCents = grn.lines.reduce(
      (n, l) => n + Math.abs(l.quantity) * l.unitCostCents,
      0,
    );
    if (valueCents === 0) continue;
    if (dryRun) { counts.receipts++; continue; }
    await db.$transaction(async (tx) => {
      const entry = await postGoodsReceiptEntry(
        tx,
        { id: grn.id, companyId, receivedAt: grn.receivedAt ?? grn.createdAt, valueCents },
        null,
      );
      if (entry) counts.receipts++;
    }, { timeout: 15_000 });
  }

  const payments = await db.payment.findMany({
    where: { companyId },
    orderBy: { paidAt: "asc" },
  });
  for (const p of payments) {
    if (dryRun) { counts.payments++; continue; }
    await db.$transaction(async (tx) => {
      const entry = await postPayment(tx, p, p.createdById);
      if (entry) counts.payments++;
    }, { timeout: 15_000 });
  }

  const expenses = await db.expense.findMany({
    where: { companyId, status: { in: ["APPROVED", "PAID"] } },
    include: { category: { select: { accountCode: true } } },
    orderBy: { incurredAt: "asc" },
  });
  for (const e of expenses) {
    if (dryRun) { counts.expenses++; continue; }
    await db.$transaction(async (tx) => {
      const entry = await postExpense(
        tx,
        {
          id: e.id,
          companyId,
          number: e.number,
          spentAt: e.incurredAt,
          amountCents: e.amountCents,
          categoryAccountCode: e.category?.accountCode ?? null,
        },
        e.userId,
      );
      if (entry) counts.expenses++;
    }, { timeout: 15_000 });
  }

  console.log(
    `  replayed: invoices ${counts.invoices} · stock ${counts.cogs} · receipts ${counts.receipts} · payments ${counts.payments} · expenses ${counts.expenses}`,
  );

  if (!dryRun) {
    const written = (await db.journalEntry.count({ where: { companyId } })) - entriesBefore;
    console.log(`  journal entries written: ${written} (the rest were already posted)`);
    const totals = await trialBalanceTotals(companyId);
    console.log(
      `  trial balance: ${fmt(totals.debits)} / ${fmt(totals.credits)} — ${
        totals.balanced ? "balanced" : `OUT BY ${fmt(totals.difference)}`
      }`,
    );
    if (!totals.balanced) process.exitCode = 1;
  }
}

async function main() {
  console.log(dryRun ? "Ledger backfill (dry run — nothing written)" : "Ledger backfill");

  const companies = await db.company.findMany({
    where: slug ? { slug } : {},
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
  if (companies.length === 0) {
    console.log("No companies matched.");
    return;
  }

  for (const c of companies) {
    await backfillCompany(c.id, c.name);
  }

  console.log("\nDone.");
}

main()
  .catch((error) => {
    console.error("Backfill failed:", error);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
