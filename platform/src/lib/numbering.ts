import "server-only";

import { Prisma } from "@prisma/client";

import { db } from "./db";

/**
 * Per-company document numbering (INV-0001, ZM-PO-0007 …).
 *
 * The counter is advanced with an atomic `increment` and the advanced value is
 * read back, so two concurrent callers cannot claim the same number: the
 * database serialises the two increments, and each caller reads only its own.
 * On SQLite writes serialise anyway; on Postgres the row lock does the same
 * job. Either way the transaction is what makes this correct rather than
 * merely lucky.
 *
 * Document numbers are allocated **inside the document's own transaction** —
 * callers writing an order, invoice, payment or expense pass their `tx`. A
 * number taken outside the transaction survives a rollback as a gap, and two
 * callers that both read "next is 7" before either wrote produce a duplicate
 * that the (companyId, number) unique index then turns into a 500.
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
  | "DELIVERY_NOTE"
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
  DELIVERY_NOTE: "DN",
  SUPPLIER_INVOICE: "SIN",
  CUSTOMER: "CUS",
  SUPPLIER: "SUP",
};

const PAD = 4;

export function formatDocumentNumber(prefix: string, value: number): string {
  return `${prefix}-${String(value).padStart(PAD, "0")}`;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002"
  );
}

/**
 * Advances the counter and returns the number it held.
 *
 * `updateMany` with `increment` is a single UPDATE statement, so the read-back
 * that follows sees this caller's increment and nothing newer from inside the
 * same transaction. When the counter does not exist yet the row is created
 * holding `nextValue: 2` and 1 is returned; two first-callers racing on the
 * create collide on the (companyId, docType) unique index, and the loser
 * retries once down the increment path.
 */
async function allocate(
  tx: Prisma.TransactionClient,
  companyId: string,
  docType: DocType,
  attempt = 0,
): Promise<string> {
  const advanced = await tx.documentCounter.updateMany({
    where: { companyId, docType },
    data: { nextValue: { increment: 1 } },
  });

  if (advanced.count === 1) {
    const row = await tx.documentCounter.findUniqueOrThrow({
      where: { companyId_docType: { companyId, docType } },
      select: { prefix: true, nextValue: true },
    });
    // nextValue is already the *next* number; this caller took the one before.
    return formatDocumentNumber(row.prefix, row.nextValue - 1);
  }

  const prefix = DEFAULT_PREFIX[docType];
  try {
    await tx.documentCounter.create({
      data: { companyId, docType, prefix, nextValue: 2 },
    });
    return formatDocumentNumber(prefix, 1);
  } catch (error) {
    // The other first-caller won the create. Its row now exists, so the
    // increment path will succeed; retry exactly once rather than looping.
    if (isUniqueViolation(error) && attempt === 0) {
      return allocate(tx, companyId, docType, attempt + 1);
    }
    throw error;
  }
}

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
   * Callers creating a document should be inside one, and pass it.
   */
  client?: Prisma.TransactionClient,
): Promise<string> {
  if (client) return allocate(client, companyId, docType);
  return db.$transaction((tx) => allocate(tx, companyId, docType));
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
