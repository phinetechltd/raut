#!/usr/bin/env node
/**
 * Consistency check: do the books, the documents and the stock agree?
 *
 * Read-only. Walks every company and verifies the invariants the write paths
 * promise — every issued invoice has its journal entry, every entry balances,
 * the customer's balance is what their documents say, stock balances are the
 * sum of their movements, and so on. Exits 1 on the first company with a
 * failure, after printing every offending id, so it can gate a deploy.
 *
 *   node scripts/check-consistency.mjs            # all companies
 *   node scripts/check-consistency.mjs --company tari
 *   node scripts/check-consistency.mjs --quiet    # failures only
 *
 * Uses DATABASE_URL from the environment, falling back to platform/.env.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PrismaClient } from "@prisma/client";

// ── env ─────────────────────────────────────────────────────────────────

if (!process.env.DATABASE_URL) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  try {
    for (const line of readFileSync(join(root, ".env"), "utf8").split(/\r?\n/)) {
      const m = /^\s*DATABASE_URL\s*=\s*"?([^"\s]+)"?\s*$/.exec(line);
      if (m) process.env.DATABASE_URL = m[1];
    }
  } catch {
    // Prisma will resolve it itself or fail with a clear message.
  }
}

const args = process.argv.slice(2);
const quiet = args.includes("--quiet");
const slugFlag = args.indexOf("--company");
const onlySlug = slugFlag >= 0 ? args[slugFlag + 1] : undefined;

const db = new PrismaClient();

// ── money maths, mirrored from src/lib/money.ts ─────────────────────────
// Duplicated on purpose: this script must run with plain node and no TS
// loader, and it is checking the engine, so it should not import it.

function computeLine(line) {
  const grossCents = line.quantity * line.unitPriceCents;
  const discountCents = Math.min(line.discountCents ?? 0, grossCents);
  const netCents = grossCents - discountCents;
  const taxCents = Math.round((netCents * (line.taxRateBp ?? 0)) / 10_000);
  return { grossCents, discountCents, netCents, taxCents, lineTotalCents: netCents + taxCents };
}

function inclusiveTax(totalCents, taxRateBp) {
  return Math.round((totalCents * taxRateBp) / (10_000 + taxRateBp));
}

function chargedLine(line) {
  const computed = computeLine(line);
  if (computed.lineTotalCents === line.lineTotalCents) return computed;
  const taxCents = inclusiveTax(line.lineTotalCents, line.taxRateBp);
  const netCents = line.lineTotalCents - taxCents;
  return {
    grossCents: netCents + computed.discountCents,
    discountCents: computed.discountCents,
    netCents,
    taxCents,
    lineTotalCents: line.lineTotalCents,
  };
}

function deriveInvoiceStatus({ totalCents, paidCents, creditedCents, dueDate, current, now }) {
  if (current === "DRAFT" || current === "CANCELLED") return current;
  if (totalCents > 0 && paidCents + (creditedCents ?? 0) >= totalCents) return "PAID";
  const overdue = dueDate != null && dueDate < now;
  if (paidCents > 0) return overdue ? "OVERDUE" : "PARTIALLY_PAID";
  return overdue ? "OVERDUE" : "ISSUED";
}

// ── reporting ───────────────────────────────────────────────────────────

let totalFailures = 0;
let totalWarnings = 0;

class Report {
  constructor(companyName) {
    this.companyName = companyName;
    this.failures = 0;
    this.warnings = 0;
    this.lines = [];
  }

  /** Records a check. `offenders` is a list of ids or short descriptions. */
  check(label, offenders, { warn = false, detail } = {}) {
    const list = offenders.filter((o) => o != null);
    if (list.length === 0) {
      if (!quiet) this.lines.push(`  OK    ${label}`);
      return true;
    }
    if (warn) {
      this.warnings++;
      totalWarnings++;
    } else {
      this.failures++;
      totalFailures++;
    }
    this.lines.push(`  ${warn ? "WARN " : "FAIL "} ${label} — ${list.length} offender(s)`);
    if (detail) this.lines.push(`        ${detail}`);
    const shown = list.slice(0, 25);
    for (const o of shown) this.lines.push(`        ${typeof o === "string" ? o : JSON.stringify(o)}`);
    if (list.length > shown.length) this.lines.push(`        … and ${list.length - shown.length} more`);
    return false;
  }

  print() {
    console.log(`\n${this.companyName}`);
    for (const l of this.lines) console.log(l);
    console.log(
      `  → ${this.failures === 0 ? "consistent" : `${this.failures} failing check(s)`}${
        this.warnings ? `, ${this.warnings} warning(s)` : ""
      }`,
    );
  }
}

