import "server-only";

import { badRequest, conflict, notFound } from "@/lib/api";
import { db } from "@/lib/db";
import { creditLineAmounts } from "@/lib/money";
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
    throw badRequest("A credit note must credit at least one line");
  }
  if (!input.reason?.trim()) {
    throw badRequest("A credit note needs a reason");
  }

  // One entry per line. Each entry is checked against earlier notes, not
  // against its siblings, so the same line twice in one request would credit
  // both halves of a quantity that was only sold once.
  const seen = new Set<string>();
  for (const l of input.lines) {
    if (seen.has(l.invoiceLineId)) {
      throw badRequest("Each invoice line can appear only once in a credit note");
    }
    seen.add(l.invoiceLineId);
  }

  return db.$transaction(
    async (tx) => {
      // Take the write lock before reading anything. Two returns against the
      // same invoice at the same moment used to read the same "already
      // credited", both pass, and both credit the customer and restock the
      // goods. Touching the invoice first serialises them — SQLite has one
      // writer, and Postgres would lock the row — so the second sees the first.
      const locked = await tx.invoice.updateMany({
        where: { id: input.invoiceId, companyId: input.companyId },
        data: { updatedAt: new Date() },
      });
      if (locked.count === 0) throw notFound("Invoice not found");

      const invoice = await tx.invoice.findFirstOrThrow({
        where: { id: input.invoiceId, companyId: input.companyId },
        include: { lines: true },
      });
      if (invoice.status === "DRAFT") {
        throw conflict("A draft invoice can be edited; it does not need a credit note");
      }
      if (invoice.status === "CANCELLED") {
        throw conflict("This invoice is already cancelled");
      }

      // What each line has already had credited. Without this, three separate
      // notes could each credit the full quantity and the customer would be
      // refunded three times for one return.
      const priorLines = await tx.creditNoteLine.findMany({
        where: {
          creditNote: { companyId: input.companyId, invoiceId: invoice.id, status: { not: "CANCELLED" } },
        },
        select: { invoiceLineId: true, quantity: true, lineTotalCents: true },
      });
      const prior = new Map<string, Array<{ quantity: number; lineTotalCents: number }>>();
      for (const l of priorLines) {
        if (!l.invoiceLineId) continue;
        prior.set(l.invoiceLineId, [...(prior.get(l.invoiceLineId) ?? []), l]);
      }
      const creditedQuantity = (lineId: string) =>
        (prior.get(lineId) ?? []).reduce((n, l) => n + l.quantity, 0);

      const prepared = input.lines.map((req) => {
        const line = invoice.lines.find((l) => l.id === req.invoiceLineId);
        if (!line) throw badRequest("That line is not on this invoice");
        if (!Number.isInteger(req.quantity) || req.quantity <= 0) {
          throw badRequest("Credited quantity must be a positive whole number");
        }

        const remaining = line.quantity - creditedQuantity(line.id);
        if (req.quantity > remaining) {
          throw conflict(
            `Cannot credit ${req.quantity} of ${line.description}: only ${remaining} remain uncredited`,
          );
        }

        // Credited at the price actually charged, discount and all, and to the
        // cent once the whole line has come back.
        const amounts = creditLineAmounts(line, prior.get(line.id) ?? [], req.quantity);

        // Base units per unit sold, so returning one carton puts twelve bottles
        // back rather than one.
        const perUnit = line.quantity > 0 ? (line.baseQuantity || line.quantity) / line.quantity : 1;

        return {
          invoiceLineId: line.id,
          productId: line.productId,
          variantId: line.variantId,
          variantName: line.variantName,
          description: line.description,
          quantity: req.quantity,
          baseQuantity: Math.round(req.quantity * perUnit),
          unitPriceCents: line.unitPriceCents,
          taxRateBp: line.taxRateBp,
          lineTotalCents: amounts.totalCents,
          taxCents: amounts.taxCents,
        };
      });

      const totalCents = prepared.reduce((n, l) => n + l.lineTotalCents, 0);
      const taxCents = prepared.reduce((n, l) => n + l.taxCents, 0);

      // Numbered inside the transaction, so a note that fails validation or
      // rolls back does not burn a CRN number.
      const number = await nextNumber(input.companyId, "CREDIT_NOTE", tx);

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
              variantId: l.variantId,
              variantName: l.variantName,
              description: l.description,
              quantity: l.quantity,
              baseQuantity: l.baseQuantity,
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
          lines: prepared.map((l) => ({ productId: l.productId, quantity: l.baseQuantity })),
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
      const creditingNow = new Map(prepared.map((l) => [l.invoiceLineId, l.quantity]));
      const fully = invoice.lines.every(
        (l) => creditedQuantity(l.id) + (creditingNow.get(l.id) ?? 0) >= l.quantity,
      );
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
