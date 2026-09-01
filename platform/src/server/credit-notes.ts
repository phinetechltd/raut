import "server-only";

import { db } from "@/lib/db";
import { nextNumber } from "@/lib/numbering";
import { returnFromSale } from "./inventory";
import { postCreditNote } from "./posting";

/**
 * Credit notes.
 *
 * A credit note is the only correct way to reverse an issued invoice. Editing
 * or deleting one is not: the customer has a copy, the ledger has an entry, and
 * once eTIMS has accepted it KRA has a copy too. A document that can be quietly
 * rewritten after the fact is not an audit trail.
 *
 * One note reverses one invoice. Partial credits are the normal case — a
 * customer returns three of the ten cases delivered — so quantities are per
 * line and validated against what was actually invoiced.
 */

export interface CreateCreditNoteInput {
  companyId: string;
  invoiceId: string;
  reason: string;
  /** Whether the goods physically came back. Damaged stock is credited but not restocked. */
  restock?: boolean;
  lines: Array<{ invoiceLineId: string; quantity: number }>;
  createdById?: string | null;
  clientUuid?: string | null;
}

export async function createCreditNote(input: CreateCreditNoteInput) {
  if (input.lines.length === 0) {
    throw new Error("A credit note must credit at least one line");
  }
  if (!input.reason?.trim()) {
    throw new Error("A credit note needs a reason");
  }

  const invoice = await db.invoice.findFirst({
    where: { id: input.invoiceId, companyId: input.companyId },
    include: { lines: true },
  });
  if (!invoice) throw new Error("Invoice not found");
  if (invoice.status === "DRAFT") {
    throw new Error("A draft invoice can be edited; it does not need a credit note");
  }
  if (invoice.status === "CANCELLED") {
    throw new Error("This invoice is already cancelled");
  }

  // How much of each line has already been credited. Without this, three
  // separate notes could each credit the full quantity and the customer would
  // be refunded three times for one return.
  const priorLines = await db.creditNoteLine.findMany({
    where: {
      creditNote: { companyId: input.companyId, invoiceId: invoice.id, status: { not: "CANCELLED" } },
    },
    select: { invoiceLineId: true, quantity: true },
  });
  const alreadyCredited = new Map<string, number>();
  for (const l of priorLines) {
    if (!l.invoiceLineId) continue;
    alreadyCredited.set(l.invoiceLineId, (alreadyCredited.get(l.invoiceLineId) ?? 0) + l.quantity);
  }

  const prepared = input.lines.map((req) => {
    const line = invoice.lines.find((l) => l.id === req.invoiceLineId);
    if (!line) throw new Error("That line is not on this invoice");
    if (req.quantity <= 0) throw new Error("Credited quantity must be positive");

    const remaining = line.quantity - (alreadyCredited.get(line.id) ?? 0);
    if (req.quantity > remaining) {
      throw new Error(
        `Cannot credit ${req.quantity} of ${line.description}: only ${remaining} remain uncredited`,
      );
    }

    // Credit at the price actually charged, not today's price. A price rise
    // between sale and return would otherwise refund more than was taken.
    const unitNet = Math.round((line.lineTotalCents - line.discountCents) / line.quantity);
    const lineTotal = unitNet * req.quantity;
    const tax = Math.round((lineTotal * line.taxRateBp) / (10_000 + line.taxRateBp));

    return {
      invoiceLineId: line.id,
      productId: line.productId,
      description: line.description,
      quantity: req.quantity,
      unitPriceCents: line.unitPriceCents,
      taxRateBp: line.taxRateBp,
      lineTotalCents: lineTotal,
      taxCents: tax,
    };
  });

  const totalCents = prepared.reduce((n, l) => n + l.lineTotalCents, 0);
  const taxCents = prepared.reduce((n, l) => n + l.taxCents, 0);

  const number = await nextNumber(input.companyId, "CREDIT_NOTE");

  return db.$transaction(
    async (tx) => {
      const note = await tx.creditNote.create({
        data: {
          companyId: input.companyId,
          invoiceId: invoice.id,
          customerId: invoice.customerId,
          number,
          status: "ISSUED",
          reason: input.reason.trim(),
          restock: input.restock ?? true,
          subtotalCents: totalCents - taxCents,
          taxCents,
          totalCents,
          clientUuid: input.clientUuid ?? null,
          createdById: input.createdById ?? null,
          lines: {
            create: prepared.map((l) => ({
              invoiceLineId: l.invoiceLineId,
              productId: l.productId,
              description: l.description,
              quantity: l.quantity,
              unitPriceCents: l.unitPriceCents,
              taxRateBp: l.taxRateBp,
              lineTotalCents: l.lineTotalCents,
            })),
          },
        },
      });

      // The customer owes less.
      await tx.customer.update({
        where: { id: invoice.customerId },
        data: { balanceCents: { decrement: totalCents } },
      });

      if (input.restock ?? true) {
        await returnFromSale(tx, {
          companyId: input.companyId,
          locationId: invoice.locationId,
          lines: prepared.map((l) => ({ productId: l.productId, quantity: l.quantity })),
          refType: "CREDIT_NOTE",
          refId: note.id,
          createdById: input.createdById,
        });
      }

      await postCreditNote(
        tx,
        {
          id: note.id,
          companyId: input.companyId,
          number: note.number,
          issueDate: note.issueDate,
          taxCents,
          totalCents,
        },
        input.createdById,
      );

      // A fully credited invoice is cancelled; a partly credited one is not,
      // because the balance of it is still owed.
      const creditedNow = new Map(alreadyCredited);
      for (const l of prepared) {
        creditedNow.set(l.invoiceLineId, (creditedNow.get(l.invoiceLineId) ?? 0) + l.quantity);
      }
      const fully = invoice.lines.every((l) => (creditedNow.get(l.id) ?? 0) >= l.quantity);
      if (fully) {
        await tx.invoice.update({
          where: { id: invoice.id },
          data: { status: "CANCELLED" },
        });
      }

      return note;
    },
    { timeout: 15_000 },
  );
}

/** Credit notes for a company, newest first. */
export async function listCreditNotes(companyId: string, limit = 50) {
  return db.creditNote.findMany({
    where: { companyId },
    include: {
      customer: { select: { name: true } },
      invoice: { select: { number: true } },
      lines: true,
    },
    orderBy: { issueDate: "desc" },
    take: limit,
  });
}
