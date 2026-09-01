import "server-only";

import type { Prisma } from "@prisma/client";

import { postEntry, systemAccountId, systemAccounts, accountIdByCode } from "./ledger";

/**
 * The rules that turn business events into journal entries.
 *
 * Kept apart from `ledger.ts` deliberately: that file knows how to write a
 * balanced entry and nothing about invoices; this one knows what an invoice
 * means and nothing about how entries are stored. Adding a document type
 * touches only this file.
 *
 * Every function here is safe to call more than once — `postEntry` is
 * idempotent on (document, sourceKind) — so callers post unconditionally rather
 * than tracking whether they already have.
 */

type Tx = Prisma.TransactionClient;

/** Which asset account a payment lands in, by the method recorded on it. */
function accountForMethod(method: string) {
  switch (method) {
    case "CASH":
      return "CASH" as const;
    case "BANK":
    case "CHEQUE":
      return "BANK" as const;
    // Gateway collections land in clearing, not bank: the money is with
    // Paystack or Safaricom until they pay out, and pretending otherwise
    // overstates the bank balance by however long settlement takes.
    case "MPESA":
    case "MPESA_STK":
    case "PAYSTACK":
    case "KCB_BUNI":
      return "GATEWAY_CLEARING" as const;
    default:
      return "CASH" as const;
  }
}

/**
 * Invoice issued.
 *
 *   Dr Accounts receivable    gross
 *     Cr Sales                net of tax
 *     Cr VAT payable          tax
 *
 * The customer owes the gross; only the net is revenue. Booking the tax as
 * income is the single commonest way a small system overstates profit and
 * under-reports what is owed to the revenue authority.
 */
export async function postInvoice(
  tx: Tx,
  invoice: {
    id: string;
    companyId: string;
    number: string;
    issueDate: Date;
    subtotalCents: number;
    discountCents: number;
    taxCents: number;
    totalCents: number;
  },
  userId?: string | null,
) {
  const acc = await systemAccounts(
    invoice.companyId,
    ["ACCOUNTS_RECEIVABLE", "SALES", "VAT_OUTPUT"],
    tx,
  );
  const ar = acc.ACCOUNTS_RECEIVABLE;
  const sales = acc.SALES;
  const vat = acc.VAT_OUTPUT;

  // Derived rather than taken from subtotal, so the entry balances against the
  // total actually charged even if a discount was applied after the subtotal.
  const netCents = invoice.totalCents - invoice.taxCents;

  return postEntry(tx, {
    companyId: invoice.companyId,
    date: invoice.issueDate,
    refType: "Invoice",
    refId: invoice.id,
    sourceKind: "REVENUE",
    memo: `Invoice ${invoice.number}`,
    postedById: userId ?? null,
    lines: [
      { accountId: ar, debitCents: invoice.totalCents, memo: "Receivable" },
      { accountId: sales, creditCents: netCents, memo: "Sales" },
      { accountId: vat, creditCents: invoice.taxCents, memo: "VAT" },
    ],
  });
}

/**
 * Stock moving on a sale or a sales return.
 *
 *   out (sale)     Dr Cost of goods sold   Cr Inventory
 *   in  (return)   Dr Inventory            Cr Cost of goods sold
 *
 * The direction follows the sign of the movement, which is the only thing that
 * distinguishes the two: a return posted in the sale's direction would inflate
 * cost of sales instead of relieving it, and nothing downstream would notice.
 *
 * Posted from the stock movement rather than the invoice, because the movement
 * carries the actual unit cost — and because stock can leave without an
 * invoice, or an invoice be raised for stock that never moved.
 */
export async function postCogs(
  tx: Tx,
  movement: {
    id: string;
    companyId: string;
    createdAt: Date;
    quantity: number;
    unitCostCents: number;
  },
  userId?: string | null,
) {
  const value = Math.abs(movement.quantity) * movement.unitCostCents;
  if (value === 0) return null;

  const acc = await systemAccounts(movement.companyId, ["COGS", "INVENTORY"], tx);
  const cogs = acc.COGS;
  const inventory = acc.INVENTORY;
  const stockLeaving = movement.quantity < 0;

  return postEntry(tx, {
    companyId: movement.companyId,
    date: movement.createdAt,
    refType: "StockMovement",
    refId: movement.id,
    sourceKind: "COGS",
    memo: stockLeaving ? "Cost of goods sold" : "Cost of goods returned",
    postedById: userId ?? null,
    lines: stockLeaving
      ? [
          { accountId: cogs, debitCents: value },
          { accountId: inventory, creditCents: value },
        ]
      : [
          { accountId: inventory, debitCents: value },
          { accountId: cogs, creditCents: value },
        ],
  });
}

