import { z } from "zod";

import { handler, ok, pagination, paginationMeta, parseBody, withIdempotency } from "@/lib/api";
import { db } from "@/lib/db";
import { companyIdOf } from "@/lib/tenant";
import {
  DELIVERY_NOTE_INCLUDE,
  DELIVERY_STATUSES,
  createDeliveryNote,
  deliveryScope,
} from "@/server/delivery";

export const dynamic = "force-dynamic";

/**
 * Delivery notes: the paper that travels with the goods.
 *
 * `GET` lists the company's notes newest first, with `?status=`, `?q=` (number,
 * customer, invoice or order number), `?invoiceId=`, `?orderId=`, and the usual
 * `page`/`limit`. A field rep sees the notes they raised or are driving.
 */
export const GET = handler({ permission: "delivery:read" }, async ({ principal, searchParams }) => {
  const page = pagination(searchParams);
  const status = searchParams.get("status");
  const q = searchParams.get("q")?.trim();
  const invoiceId = searchParams.get("invoiceId");
  const orderId = searchParams.get("orderId");

  const where = {
    ...deliveryScope(principal),
    ...(status && (DELIVERY_STATUSES as readonly string[]).includes(status) ? { status } : {}),
    ...(invoiceId ? { invoiceId } : {}),
    ...(orderId ? { orderId } : {}),
    ...(q
      ? {
          AND: [
            {
              OR: [
                { number: { contains: q } },
                { customer: { name: { contains: q } } },
                { invoice: { number: { contains: q } } },
                { order: { number: { contains: q } } },
              ],
            },
          ],
        }
      : {}),
  };

  const [items, total] = await Promise.all([
    db.deliveryNote.findMany({
      where,
      include: DELIVERY_NOTE_INCLUDE,
      orderBy: [{ issueDate: "desc" }, { number: "desc" }],
      take: page.take,
      skip: page.skip,
    }),
    db.deliveryNote.count({ where }),
  ]);

  return ok(items, paginationMeta(page, total));
});

const Body = z
  .object({
    invoiceId: z.string().min(1).optional(),
    orderId: z.string().min(1).optional(),
    lines: z
      .array(
        z.object({
          invoiceLineId: z.string().min(1).optional(),
          orderLineId: z.string().min(1).optional(),
          deliveredQty: z.number().int().nonnegative().optional(),
          note: z.string().max(500).optional(),
        }),
      )
      .optional(),
    locationId: z.string().optional(),
    deliveredById: z.string().optional(),
    vehicleId: z.string().optional(),
    routeId: z.string().optional(),
    visitId: z.string().optional(),
    deliveryAddress: z.string().max(500).optional(),
    notes: z.string().max(2000).optional(),
    issue: z.boolean().optional(),
    clientUuid: z.string().optional(),
  })
  .refine((b) => b.invoiceId || b.orderId, {
    message: "invoiceId or orderId is required",
    path: ["invoiceId"],
  });

/**
 * Raises a delivery note from an invoice or an order.
 *
 * Quantities default to whatever each line still has undelivered, so the
 * common case — everything goes out in one trip — is a two-field request.
 * Over-delivery is refused with a 409 that names the line. Replay-safe on
 * `clientUuid` like every other mobile write.
 */
export const POST = handler({ permission: "delivery:write" }, async ({ principal, request }) => {
  const body = await parseBody(request, Body);
  const companyId = companyIdOf(principal);

  const { data, replayed } = await withIdempotency(
    principal,
    body.clientUuid,
    "delivery-notes",
    async () => {
      const note = await createDeliveryNote({
        companyId,
        invoiceId: body.invoiceId ?? null,
        orderId: body.orderId ?? null,
        lines: body.lines,
        locationId: body.locationId ?? null,
        deliveredById: body.deliveredById ?? (principal.role === "FIELD_REP" ? principal.userId : null),
        vehicleId: body.vehicleId ?? null,
        routeId: body.routeId ?? null,
        visitId: body.visitId ?? null,
        branchId: principal.branchId ?? null,
        deliveryAddress: body.deliveryAddress ?? null,
        notes: body.notes ?? null,
        issue: body.issue,
        clientUuid: body.clientUuid ?? null,
        createdById: principal.userId,
      });
      const full = await db.deliveryNote.findUniqueOrThrow({
        where: { id: note.id },
        include: DELIVERY_NOTE_INCLUDE,
      });
      return { id: full.id, deliveryNote: full };
    },
  );

  return ok(
    { deliveryNote: data.deliveryNote },
    replayed ? { replayed: true } : undefined,
    { status: replayed ? 200 : 201 },
  );
});
