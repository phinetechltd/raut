import "server-only";

import { randomUUID } from "node:crypto";

import { ApiError, badRequest, conflict, notFound } from "@/lib/api";
import { supplierInvoiceStatus } from "@/lib/accounting";
import { db } from "@/lib/db";
import { nextNumber } from "@/lib/numbering";

import { postEntry, reverseEntry, systemAccounts } from "./ledger";
import { postSupplierInvoice } from "./posting";

/**
 * Accounts payable: the supplier's bill and paying it.
 *
 * A goods receipt puts stock on the books against "goods received not invoiced".
 * The bill clears that, records what is owed, and is where input VAT enters the
 * ledger. Without bills a VAT return shows no input tax at all and overstates
 * what is due to KRA.
 */

// A busy server must not fail a posting halfway; these all roll back cleanly either way.
const LEDGER_TX = { timeout: 20_000, maxWait: 20_000 };

export interface BillInput {
  supplierId: string;
  /** The supplier's own invoice number; what KRA expects on the purchases schedule. */
  supplierRef: string;
  issueDate: Date;
  dueDate?: Date | null;
  netCents: number;
  taxCents: number;
  /** Set for services and overheads. Left empty, the bill clears received stock. */
  expenseAccountId?: string | null;
  note?: string | null;
}

export async function createBill(companyId: string, userId: string, input: BillInput) {
  if (input.netCents < 0 || input.taxCents < 0) throw badRequest("Amounts must not be negative");
  if (input.netCents + input.taxCents <= 0) throw badRequest("A bill needs an amount");

  const supplier = await db.supplier.findFirst({
    where: { id: input.supplierId, companyId },
    select: { id: true, name: true, paymentTermsDays: true },
  });
  if (!supplier) throw badRequest("Supplier not found");

  // The same supplier invoice entered twice would be paid twice and its VAT
  // claimed twice.
  const duplicate = await db.supplierInvoice.findFirst({
    where: {
      companyId,
      supplierId: supplier.id,
      supplierRef: input.supplierRef,
      status: { not: "VOID" },
    },
    select: { number: true },
  });
  if (duplicate) throw conflict(`${supplier.name} invoice ${input.supplierRef} is already entered as ${duplicate.number}`);

  if (input.expenseAccountId) {
    const account = await db.account.findFirst({
      where: { id: input.expenseAccountId, companyId, active: true, type: { in: ["EXPENSE", "ASSET"] } },
      select: { id: true, systemKey: true },
    });
    if (!account) throw badRequest("Choose an active expense or asset account");
    if (account.systemKey === "INVENTORY") throw badRequest("Stock comes in through a goods receipt, not straight to inventory");
  }

  const dueDate =
    input.dueDate ?? new Date(input.issueDate.getTime() + supplier.paymentTermsDays * 86_400_000);
  const totalCents = input.netCents + input.taxCents;

  return db.$transaction(async (tx) => {
    const number = await nextNumber(companyId, "SUPPLIER_INVOICE", tx);
    const bill = await tx.supplierInvoice.create({
      data: {
        companyId,
        supplierId: supplier.id,
        number,
        supplierRef: input.supplierRef,
        status: "UNPAID",
        issueDate: input.issueDate,
        dueDate,
        totalCents,
        taxCents: input.taxCents,
        expenseAccountId: input.expenseAccountId ?? null,
        note: input.note ?? null,
        createdById: userId,
      },
    });

    await postSupplierInvoice(
      tx,
      {
        id: bill.id,
        companyId,
        number,
        invoiceDate: input.issueDate,
        subtotalCents: input.netCents,
        taxCents: input.taxCents,
        totalCents,
        debitAccountId: input.expenseAccountId ?? null,
      },
      userId,
    );

    await tx.supplier.update({ where: { id: supplier.id }, data: { balanceCents: { increment: totalCents } } });
    return bill;
  }, LEDGER_TX);
}

