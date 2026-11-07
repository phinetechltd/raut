import "server-only";

import { randomUUID } from "node:crypto";

import { ApiError, badRequest, conflict, notFound } from "@/lib/api";
import {
  accountCodeProblem,
  isJournalLocked,
  isManualJournal,
  journalProblems,
  type AccountTypeName,
  type JournalLineInput,
} from "@/lib/accounting";
import { db } from "@/lib/db";
import { nairobiMonth, nairobiMonthBounds } from "@/lib/report-engine";

import { ensureChartOfAccounts, postEntry, reverseEntry, trialBalance } from "./ledger";

/**
 * The tools an accountant uses directly: manual journals, the chart of accounts
 * and closing a month. Everything still goes through `postEntry`, so a journal
 * typed by hand obeys the same balance and closed-period rules as an invoice.
 */

export interface ManualJournalInput {
  date: Date;
  memo: string;
  lines: JournalLineInput[];
  /** A resend of the same form cannot post twice. */
  clientUuid?: string | null;
}

export async function createManualJournal(companyId: string, userId: string, input: ManualJournalInput) {
  const problems = journalProblems(input.lines);
  if (problems.length > 0) throw new ApiError(422, "JOURNAL_INVALID", problems[0], { problems });

  const accountIds = [...new Set(input.lines.map((l) => l.accountId))];
  const accounts = await db.account.findMany({
    where: { companyId, id: { in: accountIds } },
    select: { id: true, code: true, name: true, systemKey: true, active: true, isPostable: true },
  });
  // A foreign id looks exactly like a missing one, so nothing is learned by probing.
  if (accounts.length !== accountIds.length) throw badRequest("One of those accounts does not exist");
  for (const account of accounts) {
    if (!account.active) throw new ApiError(422, "ACCOUNT_INACTIVE", `${account.code} ${account.name} is inactive`);
    if (!account.isPostable) {
      throw new ApiError(422, "ACCOUNT_NOT_POSTABLE", `${account.code} ${account.name} is a heading, not a posting account`);
    }
    if (isJournalLocked(account.systemKey)) {
      throw new ApiError(
        422,
        "ACCOUNT_LOCKED",
        `${account.code} ${account.name} is kept by its own documents. Use a credit note, stock adjustment or supplier bill so the detail stays in step.`,
      );
    }
  }

  return db.$transaction((tx) =>
    postEntry(tx, {
      companyId,
      date: input.date,
      refType: "ManualJournal",
      refId: input.clientUuid || randomUUID(),
      sourceKind: "MANUAL",
      memo: input.memo,
      postedById: userId,
      lines: input.lines.map((l) => ({
        accountId: l.accountId,
        debitCents: l.debitCents,
        creditCents: l.creditCents,
        memo: l.memo ?? undefined,
      })),
    }),
    { timeout: 20_000, maxWait: 20_000 },
  );
}

/**
 * Only hand-written journals are reversed here. Reversing the entry behind an
 * invoice would take it out of the ledger while the invoice stayed live, and the
 * two would disagree for good. Those are undone through a credit note.
 */
export async function reverseManualJournal(companyId: string, userId: string, entryId: string, reason: string) {
  const entry = await db.journalEntry.findFirst({
    where: { id: entryId, companyId },
    select: { id: true, sourceKind: true, reversedById: true, number: true },
  });
  if (!entry) throw notFound("Journal not found");
  if (!isManualJournal(entry.sourceKind)) {
    throw new ApiError(
      422,
      "NOT_MANUAL",
      `${entry.number} was posted by its source document. Correct the document instead.`,
    );
  }
  if (entry.reversedById) throw conflict(`${entry.number} is already reversed`);
  return reverseEntry(entry.id, reason, userId);
}

// ── chart of accounts ──────────────────────────────────────────────────

export async function chartWithBalances(companyId: string) {
  await ensureChartOfAccounts(companyId);
  const [accounts, balances] = await Promise.all([
    db.account.findMany({
      where: { companyId },
      select: { id: true, code: true, name: true, type: true, systemKey: true, active: true, isPostable: true },
      orderBy: { code: "asc" },
    }),
    trialBalance(companyId),
  ]);
  const byId = new Map(balances.map((b) => [b.accountId, b]));
  return accounts.map((a) => ({
    ...a,
    balanceCents: byId.get(a.id)?.balanceCents ?? 0,
    hasActivity: (byId.get(a.id)?.debitCents ?? 0) + (byId.get(a.id)?.creditCents ?? 0) > 0,
  }));
}

