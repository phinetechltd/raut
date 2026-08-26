import "server-only";

import type { Prisma } from "@prisma/client";

import { db } from "@/lib/db";
import { nextNumber } from "@/lib/numbering";

/**
 * Double-entry bookkeeping.
 *
 * Three rules are enforced here rather than trusted to callers, because every
 * one of them is silently violable and none is recoverable after the fact:
 *
 *   1. **Debits equal credits, checked before anything is written.** An
 *      unbalanced entry does not become obvious until someone runs a trial
 *      balance weeks later and cannot find the difference.
 *   2. **Posting is idempotent** on (company, refType, refId, sourceKind). A
 *      retried sync, a duplicated gateway callback or a re-run backfill must
 *      not double-count revenue.
 *   3. **Nothing is ever edited or deleted.** A correction is a reversing
 *      entry. An audit trail you can rewrite is not an audit trail.
 *
 * Amounts are integer cents throughout, as everywhere else in the platform.
 */

export type AccountType = "ASSET" | "LIABILITY" | "EQUITY" | "INCOME" | "EXPENSE";

/**
 * Accounts the posting rules look up by role rather than by code, so a company
 * can rename or renumber its chart without breaking the machinery.
 */
export type SystemAccount =
  | "CASH"
  | "BANK"
  | "GATEWAY_CLEARING"
  | "ACCOUNTS_RECEIVABLE"
  | "INVENTORY"
  | "ACCOUNTS_PAYABLE"
  | "VAT_OUTPUT"
  | "VAT_INPUT"
  | "GRNI"
  | "OWNERS_EQUITY"
  | "RETAINED_EARNINGS"
  | "SALES"
  | "SALES_RETURNS"
  | "COGS"
  | "STOCK_ADJUSTMENT"
  | "GENERAL_EXPENSE";

interface Seed {
  code: string;
  name: string;
  type: AccountType;
  systemKey?: SystemAccount;
}

/** The chart every new company starts with. Kenyan trading business. */
export const DEFAULT_CHART: Seed[] = [
  { code: "1000", name: "Cash", type: "ASSET", systemKey: "CASH" },
  { code: "1010", name: "Bank", type: "ASSET", systemKey: "BANK" },
  { code: "1050", name: "Payment gateway clearing", type: "ASSET", systemKey: "GATEWAY_CLEARING" },
  { code: "1200", name: "Accounts receivable", type: "ASSET", systemKey: "ACCOUNTS_RECEIVABLE" },
  { code: "1300", name: "Inventory", type: "ASSET", systemKey: "INVENTORY" },

  { code: "2000", name: "Accounts payable", type: "LIABILITY", systemKey: "ACCOUNTS_PAYABLE" },
  { code: "2100", name: "VAT payable", type: "LIABILITY", systemKey: "VAT_OUTPUT" },
  { code: "2110", name: "VAT recoverable", type: "ASSET", systemKey: "VAT_INPUT" },
  { code: "2200", name: "Goods received not invoiced", type: "LIABILITY", systemKey: "GRNI" },

  { code: "3000", name: "Owner's equity", type: "EQUITY", systemKey: "OWNERS_EQUITY" },
  { code: "3900", name: "Retained earnings", type: "EQUITY", systemKey: "RETAINED_EARNINGS" },

  { code: "4000", name: "Sales", type: "INCOME", systemKey: "SALES" },
  { code: "4100", name: "Sales returns", type: "INCOME", systemKey: "SALES_RETURNS" },

  { code: "5000", name: "Cost of goods sold", type: "EXPENSE", systemKey: "COGS" },
  { code: "5900", name: "Stock adjustments", type: "EXPENSE", systemKey: "STOCK_ADJUSTMENT" },

  { code: "6000", name: "General expenses", type: "EXPENSE", systemKey: "GENERAL_EXPENSE" },
];

type Tx = Prisma.TransactionClient;

/** Creates any missing accounts. Safe to re-run; never touches existing ones. */
export async function ensureChartOfAccounts(companyId: string, tx: Tx | typeof db = db) {
  const existing = await tx.account.findMany({
    where: { companyId },
    select: { code: true },
  });
  const have = new Set(existing.map((a) => a.code));

  const missing = DEFAULT_CHART.filter((a) => !have.has(a.code));
  if (missing.length === 0) return 0;

  for (const a of missing) {
    await tx.account.create({
      data: {
        companyId,
        code: a.code,
        name: a.name,
        type: a.type,
        systemKey: a.systemKey ?? null,
      },
    });
  }
  return missing.length;
}

