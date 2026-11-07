import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  accountCodeProblem,
  isJournalLocked,
  isManualJournal,
  journalProblems,
  parseAmountToCents,
  supplierInvoiceStatus,
} from "./accounting";

const line = (debitCents: number, creditCents: number, accountId = "a") => ({ accountId, debitCents, creditCents });

describe("journalProblems", () => {
  it("accepts a balanced journal", () => {
    assert.deepEqual(journalProblems([line(1000, 0), line(0, 1000)]), []);
    assert.deepEqual(journalProblems([line(1000, 0), line(0, 400), line(0, 600)]), []);
  });

  it("refuses one that does not balance, and says by how much", () => {
    const problems = journalProblems([line(1000, 0), line(0, 900)]);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /10\.00.*9\.00/);
  });

  it("refuses a one-line journal", () => {
    assert.ok(journalProblems([line(0, 0)]).some((p) => p.includes("at least two")));
  });

  it("refuses a line with both sides, neither side, or a negative", () => {
    assert.ok(journalProblems([line(500, 500), line(0, 0)]).some((p) => p.includes("both")));
    assert.ok(journalProblems([line(0, 0), line(0, 0)]).some((p) => p.includes("no amount")));
    assert.ok(journalProblems([line(-5, 0), line(0, -5)]).some((p) => p.includes("negative")));
  });

  it("refuses fractions of a cent and a missing account", () => {
    assert.ok(journalProblems([line(0.5, 0), line(0, 0.5)]).some((p) => p.includes("whole number")));
    assert.ok(journalProblems([line(5, 0, ""), line(0, 5)]).some((p) => p.includes("no account")));
  });
});

describe("accountCodeProblem", () => {
  it("accepts a code that matches its type", () => {
    assert.equal(accountCodeProblem("1020", "ASSET"), null);
    assert.equal(accountCodeProblem("6100", "EXPENSE"), null);
    assert.equal(accountCodeProblem("5100", "EXPENSE"), null);
  });

  it("refuses a code that contradicts its type", () => {
    assert.match(accountCodeProblem("6100", "ASSET")!, /start with 1/);
    assert.match(accountCodeProblem("1000", "EXPENSE")!, /start with/);
  });

  it("refuses a malformed code", () => {
    assert.ok(accountCodeProblem("12", "ASSET"));
    assert.ok(accountCodeProblem("ABCD", "ASSET"));
  });
});

describe("isJournalLocked", () => {
  it("keeps journals off accounts a sub-ledger owns", () => {
    assert.equal(isJournalLocked("ACCOUNTS_RECEIVABLE"), true);
    assert.equal(isJournalLocked("ACCOUNTS_PAYABLE"), true);
    assert.equal(isJournalLocked("INVENTORY"), true);
    assert.equal(isJournalLocked("GRNI"), true);
  });

  it("allows the rest, including paying VAT to KRA", () => {
    assert.equal(isJournalLocked("BANK"), false);
    assert.equal(isJournalLocked("VAT_OUTPUT"), false);
    assert.equal(isJournalLocked(null), false);
  });
});

describe("parseAmountToCents", () => {
  it("reads amounts as typed, without floating point", () => {
    assert.equal(parseAmountToCents("1,234.50"), 123450);
    assert.equal(parseAmountToCents("0.07"), 7);
    assert.equal(parseAmountToCents("1.1"), 110);
    assert.equal(parseAmountToCents("19.99"), 1999);
    assert.equal(parseAmountToCents(""), 0);
  });

  it("refuses what is not an amount", () => {
    assert.equal(parseAmountToCents("abc"), null);
    assert.equal(parseAmountToCents("1.234"), null);
    assert.equal(parseAmountToCents("-5"), null);
  });
});

describe("the rest", () => {
  it("reverses only hand-written journals", () => {
    assert.equal(isManualJournal("MANUAL"), true);
    assert.equal(isManualJournal("REVENUE"), false);
    assert.equal(isManualJournal("REVERSAL:MANUAL"), false);
  });

  it("derives a bill's status from what has been paid", () => {
    assert.equal(supplierInvoiceStatus(1000, 0), "UNPAID");
    assert.equal(supplierInvoiceStatus(1000, 400), "PARTIALLY_PAID");
    assert.equal(supplierInvoiceStatus(1000, 1000), "PAID");
  });
});
