/**
 * Checks the ledger against the operational tables.
 *
 * The trial balance summing to zero only proves each entry was internally
 * balanced — a posting rule that books the wrong amount, or a document class
 * that is never posted at all, balances perfectly and is still wrong. The only
 * test that catches that is recomputing each figure straight from the source
 * records and comparing.
 *
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/reconcile-ledger.ts
 */
import { PrismaClient } from "@prisma/client";

import { trialBalance, trialBalanceTotals } from "../src/server/ledger";

const db = new PrismaClient();

const fmt = (c: number) =>
  `${c < 0 ? "-" : ""}KES ${Math.abs(c / 100).toLocaleString("en-KE", { minimumFractionDigits: 2 })}`;

let failures = 0;

function check(label: string, ledgerCents: number, sourceCents: number, note?: string) {
  const diff = ledgerCents - sourceCents;
  const ok = diff === 0;
  if (!ok) failures++;
  console.log(
    `  ${ok ? "OK  " : "DIFF"} ${label.padEnd(26)} ledger ${fmt(ledgerCents).padStart(18)}   source ${fmt(sourceCents).padStart(18)}${ok ? "" : `   out by ${fmt(diff)}`}`,
  );
  if (!ok && note) console.log(`       ${note}`);
}

async function reconcile(companyId: string, name: string) {
  console.log(`\n${name}`);

  const totals = await trialBalanceTotals(companyId);
  if (totals.debits === 0 && totals.credits === 0) {
    console.log("  no ledger activity — skipped");
    return;
  }
  console.log(
    `  trial balance ${fmt(totals.debits)} / ${fmt(totals.credits)} — ${totals.balanced ? "balanced" : "NOT BALANCED"}`,
  );
  if (!totals.balanced) failures++;

  const rows = await trialBalance(companyId);
  const bal = (code: string) => rows.find((r) => r.code === code)?.balanceCents ?? 0;

  // --- Revenue and tax, straight off the invoices -------------------------
  const invoices = await db.invoice.findMany({
    where: { companyId, status: { not: "DRAFT" } },
    select: { totalCents: true, taxCents: true, paidCents: true },
  });
  const invTotal = invoices.reduce((n, i) => n + i.totalCents, 0);
  const invTax = invoices.reduce((n, i) => n + i.taxCents, 0);
  const invPaid = invoices.reduce((n, i) => n + i.paidCents, 0);

  // Credit notes reverse part of a sale, so every figure derived from invoices
  // has to net them off. Leaving them out overstates revenue, receivables and
  // the VAT owed by exactly the amount that was credited.
  const notes = await db.creditNote.findMany({
    where: { companyId, status: { not: "CANCELLED" } },
    select: { totalCents: true, taxCents: true },
  });
  const cnTotal = notes.reduce((n, c) => n + c.totalCents, 0);
  const cnTax = notes.reduce((n, c) => n + c.taxCents, 0);

  // Sales and Sales returns are separate accounts. `bal` already reports each
  // in its natural direction, so a returns account that has only been debited
  // comes back negative — these are added, not subtracted.
  check("Sales net of returns", bal("4000") + bal("4100"), invTotal - invTax - (cnTotal - cnTax));
  check("VAT payable (2100)", bal("2100"), invTax - cnTax);

  // --- Receivables --------------------------------------------------------
  const payments = await db.payment.findMany({
    where: { companyId },
    select: { amountCents: true, method: true },
  });
  const paidTotal = payments.reduce((n, p) => n + p.amountCents, 0);

  check(
    "Receivables (1200)",
    bal("1200"),
    invTotal - paidTotal - cnTotal,
    "AR is invoiced, less received, less credited. A gap means something was posted that no document accounts for.",
  );

  // --- Cash, bank and gateway clearing ------------------------------------
  const bucket = (m: string) =>
    m === "CASH" ? "1000" : m === "BANK" || m === "CHEQUE" ? "1010" : "1050";
  const byAccount: Record<string, number> = { "1000": 0, "1010": 0, "1050": 0 };
  for (const p of payments) byAccount[bucket(p.method)] += p.amountCents;

  const expenses = await db.expense.findMany({
    where: { companyId, status: { in: ["APPROVED", "PAID"] } },
    select: { amountCents: true },
  });
  const expTotal = expenses.reduce((n, e) => n + e.amountCents, 0);

  // Expenses credit cash, so net it off the cash bucket.
  check("Cash (1000)", bal("1000"), byAccount["1000"] - expTotal);
  check("Bank (1010)", bal("1010"), byAccount["1010"]);
  check("Gateway clearing (1050)", bal("1050"), byAccount["1050"]);

  // --- Inventory ----------------------------------------------------------
  // Every movement that touches value, summed in its own direction. This is
  // what the inventory account should hold if nothing was missed.
  const movements = await db.stockMovement.findMany({
    where: { companyId },
    select: { type: true, quantity: true, unitCostCents: true },
  });
  const valued = movements
    .filter((m) => !m.type.startsWith("TRANSFER"))
    .reduce((n, m) => n + m.quantity * m.unitCostCents, 0);

  const receipts = await db.goodsReceipt.findMany({
    where: { companyId, status: "POSTED" },
    select: { lines: { select: { quantity: true, unitCostCents: true } } },
  });
  const receiptValue = receipts.reduce(
    (n, g) => n + g.lines.reduce((m, l) => m + Math.abs(l.quantity) * l.unitCostCents, 0),
    0,
  );

  check(
    "Inventory (1300)",
    bal("1300"),
    valued + receiptValue,
    "Inventory is opening + purchases less cost of sales. A credit balance means stock left without ever being booked in.",
  );

  if (bal("1300") < 0) {
    console.log("       WARNING: inventory is an asset and must not sit in credit.");
    failures++;
  }

  // --- Profit and loss, both ways -----------------------------------------
  const income = rows.filter((r) => r.type === "INCOME").reduce((n, r) => n + r.balanceCents, 0);
  const cost = rows.filter((r) => r.type === "EXPENSE").reduce((n, r) => n + r.balanceCents, 0);
  const cogs = bal("5000");

  console.log(
    `\n  P&L from the ledger:  revenue ${fmt(income)} − cost ${fmt(cost)} = ${fmt(income - cost)}`,
  );
  const netRevenue = invTotal - invTax - (cnTotal - cnTax);
  console.log(
    `  P&L from the tables:  revenue ${fmt(netRevenue)} − COGS ${fmt(cogs)} − expenses ${fmt(expTotal)} = ${fmt(netRevenue - cogs - expTotal)}`,
  );
  check("Profit", income - cost, netRevenue - cogs - expTotal);

  // A figure worth printing on its own: allocations vs receipts.
  if (invPaid !== paidTotal) {
    console.log(
      `\n  Note: KES ${((paidTotal - invPaid) / 100).toFixed(2)} of receipts is not allocated to any invoice (prepayment or on-account).`,
    );
  }
}

async function main() {
  const companies = await db.company.findMany({
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
  for (const c of companies) await reconcile(c.id, c.name);

  console.log(
    failures === 0
      ? "\nThe ledger agrees with the operational tables."
      : `\n${failures} reconciliation difference(s) — see above.`,
  );
  if (failures > 0) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