/**
 * Resolves an account by its role.
 *
 * Throws rather than returning null: a posting rule that cannot find the
 * account it needs must stop the transaction, not book a half entry.
 */
export async function systemAccountId(
  companyId: string,
  key: SystemAccount,
  tx: Tx | typeof db = db,
): Promise<string> {
  const found = await tx.account.findFirst({
    where: { companyId, systemKey: key },
    select: { id: true },
  });
  if (found) return found.id;

  // A company provisioned before the ledger existed has no chart yet. Create it
  // on demand rather than failing the sale that triggered this.
  await ensureChartOfAccounts(companyId, tx);
  const retry = await tx.account.findFirst({
    where: { companyId, systemKey: key },
    select: { id: true },
  });
  if (!retry) throw new Error(`Chart of accounts is missing the ${key} account`);
  return retry.id;
}

/**
 * Resolves several system accounts in one query.
 *
 * The per-key lookup below is fine on its own, but a posting rule needs three
 * or four of them and these run inside the invoice transaction — on SQLite,
 * which serialises writers, four extra round trips was enough to blow Prisma's
 * 5-second interactive transaction budget and fail the sale. One query instead.
 */
export async function systemAccounts(
  companyId: string,
  keys: SystemAccount[],
  tx: Tx | typeof db = db,
): Promise<Record<string, string>> {
  let rows = await tx.account.findMany({
    where: { companyId, systemKey: { in: keys } },
    select: { id: true, systemKey: true },
  });

  if (rows.length < keys.length) {
    // A company provisioned before the ledger existed. Create the chart rather
    // than failing whatever transaction needed it.
    await ensureChartOfAccounts(companyId, tx);
    rows = await tx.account.findMany({
      where: { companyId, systemKey: { in: keys } },
      select: { id: true, systemKey: true },
    });
  }

  const map: Record<string, string> = {};
  for (const r of rows) if (r.systemKey) map[r.systemKey] = r.id;

  const missing = keys.filter((k) => !map[k]);
  if (missing.length > 0) {
    throw new Error(`Chart of accounts is missing: ${missing.join(", ")}`);
  }
  return map;
}

export async function accountIdByCode(
  companyId: string,
  code: string,
  tx: Tx | typeof db = db,
): Promise<string | null> {
  const found = await tx.account.findFirst({
    where: { companyId, code },
    select: { id: true },
  });
  return found?.id ?? null;
}

export interface PostLine {
  accountId: string;
  debitCents?: number;
  creditCents?: number;
  memo?: string;
}

export interface PostInput {
  companyId: string;
  date: Date;
  refType: string;
  refId: string;
  sourceKind: string;
  memo?: string;
  postedById?: string | null;
  lines: PostLine[];
}

export class LedgerError extends Error {}

/**
 * Writes one balanced entry.
 *
 * Returns the existing entry untouched when this document has already been
 * posted for this `sourceKind`, so callers can post unconditionally.
 */
export async function postEntry(tx: Tx, input: PostInput) {
  const existing = await tx.journalEntry.findFirst({
    where: {
      companyId: input.companyId,
      refType: input.refType,
      refId: input.refId,
      sourceKind: input.sourceKind,
    },
  });
  if (existing) return existing;

  // Drop zero lines before balancing: a rule that legitimately produces no VAT
  // should not have to special-case it at every call site.
  const lines = input.lines.filter(
    (l) => (l.debitCents ?? 0) !== 0 || (l.creditCents ?? 0) !== 0,
  );
  if (lines.length === 0) {
    throw new LedgerError("An entry must have at least one non-zero line");
  }

  let debits = 0;
  let credits = 0;
  for (const l of lines) {
    const d = l.debitCents ?? 0;
    const c = l.creditCents ?? 0;
    if (d < 0 || c < 0) throw new LedgerError("Amounts must not be negative");
    if (d > 0 && c > 0) {
      throw new LedgerError("A line is either a debit or a credit, never both");
    }
    debits += d;
    credits += c;
  }
  if (debits !== credits) {
    throw new LedgerError(
      `Entry does not balance: debits ${debits} vs credits ${credits} (${input.refType} ${input.refId})`,
    );
  }

  await assertPeriodOpen(tx, input.companyId, input.date);

  // Passing tx is required, not optional: a nested transaction would
  // deadlock against the write lock this one already holds.
  const number = await nextNumber(input.companyId, "JOURNAL", tx);

  return tx.journalEntry.create({
    data: {
      companyId: input.companyId,
      number,
      date: input.date,
      memo: input.memo ?? null,
      refType: input.refType,
      refId: input.refId,
      sourceKind: input.sourceKind,
      postedById: input.postedById ?? null,
      lines: {
        create: lines.map((l) => ({
          accountId: l.accountId,
          debitCents: l.debitCents ?? 0,
          creditCents: l.creditCents ?? 0,
          memo: l.memo ?? null,
        })),
      },
    },
  });
}