/**
 * Payment received.
 *
 *   Dr Cash / Bank / Gateway clearing
 *     Cr Accounts receivable
 */
export async function postPayment(
  tx: Tx,
  payment: {
    id: string;
    companyId: string;
    number: string;
    paidAt: Date;
    amountCents: number;
    method: string;
  },
  userId?: string | null,
) {
  const key = accountForMethod(payment.method);
  const acc = await systemAccounts(payment.companyId, [key, "ACCOUNTS_RECEIVABLE"], tx);
  const asset = acc[key];
  const ar = acc.ACCOUNTS_RECEIVABLE;

  return postEntry(tx, {
    companyId: payment.companyId,
    date: payment.paidAt,
    refType: "Payment",
    refId: payment.id,
    sourceKind: "RECEIPT",
    memo: `Payment ${payment.number} (${payment.method})`,
    postedById: userId ?? null,
    lines: [
      { accountId: asset, debitCents: payment.amountCents },
      { accountId: ar, creditCents: payment.amountCents },
    ],
  });
}

/**
 * Goods received against a purchase order.
 *
 *   Dr Inventory
 *     Cr Goods received not invoiced
 *
 * GRNI rather than payables: the stock is ours and owed for, but the supplier's
 * invoice has not arrived, so there is nothing yet to pay against.
 */
export async function postGoodsReceiptEntry(
  tx: Tx,
  grn: { id: string; companyId: string; receivedAt: Date; valueCents: number },
  userId?: string | null,
) {
  if (grn.valueCents === 0) return null;

  const acc = await systemAccounts(grn.companyId, ["INVENTORY", "GRNI"], tx);
  const inventory = acc.INVENTORY;
  const grni = acc.GRNI;

  return postEntry(tx, {
    companyId: grn.companyId,
    date: grn.receivedAt,
    refType: "GoodsReceipt",
    refId: grn.id,
    sourceKind: "PURCHASE",
    memo: "Goods received",
    postedById: userId ?? null,
    lines: [
      { accountId: inventory, debitCents: grn.valueCents },
      { accountId: grni, creditCents: grn.valueCents },
    ],
  });
}

/**
 * Supplier invoice.
 *
 *   Dr Goods received not invoiced   net
 *   Dr VAT recoverable               tax
 *     Cr Accounts payable            gross
 */
export async function postSupplierInvoice(
  tx: Tx,
  inv: {
    id: string;
    companyId: string;
    number: string;
    invoiceDate: Date;
    subtotalCents: number;
    taxCents: number;
    totalCents: number;
  },
  userId?: string | null,
) {
  const acc = await systemAccounts(
    inv.companyId,
    ["GRNI", "VAT_INPUT", "ACCOUNTS_PAYABLE"],
    tx,
  );
  const grni = acc.GRNI;
  const vatIn = acc.VAT_INPUT;
  const ap = acc.ACCOUNTS_PAYABLE;

  const netCents = inv.totalCents - inv.taxCents;

  return postEntry(tx, {
    companyId: inv.companyId,
    date: inv.invoiceDate,
    refType: "SupplierInvoice",
    refId: inv.id,
    sourceKind: "PURCHASE_INVOICE",
    memo: `Supplier invoice ${inv.number}`,
    postedById: userId ?? null,
    lines: [
      { accountId: grni, debitCents: netCents },
      { accountId: vatIn, debitCents: inv.taxCents },
      { accountId: ap, creditCents: inv.totalCents },
    ],
  });
}

/**
 * Expense.
 *
 *   Dr the category's account (or general expenses)
 *     Cr Cash
 *
 * Field expenses are paid out of pocket and reimbursed, so cash is the honest
 * default; a company running them through payables can remap the category.
 */
export async function postExpense(
  tx: Tx,
  expense: {
    id: string;
    companyId: string;
    number: string;
    spentAt: Date;
    amountCents: number;
    categoryAccountCode?: string | null;
  },
  userId?: string | null,
) {
  if (expense.amountCents === 0) return null;

  const account =
    (expense.categoryAccountCode
      ? await accountIdByCode(expense.companyId, expense.categoryAccountCode, tx)
      : null) ?? (await systemAccountId(expense.companyId, "GENERAL_EXPENSE", tx));

  const cash = await systemAccountId(expense.companyId, "CASH", tx);

  return postEntry(tx, {
    companyId: expense.companyId,
    date: expense.spentAt,
    refType: "Expense",
    refId: expense.id,
    sourceKind: "EXPENSE",
    memo: `Expense ${expense.number}`,
    postedById: userId ?? null,
    lines: [
      { accountId: account, debitCents: expense.amountCents },
      { accountId: cash, creditCents: expense.amountCents },
    ],
  });
}

