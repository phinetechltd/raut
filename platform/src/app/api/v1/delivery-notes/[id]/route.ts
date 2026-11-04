import { z } from "zod";

import { badRequest, handler, notFound, parseBody, parseDate } from "@/lib/api";
import { db } from "@/lib/db";
import { companyIdOf } from "@/lib/tenant";
import {
  DELIVERY_NOTE_INCLUDE,
  cancelDeliveryNote,
  deliveryScope,
  issueDeliveryNote,
  markDelivered,
  markReturned,
} from "@/server/delivery";

export const dynamic = "force-dynamic";

/**
 * One delivery note. Scoped by the principal's company (and, for a rep, to
 * the notes they raised or are driving), so another tenant's id is not found
 * rather than forbidden.
 */
export const GET = handler<{ id: string }>(
  { permission: "delivery:read" },
  async ({ principal, params }) => {
    const note = await db.deliveryNote.findFirst({
      where: { id: params.id, ...deliveryScope(principal) },
      include: DELIVERY_NOTE_INCLUDE,
    });
    if (!note) throw notFound("Delivery note not found");
    return { deliveryNote: note };
  },
);

const Patch = z.discriminatedUnion("action", [
  z.object({ action: z.literal("issue") }),
  z.object({
    action: z.literal("deliver"),
    receivedByName: z.string().min(1).max(120),
    receivedByPhone: z.string().max(40).optional(),
    /** A typed name or a data: URL of the drawn signature. */
    receivedBySignature: z.string().max(200_000).optional(),
    deliveredAt: z.string().optional(),
    deliveredById: z.string().optional(),
    notes: z.string().max(2000).optional(),
  }),
  z.object({
    action: z.literal("return"),
    lines: z.array(z.object({ lineId: z.string().min(1), returnedQty: z.number().int().nonnegative() })).min(1),
    notes: z.string().max(2000).optional(),
  }),
  z.object({ action: z.literal("cancel") }),
]);

/**
 * Moves a note through its lifecycle.
 *
 *   { action: "issue" }                      DRAFT → ISSUED
 *   { action: "deliver", receivedByName, …}  DRAFT|ISSUED → DELIVERED
 *   { action: "return", lines: [...] }       DELIVERED → RETURNED
 *   { action: "cancel" }                     DRAFT|ISSUED → CANCELLED
 *
 * Anything out of order is a 409 naming the current status. The note itself
 * is never edited in place: what went out is what the customer signed for.
 */
export const PATCH = handler<{ id: string }>(
  { permission: "delivery:write" },
  async ({ principal, params, request }) => {
    const companyId = companyIdOf(principal);
    const body = await parseBody(request, Patch);

    // The scope check happens here, before the service's own company check,
    // so a rep cannot advance a colleague's note by guessing its id.
    const owned = await db.deliveryNote.findFirst({
      where: { id: params.id, ...deliveryScope(principal) },
      select: { id: true },
    });
    if (!owned) throw notFound("Delivery note not found");

    switch (body.action) {
      case "issue":
        await issueDeliveryNote(companyId, params.id, principal.userId);
        break;
      case "deliver":
        await markDelivered(
          companyId,
          params.id,
          {
            receivedByName: body.receivedByName,
            receivedByPhone: body.receivedByPhone ?? null,
            receivedBySignature: body.receivedBySignature ?? null,
            deliveredAt: parseDate(body.deliveredAt),
            deliveredById:
              body.deliveredById ?? (principal.role === "FIELD_REP" ? principal.userId : null),
            notes: body.notes,
          },
          principal.userId,
        );
        break;
      case "return":
        await markReturned(companyId, params.id, { lines: body.lines, notes: body.notes }, principal.userId);
        break;
      case "cancel":
        await cancelDeliveryNote(companyId, params.id, principal.userId);
        break;
      default:
        throw badRequest("Unknown action");
    }

    const note = await db.deliveryNote.findUniqueOrThrow({
      where: { id: params.id },
      include: DELIVERY_NOTE_INCLUDE,
    });
    return { deliveryNote: note };
  },
);
