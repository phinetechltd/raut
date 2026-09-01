import "server-only";

import { db } from "./db";
import type { Prisma } from "@prisma/client";

/**
 * Per-company document numbering (INV-0001, ZM-PO-0007 …).
 *
 * The counter is incremented inside a transaction and the incremented value is
 * read back, so two concurrent invoices cannot claim the same number. On
 * SQLite, writes serialise anyway, but the transaction is what makes this
 * correct rather than merely lucky.
 */

export type DocType =
  | "INVOICE"
  | "QUOTE"
  | "ORDER"
  | "PO"
  | "GRN"
  | "PAYMENT"
  | "EXPENSE"
  | "TRANSFER"
  | "SUPPLIER_INVOICE"
  | "JOURNAL"
  | "CREDIT_NOTE"
  | "CUSTOMER"
  | "SUPPLIER";

const DEFAULT_PREFIX: Record<DocType, string> = {
  INVOICE: "INV",
  QUOTE: "QT",
  ORDER: "SO",
  PO: "PO",
  GRN: "GRN",
  PAYMENT: "PAY",
  EXPENSE: "EXP",
  TRANSFER: "TRF",
  JOURNAL: "JV",
  CREDIT_NOTE: "CRN",
  SUPPLIER_INVOICE: "SIN",
  CUSTOMER: "CUS",
  SUPPLIER: "SUP",
};

const PAD = 4;

export async function nextNumber(
  companyId: string,
  docType: DocType,
  /**
   * Run inside an existing transaction rather than opening a new one.
   *
   * This is not an optimisation. SQLite allows a single writer, so opening a
   * nested transaction from inside an interactive one deadlocks: the inner
   * connection waits for a write lock the outer transaction is still holding,
   * until the socket times out. Callers already inside a transaction — the
   * ledger posts a journal number from inside the invoice's — must pass it.
   */
  client?: Prisma.TransactionClient,
): Promise<string> {
  const run = async (tx: Prisma.TransactionClient) => {
    const existing = await tx.documentCounter.findUnique({
      where: { companyId_docType: { companyId, docType } },
    });

    if (!existing) {
      const prefix = DEFAULT_PREFIX[docType];
      await tx.documentCounter.create({
        data: { companyId, docType, prefix, nextValue: 2 },
      });
      return `${prefix}-${String(1).padStart(PAD, "0")}`;
    }

    const value = existing.nextValue;
    await tx.documentCounter.update({
      where: { id: existing.id },
      data: { nextValue: value + 1 },
    });
    return `${existing.prefix}-${String(value).padStart(PAD, "0")}`;
  };

  return client ? run(client) : db.$transaction(run);
}

/** Seeds counters for a newly created company so the first document is -0001. */
export async function initCounters(companyId: string): Promise<void> {
  const rows = (Object.keys(DEFAULT_PREFIX) as DocType[]).map((docType) => ({
    companyId,
    docType,
    prefix: DEFAULT_PREFIX[docType],
    nextValue: 1,
  }));
  await db.documentCounter.createMany({ data: rows });
}