export async function createAccount(
  companyId: string,
  input: { code: string; name: string; type: AccountTypeName },
) {
  const problem = accountCodeProblem(input.code, input.type);
  if (problem) throw new ApiError(422, "ACCOUNT_CODE_INVALID", problem);

  const clash = await db.account.findFirst({ where: { companyId, code: input.code }, select: { id: true } });
  if (clash) throw conflict(`Account ${input.code} already exists`);

  return db.account.create({ data: { companyId, code: input.code, name: input.name, type: input.type } });
}

/**
 * The name can always change. Retiring an account needs it to be empty, or its
 * balance would drop out of the journal picker while staying in the statements.
 * The accounts posting rules depend on can never be retired.
 */
export async function updateAccount(companyId: string, id: string, input: { name?: string; active?: boolean }) {
  const account = await db.account.findFirst({
    where: { id, companyId },
    select: { id: true, code: true, name: true, systemKey: true, active: true },
  });
  if (!account) throw notFound("Account not found");

  if (input.active === false && account.active) {
    if (account.systemKey) {
      throw new ApiError(422, "ACCOUNT_SYSTEM", `${account.code} ${account.name} is used by automatic posting and cannot be retired`);
    }
    const [row] = (await trialBalance(companyId)).filter((r) => r.accountId === id);
    if (row && row.balanceCents !== 0) {
      throw new ApiError(422, "ACCOUNT_NOT_EMPTY", `${account.code} ${account.name} still has a balance. Journal it to zero first.`);
    }
  }

  return db.account.update({
    where: { id },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.active !== undefined ? { active: input.active } : {}),
    },
  });
}

// ── accounting periods ─────────────────────────────────────────────────

export interface PeriodRow {
  month: string;
  year: number;
  monthNumber: number;
  closedAt: Date | null;
  closedByName: string | null;
  entries: number;
  debitCents: number;
}

/** The last `count` months, newest first, with what was posted in each. */
export async function periodsOverview(companyId: string, count = 24, now: Date = new Date()): Promise<PeriodRow[]> {
  const current = nairobiMonth(now);
  const [year, month] = current.split("-").map(Number);
  const months = Array.from({ length: count }, (_, i) => {
    const d = new Date(Date.UTC(year, month - 1 - i, 1));
    return { year: d.getUTCFullYear(), monthNumber: d.getUTCMonth() + 1 };
  });

  const closed = await db.accountingPeriod.findMany({ where: { companyId } });
  const closedBy = new Map(closed.map((p) => [`${p.year}-${p.month}`, p]));
  const userIds = closed.flatMap((p) => (p.closedById ? [p.closedById] : []));
  const users = await db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } });
  const nameOf = new Map(users.map((u) => [u.id, u.name]));

  return Promise.all(
    months.map(async ({ year: y, monthNumber }) => {
      const label = `${y}-${String(monthNumber).padStart(2, "0")}`;
      const bounds = nairobiMonthBounds(label)!;
      const [entries, sums] = await Promise.all([
        db.journalEntry.count({ where: { companyId, date: { gte: bounds.from, lte: bounds.to } } }),
        db.journalLine.aggregate({
          where: { entry: { companyId, date: { gte: bounds.from, lte: bounds.to } } },
          _sum: { debitCents: true },
        }),
      ]);
      const period = closedBy.get(`${y}-${monthNumber}`);
      return {
        month: label,
        year: y,
        monthNumber,
        closedAt: period?.closedAt ?? null,
        closedByName: period?.closedById ? nameOf.get(period.closedById) ?? null : null,
        entries,
        debitCents: sums._sum.debitCents ?? 0,
      };
    }),
  );
}

function parseMonth(ym: string): { year: number; month: number } {
  if (!nairobiMonthBounds(ym)) throw badRequest("month must be YYYY-MM");
  const [year, month] = ym.split("-").map(Number);
  return { year, month };
}

/** A month can only be closed once it is over; the current one is still being written. */
export async function closePeriod(companyId: string, userId: string, ym: string, now: Date = new Date()) {
  const { year, month } = parseMonth(ym);
  if (ym >= nairobiMonth(now)) {
    throw new ApiError(422, "PERIOD_NOT_OVER", "Only a month that has ended can be closed");
  }
  return db.accountingPeriod.upsert({
    where: { companyId_year_month: { companyId, year, month } },
    create: { companyId, year, month, closedAt: new Date(), closedById: userId },
    update: { closedAt: new Date(), closedById: userId },
  });
}

export async function reopenPeriod(companyId: string, ym: string) {
  const { year, month } = parseMonth(ym);
  const existing = await db.accountingPeriod.findUnique({
    where: { companyId_year_month: { companyId, year, month } },
    select: { id: true, closedAt: true },
  });
  if (!existing?.closedAt) throw conflict(`${ym} is not closed`);
  return db.accountingPeriod.update({ where: { id: existing.id }, data: { closedAt: null, closedById: null } });
}