export interface SupplierPaymentInput {
  amountCents: number;
  paidAt: Date;
  /** Which ledger account the money left. */
  account: "BANK" | "CASH";
  method?: string | null;
  reference?: string | null;
  clientUuid?: string | null;
}

export async function payBill(companyId: string, userId: string, billId: string, input: SupplierPaymentInput) {
  if (input.amountCents <= 0) throw badRequest("A payment needs an amount");

  if (input.clientUuid) {
    const earlier = await db.supplierPayment.findUnique({ where: { clientUuid: input.clientUuid } });
    if (earlier) {
      if (earlier.companyId !== companyId) throw conflict("That reference has already been used");
      return earlier;
    }
  }

  return db.$transaction(async (tx) => {
    const bill = await tx.supplierInvoice.findFirst({ where: { id: billId, companyId } });
    if (!bill) throw notFound("Bill not found");
    if (bill.status === "VOID") throw new ApiError(422, "BILL_VOID", `${bill.number} has been voided`);

    const outstanding = bill.totalCents - bill.paidCents;
    if (input.amountCents > outstanding) {
      throw new ApiError(
        422,
        "OVERPAYMENT",
        `${bill.number} has ${(outstanding / 100).toFixed(2)} outstanding; this payment is more than that`,
      );
    }

    const number = await nextNumber(companyId, "SUPPLIER_PAYMENT", tx);
    const payment = await tx.supplierPayment.create({
      data: {
        companyId,
        supplierId: bill.supplierId,
        supplierInvoiceId: bill.id,
        number,
        amountCents: input.amountCents,
        account: input.account,
        method: input.method ?? (input.account === "CASH" ? "CASH" : "BANK_TRANSFER"),
        reference: input.reference ?? null,
        paidAt: input.paidAt,
        clientUuid: input.clientUuid ?? randomUUID(),
        createdById: userId,
      },
    });

    const accounts = await systemAccounts(companyId, ["ACCOUNTS_PAYABLE", input.account], tx);
    await postEntry(tx, {
      companyId,
      date: input.paidAt,
      refType: "SupplierPayment",
      refId: payment.id,
      sourceKind: "SUPPLIER_PAYMENT",
      memo: `Payment ${number} on ${bill.number}`,
      postedById: userId,
      lines: [
        { accountId: accounts.ACCOUNTS_PAYABLE, debitCents: input.amountCents },
        { accountId: accounts[input.account], creditCents: input.amountCents },
      ],
    });

    const paidCents = bill.paidCents + input.amountCents;
    await tx.supplierInvoice.update({
      where: { id: bill.id },
      data: { paidCents, status: supplierInvoiceStatus(bill.totalCents, paidCents) },
    });
    await tx.supplier.update({
      where: { id: bill.supplierId },
      data: { balanceCents: { decrement: input.amountCents } },
    });
    return payment;
  }, LEDGER_TX);
}

/** A bill entered in error. Once anything has been paid it has to be credited instead. */
export async function voidBill(companyId: string, userId: string, billId: string, reason: string) {
  const bill = await db.supplierInvoice.findFirst({ where: { id: billId, companyId } });
  if (!bill) throw notFound("Bill not found");
  if (bill.status === "VOID") throw conflict(`${bill.number} is already void`);
  if (bill.paidCents > 0) {
    throw new ApiError(422, "BILL_PAID", `${bill.number} has payments against it and cannot be voided`);
  }

  const entry = await db.journalEntry.findFirst({
    where: { companyId, refType: "SupplierInvoice", refId: bill.id, sourceKind: "PURCHASE_INVOICE" },
    select: { id: true },
  });
  if (entry) await reverseEntry(entry.id, reason, userId);

  await db.$transaction([
    db.supplierInvoice.update({ where: { id: bill.id }, data: { status: "VOID", note: reason } }),
    db.supplier.update({ where: { id: bill.supplierId }, data: { balanceCents: { decrement: bill.totalCents } } }),
  ]);
  return { id: bill.id, number: bill.number, status: "VOID" };
}
