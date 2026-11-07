/**
 * Rules for the accounting tools, free of the database so they can be tested on
 * their own: what makes a manual journal valid, which accounts it may touch, and
 * how a new account's code must look.
 */

export const ACCOUNT_TYPES = ["ASSET", "LIABILITY", "EQUITY", "INCOME", "EXPENSE"] as const;
export type AccountTypeName = (typeof ACCOUNT_TYPES)[number];

export const ACCOUNT_TYPE_LABELS: Record<AccountTypeName, string> = {
  ASSET: "Asset",
  LIABILITY: "Liability",
  EQUITY: "Equity",
  INCOME: "Income",
  EXPENSE: "Expense",
};

/** The first digit of a code says what the account is, as in the default chart. */
export const ACCOUNT_CODE_PREFIX: Record<AccountTypeName, string[]> = {
  ASSET: ["1"],
  LIABILITY: ["2"],
  EQUITY: ["3"],
  INCOME: ["4"],
  // 5xxx is cost of sales and 6xxx onwards overheads: the P&L splits on this.
  EXPENSE: ["5", "6", "7", "8", "9"],
};

export function accountCodeProblem(code: string, type: AccountTypeName): string | null {
  if (!/^\d{4,6}$/.test(code)) return "An account code is 4 to 6 digits";
  if (!ACCOUNT_CODE_PREFIX[type].includes(code[0])) {
    return `${ACCOUNT_TYPE_LABELS[type]} account codes start with ${ACCOUNT_CODE_PREFIX[type].join(" or ")}`;
  }
  return null;
}

/**
 * Accounts only their sub-ledger may move. A journal to receivables changes the
 * ledger but no customer's balance, so the two stop agreeing and nothing says
 * why. These are corrected through the documents that own them: a credit note, a
 * stock adjustment, a supplier bill.
 */
export const JOURNAL_LOCKED_ACCOUNTS = ["ACCOUNTS_RECEIVABLE", "ACCOUNTS_PAYABLE", "INVENTORY", "GRNI"] as const;

export function isJournalLocked(systemKey: string | null | undefined): boolean {
  return (JOURNAL_LOCKED_ACCOUNTS as readonly string[]).includes(systemKey ?? "");
}

export interface JournalLineInput {
  accountId: string;
  debitCents: number;
  creditCents: number;
  memo?: string | null;
}

/** Everything wrong with a proposed journal, in words the bookkeeper can act on. */
export function journalProblems(lines: JournalLineInput[]): string[] {
  const problems: string[] = [];
  if (lines.length < 2) problems.push("A journal needs at least two lines");

  let debits = 0;
  let credits = 0;
  lines.forEach((line, index) => {
    const label = `Line ${index + 1}`;
    if (!line.accountId) problems.push(`${label} has no account`);
    if (!Number.isInteger(line.debitCents) || !Number.isInteger(line.creditCents)) {
      problems.push(`${label} has an amount that is not a whole number of cents`);
    }
    if (line.debitCents < 0 || line.creditCents < 0) problems.push(`${label} has a negative amount`);
    if (line.debitCents > 0 && line.creditCents > 0) {
      problems.push(`${label} has both a debit and a credit`);
    }
    if (line.debitCents === 0 && line.creditCents === 0) problems.push(`${label} has no amount`);
    debits += line.debitCents;
    credits += line.creditCents;
  });

  if (debits !== credits) {
    problems.push(
      `Debits (${(debits / 100).toFixed(2)}) and credits (${(credits / 100).toFixed(2)}) must be equal`,
    );
  }
  return problems;
}

/** Turns "1,234.50" as typed into 123450 cents, or null if it is not an amount. */
export function parseAmountToCents(raw: string): number | null {
  const cleaned = raw.replaceAll(",", "").trim();
  if (cleaned === "") return 0;
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const [whole, fraction = ""] = cleaned.split(".");
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
}

/** Sources written by hand. Only these may be reversed from the journal screen. */
export function isManualJournal(sourceKind: string): boolean {
  return sourceKind === "MANUAL";
}

export const SUPPLIER_INVOICE_STATUSES = ["UNPAID", "PARTIALLY_PAID", "PAID", "VOID"] as const;

export function supplierInvoiceStatus(totalCents: number, paidCents: number): "UNPAID" | "PARTIALLY_PAID" | "PAID" {
  if (paidCents <= 0) return "UNPAID";
  return paidCents >= totalCents ? "PAID" : "PARTIALLY_PAID";
}