const sumBy = (rows, f) => rows.reduce((n, r) => n + f(r), 0);
const groupSum = (rows, keyOf, f) => {
  const m = new Map();
  for (const r of rows) m.set(keyOf(r), (m.get(keyOf(r)) ?? 0) + f(r));
  return m;
};
const groupBy = (rows, keyOf) => {
  const m = new Map();
  for (const r of rows) {
    const k = keyOf(r);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return m;
};

// ── per-company checks ──────────────────────────────────────────────────

async function checkCompany(company) {
  const companyId = company.id;
  const r = new Report(`${company.name} (${company.slug})`);
  const now = new Date();

  // ---- load everything once ---------------------------------------------
  const [
    accounts,
    entries,
    invoices,
    payments,
    allocations,
    creditNotes,
    movements,
    stockItems,
    receipts,
    supplierInvoices,
    supplierPayments,
    suppliers,
    expenses,
    customers,
    orders,
    transfers,
    intents,
    counters,
    periods,
    products,
    locations,
  ] = await Promise.all([
    db.account.findMany({ where: { companyId } }),
    db.journalEntry.findMany({ where: { companyId }, include: { lines: true } }),
    db.invoice.findMany({ where: { companyId }, include: { lines: true } }),
    db.payment.findMany({ where: { companyId } }),
    db.paymentAllocation.findMany({
      where: { payment: { companyId } },
      include: { invoice: { select: { id: true, companyId: true, customerId: true, status: true } } },
    }),
    db.creditNote.findMany({ where: { companyId }, include: { lines: true } }),
    db.stockMovement.findMany({ where: { companyId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] }),
    db.stockItem.findMany({ where: { companyId } }),
    db.goodsReceipt.findMany({ where: { companyId }, include: { lines: true } }),
    db.supplierInvoice.findMany({ where: { companyId } }),
    db.supplierPayment.findMany({ where: { companyId } }),
    db.supplier.findMany({ where: { companyId }, select: { id: true, code: true, name: true, balanceCents: true } }),
    db.expense.findMany({ where: { companyId }, include: { category: { select: { companyId: true } } } }),
    db.customer.findMany({ where: { companyId } }),
    db.salesOrder.findMany({ where: { companyId } }),
    db.stockTransfer.findMany({ where: { companyId }, include: { lines: true } }),
    db.paymentIntent.findMany({ where: { companyId } }),
    db.documentCounter.findMany({ where: { companyId } }),
    db.accountingPeriod.findMany({ where: { companyId } }),
    db.product.findMany({ where: { companyId }, select: { id: true, costPriceCents: true } }),
    db.stockLocation.findMany({ where: { companyId }, select: { id: true } }),
  ]);

  const accountById = new Map(accounts.map((a) => [a.id, a]));
  const accountByKey = new Map(accounts.filter((a) => a.systemKey).map((a) => [a.systemKey, a]));
  const accountIdFor = (key, code) => accountByKey.get(key)?.id ?? accounts.find((a) => a.code === code)?.id;
  const AR = accountIdFor("ACCOUNTS_RECEIVABLE", "1200");
  const VAT_OUT = accountIdFor("VAT_OUTPUT", "2100");
  const INVENTORY = accountIdFor("INVENTORY", "1300");
  const CASH = accountIdFor("CASH", "1000");

  const customerById = new Map(customers.map((c) => [c.id, c]));
  const invoiceById = new Map(invoices.map((i) => [i.id, i]));
  const paymentById = new Map(payments.map((p) => [p.id, p]));
  const productIds = new Set(products.map((p) => p.id));
  const locationIds = new Set(locations.map((l) => l.id));

  const hasActivity =
    entries.length + invoices.length + payments.length + movements.length + expenses.length > 0;
  if (!hasActivity) {
    if (!quiet) {
      r.lines.push("  (no documents, no ledger — nothing to check)");
    }
    r.print();
    return;
  }

  // ---- 1. every entry balances --------------------------------------------
  {
    const bad = [];
    for (const e of entries) {
      let debits = 0;
      let credits = 0;
      let nonZero = 0;
      let both = false;
      let negative = false;
      for (const l of e.lines) {
        if (l.debitCents < 0 || l.creditCents < 0) negative = true;
        if (l.debitCents > 0 && l.creditCents > 0) both = true;
        if (l.debitCents !== 0 || l.creditCents !== 0) nonZero++;
        debits += l.debitCents;
        credits += l.creditCents;
      }
      if (debits !== credits || nonZero === 0 || both || negative) {
        bad.push(
          `${e.number} (${e.id}): debits ${debits} credits ${credits}${nonZero === 0 ? ", no non-zero line" : ""}${
            both ? ", a line is both debit and credit" : ""
          }${negative ? ", negative amount" : ""}`,
        );
      }
    }
    r.check("Every journal entry balances, with ≥1 non-zero line and no line both sides", bad);
  }

  // ---- 2. trial balance ---------------------------------------------------
  {
    const debits = sumBy(entries, (e) => sumBy(e.lines, (l) => l.debitCents));
    const credits = sumBy(entries, (e) => sumBy(e.lines, (l) => l.creditCents));
    r.check(
      "Company trial balance balances",
      debits === credits ? [] : [`debits ${debits} vs credits ${credits} (out by ${debits - credits})`],
    );
  }

  // ---- entry lookup by (refType, refId, sourceKind) -----------------------
  const entryIndex = new Map();
  for (const e of entries) {
    const k = `${e.refType}|${e.refId}|${e.sourceKind}`;
    if (!entryIndex.has(k)) entryIndex.set(k, []);
    entryIndex.get(k).push(e);
  }
  const entryFor = (refType, refId, kind) => entryIndex.get(`${refType}|${refId}|${kind}`)?.[0];
  const lineAmount = (entry, accountId, side) =>
    sumBy(
      entry.lines.filter((l) => l.accountId === accountId),
      (l) => (side === "debit" ? l.debitCents : l.creditCents),
    );

  // ---- 3 & 4. documents → entries, with amounts -----------------------------
  const credited = groupSum(
    creditNotes.filter((n) => n.status !== "CANCELLED"),
    (n) => n.invoiceId,
    (n) => n.totalCents,
  );

  {
    const missing = [];
    const wrong = [];
    for (const inv of invoices) {
      if (inv.status === "DRAFT" || inv.totalCents === 0) continue;
      const e = entryFor("Invoice", inv.id, "REVENUE");
      if (!e) {
        missing.push(`${inv.number} (${inv.id}) status ${inv.status} total ${inv.totalCents}`);
        continue;
      }
      const ar = lineAmount(e, AR, "debit");
      const vat = lineAmount(e, VAT_OUT, "credit");
      if (ar !== inv.totalCents || vat !== inv.taxCents) {
        wrong.push(`${inv.number}: AR debit ${ar} vs total ${inv.totalCents}; VAT credit ${vat} vs tax ${inv.taxCents}`);
      }
    }
    r.check("Every non-draft invoice with a total has a REVENUE entry", missing);
    r.check("REVENUE entries match their invoice (AR debit = total, VAT credit = tax)", wrong);
  }

  {
    const missing = [];
    const wrong = [];
    for (const p of payments) {
      const e = entryFor("Payment", p.id, "RECEIPT");
      if (!e) {
        missing.push(`${p.number} (${p.id}) ${p.amountCents}`);
        continue;
      }
      const ar = lineAmount(e, AR, "credit");
      if (ar !== p.amountCents) wrong.push(`${p.number}: AR credit ${ar} vs amount ${p.amountCents}`);
    }
    r.check("Every payment has a RECEIPT entry", missing);
    r.check("RECEIPT entries match their payment (AR credit = amount)", wrong);
  }

  {
    const missing = [];
    const wrong = [];
    for (const n of creditNotes) {
      if (n.status === "CANCELLED" || n.totalCents === 0) continue;
      const e = entryFor("CreditNote", n.id, "CREDIT_NOTE");
      if (!e) {
        missing.push(`${n.number} (${n.id}) ${n.totalCents}`);
        continue;
      }
      const ar = lineAmount(e, AR, "credit");
      if (ar !== n.totalCents) wrong.push(`${n.number}: AR credit ${ar} vs total ${n.totalCents}`);
    }
    r.check("Every non-cancelled credit note with a total has a CREDIT_NOTE entry", missing);
    r.check("CREDIT_NOTE entries match their note (AR credit = total)", wrong);
  }

  {
    const missing = [];
    const wrong = [];
    const kindFor = (type) =>
      type === "SALE" || type === "RETURN"
        ? "COGS"
        : type === "ADJUSTMENT" || type === "WRITE_OFF"
          ? "ADJUSTMENT"
          : type === "OPENING"
            ? "OPENING"
            : null; // PURCHASE posts per receipt; TRANSFER_* and REPACK_* post nothing themselves
    for (const m of movements) {
      const kind = kindFor(m.type);
      if (!kind) continue;
      const value = Math.abs(m.quantity) * m.unitCostCents;
      if (value === 0) continue;
      const e = entryFor("StockMovement", m.id, kind);
      if (!e) {
        missing.push(`${m.type} ${m.id} qty ${m.quantity} @ ${m.unitCostCents}`);
        continue;
      }
      const side = m.quantity > 0 ? "debit" : "credit";
      const inv = lineAmount(e, INVENTORY, side);
      if (inv !== value) wrong.push(`${m.type} ${m.id}: inventory ${side} ${inv} vs value ${value}`);
    }
    r.check("Every valued SALE/RETURN/ADJUSTMENT/WRITE_OFF/OPENING movement has its entry", missing);
    r.check("Stock entries match their movement (inventory moves by qty × cost)", wrong);
  }

  {
    const missing = [];
    const wrong = [];
    for (const g of receipts) {
      if (g.status !== "POSTED") continue;
      const value = sumBy(g.lines, (l) => Math.abs(l.quantity) * l.unitCostCents);
      if (value === 0) continue;
      const e = entryFor("GoodsReceipt", g.id, "PURCHASE");
      if (!e) {
        missing.push(`${g.number} (${g.id}) ${value}`);
        continue;
      }
      const inv = lineAmount(e, INVENTORY, "debit");
      if (inv !== value) wrong.push(`${g.number}: inventory debit ${inv} vs receipt value ${value}`);
    }
    r.check("Every POSTED goods receipt with value has a PURCHASE entry", missing);
    r.check("PURCHASE entries match their receipt", wrong);
  }

  {
    const bad = [];
    const byRef = groupBy(movements.filter((m) => m.refType === "GRN"), (m) => m.refId);
    for (const g of receipts) {
      const list = byRef.get(g.id) ?? [];
      for (const l of g.lines) {
        if (l.locationId && !locationIds.has(l.locationId)) bad.push(`${g.number}: line ${l.id} lands at a location from another company`);
      }
      if (g.status !== "POSTED") {
        if (list.length) bad.push(`${g.number} (${g.status}): has stock movements`);
        continue;
      }
      if (list.some((m) => m.type !== "PURCHASE")) bad.push(`${g.number}: a non-PURCHASE movement references it`);
      // A line lands where it says, else where the receipt says.
      const expected = groupSum(g.lines, (l) => `${l.productId}|${l.locationId ?? g.locationId}`, (l) => Math.abs(l.quantity));
      const actual = groupSum(list, (m) => `${m.productId}|${m.locationId}`, (m) => m.quantity);
      for (const [k, q] of expected) {
        if ((actual.get(k) ?? 0) !== q) bad.push(`${g.number}: ${k} has ${q} on lines, ${actual.get(k) ?? 0} moved`);
      }
      for (const k of actual.keys()) if (!expected.has(k)) bad.push(`${g.number}: movement at ${k} with no line`);
    }
    r.check("Posted receipts put each line's quantity at its own location (line.locationId ?? receipt location)", bad);
  }

  {
    const missing = [];
    const wrong = [];
    for (const x of expenses) {
      if (!["APPROVED", "PAID"].includes(x.status) || x.amountCents === 0) continue;
      const e = entryFor("Expense", x.id, "EXPENSE");
      if (!e) {
        missing.push(`${x.number} (${x.id}) ${x.status} ${x.amountCents}`);
        continue;
      }
      const cash = lineAmount(e, CASH, "credit");
      if (cash !== x.amountCents) wrong.push(`${x.number}: cash credit ${cash} vs amount ${x.amountCents}`);
    }
    r.check("Every APPROVED/PAID expense has an EXPENSE entry", missing);
    r.check("EXPENSE entries match their claim (cash credit = amount)", wrong);
  }

  // ---- 5. no orphaned entries ---------------------------------------------
  {
    const movementIds = new Set(movements.map((m) => m.id));
    const receiptIds = new Set(receipts.map((g) => g.id));
    const expenseIds = new Set(expenses.map((x) => x.id));
    const noteIds = new Set(creditNotes.map((n) => n.id));
    const supplierInvoiceIds = new Set(supplierInvoices.map((s) => s.id));
    const supplierPaymentIds = new Set(supplierPayments.map((p) => p.id));
    const exists = (refType, refId) => {
      switch (refType) {
        case "Invoice":
          return invoiceById.has(refId);
        case "Payment":
          return paymentById.has(refId);
        case "CreditNote":
          return noteIds.has(refId);
        case "StockMovement":
          return movementIds.has(refId);
        case "GoodsReceipt":
          return receiptIds.has(refId);
        case "Expense":
          return expenseIds.has(refId);
        case "SupplierInvoice":
          return supplierInvoiceIds.has(refId);
        case "SupplierPayment":
          return supplierPaymentIds.has(refId);
        // A journal typed by an accountant has no document behind it, by design.
        case "ManualJournal":
          return true;
        default:
          return null;
      }
    };
    const orphans = [];
    const unknownType = [];
    const foreignAccount = [];
    for (const e of entries) {
      const ok = exists(e.refType, e.refId);
      if (ok === null) unknownType.push(`${e.number}: refType ${e.refType}`);
      else if (!ok) orphans.push(`${e.number} (${e.id}) → ${e.refType} ${e.refId}`);
      for (const l of e.lines) {
        const a = accountById.get(l.accountId);
        if (!a) foreignAccount.push(`${e.number}: line ${l.id} → account ${l.accountId} not in this company`);
      }
    }
    r.check("No journal entry points at a document that does not exist", orphans);
    r.check("Every journal entry has a known refType", unknownType);
    r.check("Every journal line posts to one of this company's accounts", foreignAccount);
  }

  // ---- 6. reversal links --------------------------------------------------
  {
    const entryById = new Map(entries.map((e) => [e.id, e]));
    const bad = [];
    for (const e of entries) {
      if (e.reversedById) {
        const rev = entryById.get(e.reversedById);
        if (!rev) bad.push(`${e.number}: reversedById ${e.reversedById} missing`);
        else {
          if (rev.reversalOfId !== e.id) bad.push(`${e.number}: reversal ${rev.number} does not point back`);
          if (rev.sourceKind !== `REVERSAL:${e.sourceKind}`) bad.push(`${e.number}: reversal ${rev.number} sourceKind ${rev.sourceKind}`);
          // Mirror image: every debit a credit and back.
          const mirror = (ls) =>
            ls
              .map((l) => `${l.accountId}:${l.debitCents}:${l.creditCents}`)
              .sort()
              .join(",");
          const flipped = e.lines.map((l) => ({ accountId: l.accountId, debitCents: l.creditCents, creditCents: l.debitCents }));
          if (mirror(flipped) !== mirror(rev.lines)) bad.push(`${e.number}: reversal ${rev.number} is not its mirror`);
        }
      }
      if (e.reversalOfId) {
        const orig = entryById.get(e.reversalOfId);
        if (!orig) bad.push(`${e.number}: reversalOfId ${e.reversalOfId} missing`);
        else if (orig.reversedById !== e.id) bad.push(`${e.number}: original ${orig.number} does not record this reversal`);
      }
    }
    r.check("Reversal links are consistent both ways and mirror their original", bad);
  }

  // ---- 7. closed periods --------------------------------------------------
  {
    const closed = new Map(
      periods.filter((p) => p.closedAt).map((p) => [`${p.year}-${p.month}`, p.closedAt]),
    );
    const bad = [];
    if (closed.size > 0) {
      for (const e of entries) {
        const k = `${e.date.getFullYear()}-${e.date.getMonth() + 1}`;
        const closedAt = closed.get(k);
        if (closedAt && e.createdAt > closedAt) {
          bad.push(`${e.number} dated ${e.date.toISOString().slice(0, 10)} posted ${e.createdAt.toISOString()} after close ${closedAt.toISOString()}`);
        }
      }
    }
    r.check("No entry was posted into a period after that period was closed", bad);
  }

  // ---- 7b. supplier bills and payments ---------------------------------------
  {
    const paidByBill = groupSum(supplierPayments, (p) => p.supplierInvoiceId, (p) => p.amountCents);
    const bad = [];
    for (const bill of supplierInvoices) {
      const paid = paidByBill.get(bill.id) ?? 0;
      if (bill.paidCents !== paid) bad.push(`${bill.number}: says ${bill.paidCents} paid, payments total ${paid}`);
    }
    r.check("Every supplier bill's paid amount equals its payments", bad);

    const open = supplierInvoices.filter((b) => b.status !== "VOID");
    const owed = groupSum(open, (b) => b.supplierId, (b) => b.totalCents - b.paidCents);
    const wrong = [];
    for (const s of suppliers) {
      const expected = owed.get(s.id) ?? 0;
      if (s.balanceCents !== expected) wrong.push(`${s.code} ${s.name}: stored ${s.balanceCents}, bills say ${expected}`);
    }
    r.check("Every supplier's balance equals its unpaid bills", wrong);
  }

  // ---- 8. customer balance invariant ----------------------------------------
  {
    const invoiced = groupSum(invoices.filter((i) => i.status !== "DRAFT"), (i) => i.customerId, (i) => i.totalCents);
    const paid = groupSum(payments, (p) => p.customerId, (p) => p.amountCents);
    const creditedByCustomer = groupSum(
      creditNotes.filter((n) => n.status !== "CANCELLED"),
      (n) => n.customerId,
      (n) => n.totalCents,
    );
    const bad = [];
    for (const c of customers) {
      const expected = (invoiced.get(c.id) ?? 0) - (paid.get(c.id) ?? 0) - (creditedByCustomer.get(c.id) ?? 0);
      if (c.balanceCents !== expected) {
        bad.push(`${c.code} ${c.name} (${c.id}): stored ${c.balanceCents}, documents say ${expected}`);
      }
    }
    r.check(
      "Customer balance = Σ non-draft invoices − Σ payments − Σ non-cancelled credit notes",
      bad,
    );
  }

  // ---- 9. invoice paidCents = Σ allocations, within bounds -----------------
  {
    const allocated = groupSum(allocations, (a) => a.invoiceId, (a) => a.amountCents);
    const bad = [];
    const bounds = [];
    for (const inv of invoices) {
      const sum = allocated.get(inv.id) ?? 0;
      if (inv.paidCents !== sum) bad.push(`${inv.number} (${inv.id}): paidCents ${inv.paidCents} vs allocations ${sum}`);
      if (inv.paidCents < 0 || inv.paidCents > inv.totalCents) bounds.push(`${inv.number}: paid ${inv.paidCents} of total ${inv.totalCents}`);
    }
    r.check("Invoice paidCents = Σ its allocations", bad);
    r.check("0 ≤ paidCents ≤ totalCents on every invoice", bounds);
  }

  // ---- 10. allocations per payment ----------------------------------------
  {
    const byPayment = groupBy(allocations, (a) => a.paymentId);
    const over = [];
    const mismatched = [];
    for (const p of payments) {
      const list = byPayment.get(p.id) ?? [];
      const sum = sumBy(list, (a) => a.amountCents);
      if (sum > p.amountCents) over.push(`${p.number}: allocated ${sum} of ${p.amountCents}`);
      for (const a of list) {
        if (!a.invoice) {
          mismatched.push(`${p.number}: allocation ${a.id} → missing invoice ${a.invoiceId}`);
          continue;
        }
        if (a.invoice.companyId !== p.companyId) mismatched.push(`${p.number}: allocation to another company's invoice ${a.invoiceId}`);
        if (a.invoice.customerId !== p.customerId) mismatched.push(`${p.number}: allocation to another customer's invoice ${a.invoiceId}`);
        if (a.invoice.status === "DRAFT") mismatched.push(`${p.number}: allocation to DRAFT invoice ${a.invoiceId}`);
        if (a.amountCents <= 0) mismatched.push(`${p.number}: non-positive allocation ${a.id}`);
      }
    }
    r.check("Allocations per payment total ≤ the payment", over);
    r.check("Every allocation is to a non-draft invoice of the same customer and company", mismatched);
  }

  // ---- 11. invoice status matches derivation --------------------------------
  {
    const creditLinesByInvoice = new Map();
    for (const n of creditNotes) {
      if (n.status === "CANCELLED") continue;
      for (const l of n.lines) {
        if (!l.invoiceLineId) continue;
        if (!creditLinesByInvoice.has(n.invoiceId)) creditLinesByInvoice.set(n.invoiceId, new Map());
        const m = creditLinesByInvoice.get(n.invoiceId);
        m.set(l.invoiceLineId, (m.get(l.invoiceLineId) ?? 0) + l.quantity);
      }
    }
    const bad = [];
    const stale = [];
    const cancelled = [];
    for (const inv of invoices) {
      if (inv.status === "CANCELLED") {
        // Cancelled by a credit note for the whole of every line.
        const creditedQty = creditLinesByInvoice.get(inv.id);
        if (creditedQty) {
          const uncovered = inv.lines.filter((l) => (creditedQty.get(l.id) ?? 0) < l.quantity);
          if (uncovered.length) cancelled.push(`${inv.number}: cancelled but ${uncovered.length} line(s) not fully credited`);
        }
        continue;
      }
      const derived = deriveInvoiceStatus({
        totalCents: inv.totalCents,
        paidCents: inv.paidCents,
        creditedCents: credited.get(inv.id) ?? 0,
        dueDate: inv.dueDate,
        current: inv.status,
        now,
      });
      if (derived === inv.status) continue;
      // OVERDUE is swept lazily when a list is rendered, so an invoice whose
      // due date has passed since may still read ISSUED/PARTIALLY_PAID — and
      // one swept to OVERDUE may read so while derivation says the same minus
      // the clock. Time-only differences are warnings; money differences fail.
      const timeless = deriveInvoiceStatus({
        totalCents: inv.totalCents,
        paidCents: inv.paidCents,
        creditedCents: credited.get(inv.id) ?? 0,
        dueDate: inv.dueDate,
        current: inv.status,
        now: new Date(0),
      });
      const storedTimeless = inv.status === "OVERDUE" ? (inv.paidCents > 0 ? "PARTIALLY_PAID" : "ISSUED") : inv.status;
      if (timeless === storedTimeless) stale.push(`${inv.number}: stored ${inv.status}, derived ${derived} (overdue sweep pending)`);
      else bad.push(`${inv.number} (${inv.id}): stored ${inv.status}, derived ${derived} (total ${inv.totalCents} paid ${inv.paidCents} credited ${credited.get(inv.id) ?? 0})`);
    }
    r.check("Invoice status matches its derivation from paid, credited and due date", bad);
    r.check("Invoice overdue status is current", stale, { warn: true });
    r.check("CANCELLED invoices are fully credited on every line", cancelled);
  }

  // ---- 12. invoice totals and lines -----------------------------------------
  {
    const totals = [];
    const lineMaths = [];
    for (const inv of invoices) {
      let subtotal = 0;
      let discount = 0;
      let tax = 0;
      let total = 0;
      for (const l of inv.lines) {
        const computed = computeLine(l);
        if (computed.lineTotalCents !== l.lineTotalCents) {
          lineMaths.push(`${inv.number} line ${l.id}: stored ${l.lineTotalCents}, computeLine ${computed.lineTotalCents}`);
        }
        const charged = chargedLine(l);
        subtotal += charged.grossCents;
        discount += charged.discountCents;
        tax += charged.taxCents;
        total += charged.lineTotalCents;
      }
      if (inv.lines.length === 0 && inv.status !== "DRAFT") totals.push(`${inv.number}: no lines`);
      if (inv.totalCents !== total || inv.taxCents !== tax || inv.subtotalCents !== subtotal || inv.discountCents !== discount) {
        totals.push(
          `${inv.number} (${inv.id}): stored sub ${inv.subtotalCents} disc ${inv.discountCents} tax ${inv.taxCents} total ${inv.totalCents}; lines say ${subtotal} ${discount} ${tax} ${total}`,
        );
      }
    }
    r.check("Invoice totals add up from their lines", totals);
    r.check("Invoice lines agree with computeLine", lineMaths, { warn: true, detail: "Stored before computeLine was the only engine; chargedLine handles them." });
  }

  // ---- 13. credit notes do not over-credit --------------------------------------
  {
    const bad = [];
    const noteTotals = [];
    const linesById = new Map();
    for (const inv of invoices) for (const l of inv.lines) linesById.set(l.id, { ...l, invoiceNumber: inv.number });
    const qtyByLine = new Map();
    const valueByLine = new Map();
    for (const n of creditNotes) {
      const total = sumBy(n.lines, (l) => l.lineTotalCents);
      if (n.totalCents !== total || n.subtotalCents !== n.totalCents - n.taxCents) {
        noteTotals.push(`${n.number}: total ${n.totalCents} tax ${n.taxCents} subtotal ${n.subtotalCents}; lines ${total}`);
      }
      const inv = invoiceById.get(n.invoiceId);
      if (!inv) bad.push(`${n.number}: invoice ${n.invoiceId} missing`);
      else if (inv.customerId !== n.customerId) bad.push(`${n.number}: customer differs from invoice ${inv.number}`);
      if (n.status === "CANCELLED") continue;
      for (const l of n.lines) {
        if (!l.invoiceLineId) {
          bad.push(`${n.number}: line ${l.id} has no invoice line`);
          continue;
        }
        qtyByLine.set(l.invoiceLineId, (qtyByLine.get(l.invoiceLineId) ?? 0) + l.quantity);
        valueByLine.set(l.invoiceLineId, (valueByLine.get(l.invoiceLineId) ?? 0) + l.lineTotalCents);
      }
    }
    for (const [lineId, qty] of qtyByLine) {
      const line = linesById.get(lineId);
      if (!line) {
        bad.push(`credit against missing invoice line ${lineId}`);
        continue;
      }
      if (qty > line.quantity) bad.push(`${line.invoiceNumber} line ${lineId}: credited ${qty} of ${line.quantity}`);
      const value = valueByLine.get(lineId) ?? 0;
      if (value > line.lineTotalCents) bad.push(`${line.invoiceNumber} line ${lineId}: credited ${value} of ${line.lineTotalCents} charged`);
      if (qty === line.quantity && value !== line.lineTotalCents) {
        bad.push(`${line.invoiceNumber} line ${lineId}: fully returned but credited ${value} of ${line.lineTotalCents}`);
      }
    }
    r.check("Credit notes never over-credit a line in quantity or value", bad);
    r.check("Credit note totals add up from their lines", noteTotals);
  }

  // ---- 14 & 15. stock items = Σ movements; running balances chain ----------------
  {
    const key = (m) => `${m.productId}|${m.locationId}`;
    const byPair = groupBy(movements, key);
    const itemByPair = new Map(stockItems.map((s) => [key(s), s]));
    const mismatch = [];
    const noItem = [];
    const chain = [];
    for (const [pair, list] of byPair) {
      const sum = sumBy(list, (m) => m.quantity);
      const item = itemByPair.get(pair);
      if (!item) noItem.push(`${pair}: ${list.length} movement(s) sum ${sum}, no StockItem`);
      else if (item.quantity !== sum) mismatch.push(`${pair} (item ${item.id}): quantity ${item.quantity} vs Σ movements ${sum}`);
      // Within a timestamp tie, the implied opening balance orders them.
      const ordered = [...list].sort((a, b) => {
        const t = a.createdAt.getTime() - b.createdAt.getTime();
        return t !== 0 ? t : (a.balanceAfter - a.quantity) - (b.balanceAfter - b.quantity);
      });
      let running = 0;
      for (const m of ordered) {
        running += m.quantity;
        if (m.balanceAfter !== running) {
          chain.push(`${pair}: movement ${m.id} (${m.type} ${m.quantity}) balanceAfter ${m.balanceAfter}, expected ${running}`);
          running = m.balanceAfter; // report once per break, then follow the stored figure
        }
      }
    }
    for (const s of stockItems) {
      if (!byPair.has(key(s)) && s.quantity !== 0) mismatch.push(`${key(s)} (item ${s.id}): quantity ${s.quantity} with no movements`);
    }
    r.check("StockItem.quantity = Σ movements for its (product, location)", mismatch);
    r.check("Every (product, location) with movements has a StockItem", noItem);
    r.check("Running balances chain movement to movement", chain);
    r.check(
      "No negative stock",
      stockItems.filter((s) => s.quantity < 0).map((s) => `${s.productId}|${s.locationId}: ${s.quantity}`),
      { warn: true, detail: "Permitted for van sales ahead of sync; listed for the exceptions report." },
    );
  }

  // ---- 16. transfers: counters, movements and status agree ----------------------
  {
    const bad = [];
    const byRef = groupBy(movements.filter((m) => m.refType === "TRANSFER"), (m) => m.refId);
    // Mirrors deriveTransferStatus in src/server/inventory.ts.
    const derive = (lines, shortClosed) => {
      if (shortClosed) return "RECEIVED";
      const quantity = sumBy(lines, (l) => l.quantity);
      const dispatched = sumBy(lines, (l) => l.dispatched);
      const received = sumBy(lines, (l) => l.received);
      if (dispatched === 0) return "DRAFT";
      if (received >= quantity) return "RECEIVED";
      if (received > 0) return "PARTIALLY_RECEIVED";
      if (dispatched >= quantity) return "IN_TRANSIT";
      return "PARTIALLY_DISPATCHED";
    };
    const qty = (m) => m.quantity;
    for (const t of transfers) {
      const list = byRef.get(t.id) ?? [];
      if (!locationIds.has(t.fromLocationId) || !locationIds.has(t.toLocationId)) {
        bad.push(`${t.number}: a location belongs to another company`);
      }
      if (t.fromLocationId === t.toLocationId) bad.push(`${t.number}: source and destination are the same location`);
      const onTransfer = new Set(t.lines.map((l) => l.productId));
      for (const l of t.lines) {
        if (!(0 <= l.received && l.received <= l.dispatched && l.dispatched <= l.quantity)) {
          bad.push(`${t.number}: line ${l.id} breaks 0 <= received ${l.received} <= dispatched ${l.dispatched} <= quantity ${l.quantity}`);
        }
        const at = (type, locationId) =>
          sumBy(list.filter((m) => m.type === type && m.productId === l.productId && m.locationId === locationId), qty);
        const out = at("TRANSFER_OUT", t.fromLocationId);
        const inn = at("TRANSFER_IN", t.toLocationId);
        if (out !== -l.dispatched) bad.push(`${t.number}: OUT at source for ${l.productId} is ${out}, dispatched is ${l.dispatched}`);
        if (inn !== l.received) bad.push(`${t.number}: IN at destination for ${l.productId} is ${inn}, received is ${l.received}`);
        // Short close: what never arrived comes back to the source on paper and is written off there.
        const lost = t.shortClosedAt ? l.dispatched - l.received : 0;
        const back = at("TRANSFER_IN", t.fromLocationId);
        const writtenOff = at("WRITE_OFF", t.fromLocationId);
        if (back !== lost) bad.push(`${t.number}: IN back at source for ${l.productId} is ${back}, short-closed loss is ${lost}`);
        if (writtenOff !== -lost) bad.push(`${t.number}: WRITE_OFF at source for ${l.productId} is ${writtenOff}, short-closed loss is ${lost}`);
      }
      for (const m of list) {
        if (!onTransfer.has(m.productId)) bad.push(`${t.number}: movement ${m.id} is for a product not on the transfer`);
        if (m.type === "TRANSFER_OUT" && m.locationId !== t.fromLocationId) bad.push(`${t.number}: TRANSFER_OUT ${m.id} not at the source`);
        if (m.type === "TRANSFER_IN" && m.locationId !== t.toLocationId && m.locationId !== t.fromLocationId) bad.push(`${t.number}: TRANSFER_IN ${m.id} at neither end`);
        if (m.type === "WRITE_OFF" && (m.locationId !== t.fromLocationId || !t.shortClosedAt)) bad.push(`${t.number}: WRITE_OFF ${m.id} outside a short close at the source`);
        if (!["TRANSFER_OUT", "TRANSFER_IN", "WRITE_OFF"].includes(m.type)) bad.push(`${t.number}: unexpected ${m.type} movement ${m.id}`);
      }
      const expected = t.status === "CANCELLED" ? "CANCELLED" : derive(t.lines, Boolean(t.shortClosedAt));
      if (t.status === "CANCELLED" && t.lines.some((l) => l.dispatched || l.received)) bad.push(`${t.number}: CANCELLED but something moved`);
      if (t.status !== expected) bad.push(`${t.number}: status ${t.status}, counters imply ${expected}`);
      if (!["DRAFT", "CANCELLED"].includes(t.status) && !t.dispatchedAt) bad.push(`${t.number}: ${t.status} without dispatchedAt`);
      if (t.status === "RECEIVED" && !t.receivedAt) bad.push(`${t.number}: RECEIVED without receivedAt`);
      if (t.shortClosedAt && t.status !== "RECEIVED") bad.push(`${t.number}: closed short but ${t.status}`);
    }
    r.check("Transfer counters, movements and status agree (received <= dispatched <= quantity; OUT = -dispatched; IN = received)", bad);
  }

  // ---- 16b. repacks: value carried across, rounding written off -----------------
  {
    const bad = [];
    const stray = movements.filter((m) => (m.type === "REPACK_OUT" || m.type === "REPACK_IN") && m.refType !== "REPACK");
    for (const m of stray) bad.push(`${m.type} ${m.id} without a REPACK reference`);
    const byRef = groupBy(movements.filter((m) => m.refType === "REPACK"), (m) => m.refId);
    for (const [refId, list] of byRef) {
      const outs = list.filter((m) => m.type === "REPACK_OUT");
      const ins = list.filter((m) => m.type === "REPACK_IN");
      if (outs.length !== 1 || ins.length !== 1 || list.length !== 2) {
        bad.push(`${refId}: ${outs.length} OUT / ${ins.length} IN legs (${list.length} movements)`);
        continue;
      }
      const [out] = outs;
      const [inn] = ins;
      if (out.locationId !== inn.locationId) bad.push(`${refId}: legs at different locations`);
      if (out.productId === inn.productId) bad.push(`${refId}: both legs are the same product`);
      if (!(out.quantity < 0 && inn.quantity > 0)) bad.push(`${refId}: OUT ${out.quantity} / IN ${inn.quantity} have the wrong signs`);
      const net = out.quantity * out.unitCostCents + inn.quantity * inn.unitCostCents;
      const rounding = entryFor("StockMovement", inn.id, "REPACK_ROUNDING");
      const written = rounding ? lineAmount(rounding, INVENTORY, "credit") : 0;
      if (net + written !== 0) bad.push(`${refId}: legs net ${net}, REPACK_ROUNDING writes off ${written}`);
      if (written >= inn.quantity && written > 0) bad.push(`${refId}: rounding ${written} is not smaller than the ${inn.quantity} units produced`);
    }
    r.check("Repack legs carry value across; sum of qty x cost per REPACK is 0 or equals its rounding entry", bad);
  }

  // ---- 17. inventory account = valued movements + posted receipts ------------------
  {
    // REPACK legs are included: OUT leaves at the source cost and IN arrives at
    // the floored unit cost, so the pair nets to exactly the rounding cents the
    // REPACK_ROUNDING entry books against inventory.
    const valuedTypes = new Set(["SALE", "RETURN", "ADJUSTMENT", "WRITE_OFF", "OPENING", "REPACK_OUT", "REPACK_IN"]);
    const movementValue = sumBy(
      movements.filter((m) => valuedTypes.has(m.type)),
      (m) => m.quantity * m.unitCostCents,
    );
    const receiptValue = sumBy(
      receipts.filter((g) => g.status === "POSTED"),
      (g) => sumBy(g.lines, (l) => Math.abs(l.quantity) * l.unitCostCents),
    );
    const expected = movementValue + receiptValue;
    const ledger = INVENTORY
      ? sumBy(entries, (e) => sumBy(e.lines.filter((l) => l.accountId === INVENTORY), (l) => l.debitCents - l.creditCents))
      : 0;
    r.check(
      "Inventory account = Σ qty × cost over valued movements + posted goods receipts",
      ledger === expected ? [] : [`ledger ${ledger} vs documents ${expected} (out by ${ledger - expected})`],
    );
  }

  // ---- 18. document numbers and counters -------------------------------------------
  {
    const dupes = [];
    const behind = [];
    const sets = {
      INVOICE: invoices.map((x) => x.number),
      ORDER: orders.map((x) => x.number),
      PAYMENT: payments.map((x) => x.number),
      EXPENSE: expenses.map((x) => x.number),
      CREDIT_NOTE: creditNotes.map((x) => x.number),
      JOURNAL: entries.map((x) => x.number),
      GRN: receipts.map((x) => x.number),
      TRANSFER: transfers.map((x) => x.number),
      SUPPLIER_INVOICE: supplierInvoices.map((x) => x.number),
      CUSTOMER: customers.map((x) => x.code),
    };
    const counterByType = new Map(counters.map((c) => [c.docType, c]));
    for (const [docType, numbers] of Object.entries(sets)) {
      const seen = new Set();
      for (const n of numbers) {
        if (seen.has(n)) dupes.push(`${docType} ${n}`);
        seen.add(n);
      }
      const counter = counterByType.get(docType);
      if (!counter) {
        if (numbers.length) behind.push(`${docType}: ${numbers.length} document(s) but no counter`);
        continue;
      }
      const re = new RegExp(`^${counter.prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-(\\d+)$`);
      let max = 0;
      for (const n of numbers) {
        const m = re.exec(n);
        if (m) max = Math.max(max, Number(m[1]));
      }
      if (counter.nextValue <= max) behind.push(`${docType}: counter next ${counter.nextValue}, highest issued ${counter.prefix}-${max}`);
    }
    r.check("No duplicate document numbers", dupes);
    r.check("Every document counter is ahead of the highest number issued", behind);
  }

  // ---- 19. tenant consistency of child rows ----------------------------------------
  {
    const bad = [];
    for (const inv of invoices) {
      const c = customerById.get(inv.customerId);
      if (!c) bad.push(`Invoice ${inv.number}: customer ${inv.customerId} not in company`);
      if (inv.locationId && !locationIds.has(inv.locationId)) bad.push(`Invoice ${inv.number}: location ${inv.locationId} not in company`);
      for (const l of inv.lines) if (!productIds.has(l.productId)) bad.push(`Invoice ${inv.number}: product ${l.productId} not in company`);
    }
    for (const p of payments) if (!customerById.has(p.customerId)) bad.push(`Payment ${p.number}: customer ${p.customerId} not in company`);
    for (const o of orders) if (!customerById.has(o.customerId)) bad.push(`Order ${o.number}: customer ${o.customerId} not in company`);
    for (const n of creditNotes) {
      if (!customerById.has(n.customerId)) bad.push(`CreditNote ${n.number}: customer ${n.customerId} not in company`);
      if (!invoiceById.has(n.invoiceId)) bad.push(`CreditNote ${n.number}: invoice ${n.invoiceId} not in company`);
    }
    for (const m of movements) {
      if (!productIds.has(m.productId)) bad.push(`Movement ${m.id}: product ${m.productId} not in company`);
      if (!locationIds.has(m.locationId)) bad.push(`Movement ${m.id}: location ${m.locationId} not in company`);
    }
    for (const s of stockItems) {
      if (!productIds.has(s.productId)) bad.push(`StockItem ${s.id}: product ${s.productId} not in company`);
      if (!locationIds.has(s.locationId)) bad.push(`StockItem ${s.id}: location ${s.locationId} not in company`);
    }
    for (const x of expenses) if (x.category && x.category.companyId !== companyId) bad.push(`Expense ${x.number}: category from another company`);
    for (const i of intents) if (!customerById.has(i.customerId)) bad.push(`PaymentIntent ${i.id}: customer ${i.customerId} not in company`);
    r.check("Child rows belong to the same company as their parent", bad);
  }

  // ---- 20. payment intents ----------------------------------------------------------
  {
    const bad = [];
    const partial = [];
    const paymentsByIntentUuid = new Map(
      payments.filter((p) => p.clientUuid?.startsWith("intent:")).map((p) => [p.clientUuid, p]),
    );
    for (const i of intents) {
      const linked = i.paymentId ? paymentById.get(i.paymentId) : null;
      const byUuid = paymentsByIntentUuid.get(`intent:${i.id}`);
      // REVERSED is a SUCCEEDED intent the provider later took back; the
      // payment stays on the books until a person decides what to do.
      if (i.status === "SUCCEEDED" || i.status === "REVERSED") {
        if (!i.paymentId) bad.push(`${i.id}: ${i.status} without paymentId`);
        else if (!linked) bad.push(`${i.id}: ${i.status}, payment ${i.paymentId} missing`);
        else {
          if (linked.customerId !== i.customerId) bad.push(`${i.id}: payment ${linked.number} is another customer's`);
          if (byUuid && byUuid.id !== linked.id) bad.push(`${i.id}: two payments for one intent (${linked.number}, ${byUuid.number})`);
          if (linked.amountCents !== i.amountCents) {
            (linked.note?.startsWith("Requested") ? partial : bad).push(
              `${i.id}: intent ${i.amountCents}, payment ${linked.number} ${linked.amountCents}`,
            );
          }
        }
      } else {
        if (i.paymentId) bad.push(`${i.id}: ${i.status} but linked to payment ${i.paymentId}`);
        if (byUuid) bad.push(`${i.id}: ${i.status} but payment ${byUuid.number} was booked for it`);
      }
    }
    r.check("SUCCEEDED intents have exactly one matching payment; live intents none", bad);
    r.check("Gateway settled a different amount than requested", partial, { warn: true });

    // Gateway-settled methods are the ones settleIntent books; a shared
    // reference there is the same provider receipt booked twice. A manually
    // keyed M-Pesa code or cheque number repeated is operator input and a
    // warning — the smoke tests deliberately reuse one.
    const settled = new Set(["MPESA_STK", "PAYSTACK", "KCB_BUNI"]);
    const manual = new Set(["MPESA", "BANK", "CHEQUE"]);
    const seen = new Map();
    const shared = [];
    const sharedManual = [];
    for (const p of payments) {
      if (!p.reference || !(settled.has(p.method) || manual.has(p.method))) continue;
      const k = `${p.customerId}|${p.reference}`;
      if (seen.has(k)) (settled.has(p.method) ? shared : sharedManual).push(`${seen.get(k)} and ${p.number} share reference ${p.reference}`);
      else seen.set(k, p.number);
    }
    r.check("No two gateway-settled payments share (customer, reference)", shared);
    r.check("Manually keyed payment references repeated for a customer", sharedManual, { warn: true });
  }

  r.print();
}

// ---- cross-company: clientUuids and idempotency keys -----------------------------
async function checkGlobal() {
  const r = new Report("Across companies");

  // Each table enforces its own unique clientUuid; verify anyway, cheaply.
  const dupes = [];
  for (const [name, rows] of Object.entries({
    SalesOrder: await db.salesOrder.findMany({ where: { clientUuid: { not: null } }, select: { clientUuid: true } }),
    Invoice: await db.invoice.findMany({ where: { clientUuid: { not: null } }, select: { clientUuid: true } }),
    Payment: await db.payment.findMany({ where: { clientUuid: { not: null } }, select: { clientUuid: true } }),
    Expense: await db.expense.findMany({ where: { clientUuid: { not: null } }, select: { clientUuid: true } }),
    CreditNote: await db.creditNote.findMany({ where: { clientUuid: { not: null } }, select: { clientUuid: true } }),
    PaymentIntent: await db.paymentIntent.findMany({ where: { clientUuid: { not: null } }, select: { clientUuid: true } }),
  })) {
    const seen = new Set();
    for (const row of rows) {
      if (seen.has(row.clientUuid)) dupes.push(`${name} ${row.clientUuid}`);
      seen.add(row.clientUuid);
    }
  }
  r.check("No duplicate clientUuids", dupes);

  // Every idempotency key that names an entity resolves to a row in the key
  // owner's company. A key resolving across tenants would replay another
  // company's record to a rep.
  const keys = await db.idempotencyKey.findMany();
  const users = new Map(
    (await db.user.findMany({ select: { id: true, companyId: true } })).map((u) => [u.id, u]),
  );
  const tableFor = (entityType) => {
    const t = entityType.toLowerCase();
    if (t.includes("order")) return "salesOrder";
    if (t.includes("invoice")) return "invoice";
    if (t.includes("payment")) return "payment";
    if (t.includes("expense")) return "expense";
    if (t.includes("customeractivity") || t.includes("activity")) return "customerActivity";
    if (t.includes("customer")) return "customer";
    if (t.includes("visit")) return "visit";
    return null;
  };
  const crossTenant = [];
  const missing = [];
  for (const k of keys) {
    if (!k.entityId || !k.entityType) continue;
    const table = tableFor(k.entityType);
    if (!table) continue;
    const row = await db[table].findUnique({ where: { id: k.entityId }, select: { companyId: true } }).catch(() => null);
    if (!row) {
      missing.push(`${k.key} (${k.endpoint}) → ${table} ${k.entityId}`);
      continue;
    }
    const ownerCompany = users.get(k.userId)?.companyId;
    if (ownerCompany && row.companyId !== ownerCompany) {
      crossTenant.push(`${k.key} (${k.endpoint}) → ${table} ${k.entityId} in another company`);
    }
  }
  r.check("Idempotency keys resolve to rows in the key owner's company", crossTenant);
  r.check("Idempotency keys resolve to rows that still exist", missing, { warn: true });

  r.print();
}

async function main() {
  const companies = await db.company.findMany({
    where: onlySlug ? { slug: onlySlug } : {},
    select: { id: true, name: true, slug: true },
    orderBy: { name: "asc" },
  });
  if (companies.length === 0) {
    console.error("No companies matched.");
    process.exitCode = 1;
    return;
  }

  console.log(`Consistency check — ${companies.length} compan${companies.length === 1 ? "y" : "ies"}`);
  for (const c of companies) await checkCompany(c);
  if (!onlySlug) await checkGlobal();

  console.log(
    totalFailures === 0
      ? `\nAll checks passed${totalWarnings ? ` (${totalWarnings} warning(s))` : ""}.`
      : `\n${totalFailures} failing check(s)${totalWarnings ? `, ${totalWarnings} warning(s)` : ""}.`,
  );
  if (totalFailures > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error("Consistency check could not run:", error);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
