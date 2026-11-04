import { z } from "zod";

import { handler, parseBody, withIdempotency } from "@/lib/api";
import { db } from "@/lib/db";
import { companyIdOf } from "@/lib/tenant";
import { createCreditNote, listCreditNotes } from "@/server/credit-notes";
import { queueCreditNote, shouldAutoTransmit, transmitCreditNote } from "@/server/etims";

export const dynamic = "force-dynamic";

export const GET = handler({ permission: "creditnote:read" }, async ({ principal }) => {
  return { rows: await listCreditNotes(companyIdOf(principal)) };
});

const Body = z.object({
  invoiceId: z.string().min(1),
  reason: z.string().min(1),
  restock: z.boolean().optional(),
  clientUuid: z.string().optional(),
  lines: z
    .array(z.object({ invoiceLineId: z.string().min(1), quantity: z.number().int().positive() }))
    .min(1),
});

/**
 * Raises a credit note.
 *
 * Wrapped in the same idempotency as every other mobile write: a rep whose
 * handset lost the reply and retried must get the *same* credit note back, not
 * a second one — and not a second transmission to KRA, which is what the
 * replay also prevents.
 *
 * Transmission follows the company's own rule. With auto-transmit off, the
 * note queues for someone to release, exactly as an invoice does; sending it
 * regardless would file a reversal the office had chosen to hold.
 */
export const POST = handler(
  { permission: "creditnote:write" },
  async ({ principal, request }) => {
    const body = await parseBody(request, Body);
    const companyId = companyIdOf(principal);

    const { data, replayed } = await withIdempotency(
      principal,
      body.clientUuid,
      "credit-notes",
      async () => {
        const note = await createCreditNote({
          companyId,
          invoiceId: body.invoiceId,
          reason: body.reason,
          restock: body.restock,
          lines: body.lines,
          clientUuid: body.clientUuid,
          createdById: principal.userId,
        });

        // Same rule as an invoice: transmission happens after the books are
        // written, and a KRA failure never undoes a credit the customer is owed.
        // Queued first, so a crash mid-send leaves it for the runner.
        await queueCreditNote(note.id, companyId).catch(() => {});
        if (await shouldAutoTransmit(companyId)) {
          await transmitCreditNote(note.id, companyId).catch(() => {});
        }

        // Re-read: `note` was captured before transmission, so returning it would
        // report the credit as unfiled even when KRA has just accepted it.
        const filed = await db.creditNote.findUniqueOrThrow({ where: { id: note.id } });
        return { id: filed.id, creditNote: filed };
      },
    );

    return { creditNote: data.creditNote, ...(replayed ? { replayed: true } : {}) };
  },
);