async function assertPeriodOpen(tx: Tx, companyId: string, date: Date) {
  const period = await tx.accountingPeriod.findFirst({
    where: { companyId, year: date.getFullYear(), month: date.getMonth() + 1 },
    select: { closedAt: true },
  });
  if (period?.closedAt) {
    throw new LedgerError(
      `The ${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")} period is closed. Post the correction to an open period instead.`,
    );
  }
}

/**
 * Reverses an entry by writing its mirror image.
 *
 * The original stays exactly as posted. Both entries point at each other, so a
 * report can show the correction alongside what it corrected.
 */
export async function reverseEntry(entryId: string, reason: string, userId?: string) {
  return db.$transaction(async (tx) => {
    const original = await tx.journalEntry.findUnique({
      where: { id: entryId },
      include: { lines: true },
    });
    if (!original) throw new LedgerError("Entry not found");
    if (original.reversedById) throw new LedgerError("This entry is already reversed");

    const number = await nextNumber(original.companyId, "JOURNAL", tx);
    const reversal = await tx.journalEntry.create({
      data: {
        companyId: original.companyId,
        number,
        date: new Date(),
        memo: `Reversal of ${original.number}: ${reason}`,
        refType: original.refType,
        refId: original.refId,
        sourceKind: `REVERSAL:${original.sourceKind}`,
        reversalOfId: original.id,
        postedById: userId ?? null,
        lines: {
          create: original.lines.map((l) => ({
            accountId: l.accountId,
            // The mirror: every debit becomes a credit and back again.
            debitCents: l.creditCents,
            creditCents: l.debitCents,
            memo: l.memo,
          })),
        },
      },
    });

    await tx.journalEntry.update({
      where: { id: original.id },
      data: { reversedById: reversal.id },
    });

    return reversal;
  });
}

export interface TrialBalanceRow {
  accountId: string;
  code: string;
  name: string;
  type: AccountType;
  debitCents: number;
  creditCents: number;
  /** Signed balance in the account's natural direction. */
  balanceCents: number;
}

/**
 * The primitive every financial report is built from.
 *
 * Assets and expenses are natural debits; liabilities, equity and income are
 * natural credits. Reporting each in its natural direction is what lets the
 * P&L and balance sheet be simple sums rather than a thicket of sign flips.
 */
export async function trialBalance(
  companyId: string,
  opts: { from?: Date; to?: Date } = {},
): Promise<TrialBalanceRow[]> {
  const accounts = await db.account.findMany({
    where: { companyId },
    orderBy: { code: "asc" },
  });

  const grouped = await db.journalLine.groupBy({
    by: ["accountId"],
    where: {
      entry: {
        companyId,
        ...(opts.from || opts.to
          ? { date: { ...(opts.from ? { gte: opts.from } : {}), ...(opts.to ? { lte: opts.to } : {}) } }
          : {}),
      },
    },
    _sum: { debitCents: true, creditCents: true },
  });

  const sums = new Map(grouped.map((g) => [g.accountId, g._sum]));

  return accounts.map((a) => {
    const s = sums.get(a.id);
    const debit = s?.debitCents ?? 0;
    const credit = s?.creditCents ?? 0;
    const naturalDebit = a.type === "ASSET" || a.type === "EXPENSE";
    return {
      accountId: a.id,
      code: a.code,
      name: a.name,
      type: a.type as AccountType,
      debitCents: debit,
      creditCents: credit,
      balanceCents: naturalDebit ? debit - credit : credit - debit,
    };
  });
}

/** Total debits and credits. Any difference is a bug, not a rounding artefact. */
export async function trialBalanceTotals(companyId: string, opts: { from?: Date; to?: Date } = {}) {
  const rows = await trialBalance(companyId, opts);
  const debits = rows.reduce((n, r) => n + r.debitCents, 0);
  const credits = rows.reduce((n, r) => n + r.creditCents, 0);
  return { debits, credits, balanced: debits === credits, difference: debits - credits };
}
