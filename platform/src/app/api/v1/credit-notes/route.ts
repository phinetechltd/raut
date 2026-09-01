import { z } from "zod";

import { handler, parseBody } from "@/lib/api";
import { db } from "@/lib/db";
import { companyIdOf } from "@/lib/tenant";
import { createCreditNote, listCreditNotes } from "@/server/credit-notes";
import { queueCreditNote, transmitCreditNote } from "@/server/etims";

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

export const POST = handler(
  { permission: "creditnote:write" },
  async ({ principal, request }) => {
    const body = await parseBody(request, Body);
    const companyId = companyIdOf(principal);

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
    await transmitCreditNote(note.id, companyId).catch(() => {});

    // Re-read: `note` was captured before transmission, so returning it would
    // report the credit as unfiled even when KRA has just accepted it.
    const filed = await db.creditNote.findUniqueOrThrow({ where: { id: note.id } });

    return { creditNote: filed };
  },
);