/**
 * Stock written up or down outside a sale or purchase.
 *
 * A shortage is a cost; a surplus reduces one. Either way inventory moves and
 * the contra lands in stock adjustments, so the difference shows in the P&L
 * instead of quietly vanishing.
 */
export async function postStockAdjustment(
  tx: Tx,
  movement: {
    id: string;
    companyId: string;
    createdAt: Date;
    quantity: number;
    unitCostCents: number;
  },
  userId?: string | null,
) {
  const value = Math.abs(movement.quantity) * movement.unitCostCents;
  if (value === 0) return null;

  const acc = await systemAccounts(
    movement.companyId,
    ["INVENTORY", "STOCK_ADJUSTMENT"],
    tx,
  );
  const inventory = acc.INVENTORY;
  const adjust = acc.STOCK_ADJUSTMENT;
  const increase = movement.quantity > 0;

  return postEntry(tx, {
    companyId: movement.companyId,
    date: movement.createdAt,
    refType: "StockMovement",
    refId: movement.id,
    sourceKind: "ADJUSTMENT",
    memo: increase ? "Stock increase" : "Stock write-off",
    postedById: userId ?? null,
    lines: increase
      ? [
          { accountId: inventory, debitCents: value },
          { accountId: adjust, creditCents: value },
        ]
      : [
          { accountId: adjust, debitCents: value },
          { accountId: inventory, creditCents: value },
        ],
  });
}

/**
 * Opening stock brought onto the books.
 *
 *   in    Dr Inventory          Cr Owner's equity
 *   out   Dr Owner's equity     Cr Inventory
 *
 * Goods a company already held the day it started using the system were never
 * bought through it, so there is no purchase or payable to book against. They
 * are capital introduced, and that is where the other side belongs.
 *
 * Skipping this is not cosmetic. Every sale relieves inventory at cost, so
 * stock that was never booked in drives the inventory account negative — a
 * credit balance on an asset — and overstates equity by the same amount. It is
 * the single largest opening difference on any system that starts mid-life.
 */
export async function postOpeningStock(
  tx: Tx,
  movement: {
    id: string;
    companyId: string;
    createdAt: Date;
    quantity: number;
    unitCostCents: number;
  },
  userId?: string | null,
) {
  const value = Math.abs(movement.quantity) * movement.unitCostCents;
  if (value === 0) return null;

  const acc = await systemAccounts(
    movement.companyId,
    ["INVENTORY", "OWNERS_EQUITY"],
    tx,
  );
  const inventory = acc.INVENTORY;
  const equity = acc.OWNERS_EQUITY;
  const bringingIn = movement.quantity > 0;

  return postEntry(tx, {
    companyId: movement.companyId,
    date: movement.createdAt,
    refType: "StockMovement",
    refId: movement.id,
    sourceKind: "OPENING",
    memo: "Opening stock",
    postedById: userId ?? null,
    lines: bringingIn
      ? [
          { accountId: inventory, debitCents: value },
          { accountId: equity, creditCents: value },
        ]
      : [
          { accountId: equity, debitCents: value },
          { accountId: inventory, creditCents: value },
        ],
  });
}

/**
 * Credit note issued against a sale.
 *
 *   Dr Sales returns          net of tax
 *   Dr VAT payable            tax
 *     Cr Accounts receivable  gross
 *
 * The exact mirror of an invoice, but debited to sales *returns* rather than
 * against sales itself. Netting it off revenue would hide the return: a company
 * that invoiced ten million and credited two needs to see both figures, not an
 * eight-million line that looks like it never happened. It also reclaims the
 * output VAT, which is the half a hand-rolled reversal usually forgets and the
 * revenue authority always notices.
 */
export async function postCreditNote(
  tx: Tx,
  note: {
    id: string;
    companyId: string;
    number: string;
    issueDate: Date;
    taxCents: number;
    totalCents: number;
  },
  userId?: string | null,
) {
  if (note.totalCents === 0) return null;

  const acc = await systemAccounts(
    note.companyId,
    ["SALES_RETURNS", "VAT_OUTPUT", "ACCOUNTS_RECEIVABLE"],
    tx,
  );

  const netCents = note.totalCents - note.taxCents;

  return postEntry(tx, {
    companyId: note.companyId,
    date: note.issueDate,
    refType: "CreditNote",
    refId: note.id,
    sourceKind: "CREDIT_NOTE",
    memo: `Credit note ${note.number}`,
    postedById: userId ?? null,
    lines: [
      { accountId: acc.SALES_RETURNS, debitCents: netCents, memo: "Sales return" },
      { accountId: acc.VAT_OUTPUT, debitCents: note.taxCents, memo: "VAT reversed" },
      { accountId: acc.ACCOUNTS_RECEIVABLE, creditCents: note.totalCents },
    ],
  });
}
