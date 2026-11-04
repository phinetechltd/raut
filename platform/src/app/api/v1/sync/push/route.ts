import { z } from "zod";

import { ApiError, handler, parseBody } from "@/lib/api";
import { auditAs } from "@/lib/audit";
import { db } from "@/lib/db";
import { nextNumber } from "@/lib/numbering";
import { GATEWAY_METHODS } from "@/lib/payments";
import { denialReason, type Permission } from "@/lib/rbac";
import { companyIdOf } from "@/lib/tenant";
import { checkIn, checkOut } from "@/server/field";
import { markDelivered } from "@/server/delivery";
import { recordOdometer } from "@/server/routing";
import { createInvoice, createSalesOrder, notifyPayment, recordPayment } from "@/server/sales";
import { storePings } from "@/server/tracking";

export const dynamic = "force-dynamic";

/**
 * Batched offline write drain.
 *
 * The field app queues mutations while offline and drains them here in one
 * request. Three properties matter and are enforced below:
 *
 *  1. **Idempotent.** Every operation carries a client UUID. A replayed batch
 *     resolves to the already-created record instead of a duplicate — the
 *     single most important guarantee in the whole sync design, because reps
 *     work in exactly the conditions that cause retries.
 *
 *  2. **Independently fallible.** One bad operation must not reject the batch.
 *     Each is applied separately and reported on; the client clears what
 *     succeeded and keeps what failed.
 *
 *  3. **Ordered.** Operations apply in the order the rep performed them, so a
 *     payment recorded against an order created minutes earlier in the same
 *     batch resolves correctly.
 */

const lineSchema = z.object({
  productId: z.string(),
  /// The selling unit, so a carton sold in the field stays a carton.
  variantId: z.string().optional(),
  quantity: z.number().int().positive(),
  unitPriceCents: z.number().int().nonnegative().optional(),
  discountCents: z.number().int().nonnegative().optional(),
  description: z.string().optional(),
});

const operationSchema = z.object({
  /** Client-generated UUID; the operation's identity across retries. */
  uuid: z.string().min(8),
  type: z.enum([
    "visit.checkin",
    "visit.checkout",
    "visit.create",
    "order.create",
    "invoice.create",
    "payment.create",
    "customer.create",
    "customer.update",
    "activity.create",
    "expense.create",
    "location.batch",
    "route.odometer",
    "delivery.deliver",
  ]),
  /** Client timestamp of when the rep performed the action. */
  at: z.string().optional(),
  payload: z.record(z.unknown()),
});

const bodySchema = z.object({
  deviceId: z.string().optional(),
  operations: z.array(operationSchema).max(200),
});

interface OpResult {
  uuid: string;
  status: "applied" | "duplicate" | "failed";
  entityId?: string;
  entityType?: string;
  error?: string;
  /**
   * Set when the operation was refused rather than broken. A handset treats
   * these as permanent — retrying cannot help until someone changes the role
   * or the licence — and shows them to the rep instead of silently retrying.
   */
  code?: "FORBIDDEN" | "MODULE_NOT_LICENSED";
}

/**
 * The permission each operation needs — the same one its REST twin demands.
 *
 * This endpoint used to check only that the caller was signed in, so every
 * role could push every operation: a storekeeper could raise invoices, record
 * payments against a customer's balance and move a shop's GPS pin, and a
 * company that had not licensed Sales could invoice through sync. `can` checks
 * the role and the owning module together, which closes both.
 */
const OPERATION_PERMISSION: Record<z.infer<typeof operationSchema>["type"], Permission> = {
  "visit.create": "visit:write",
  "visit.checkin": "visit:write",
  "visit.checkout": "visit:write",
  "order.create": "order:write",
  "invoice.create": "invoice:write",
  "payment.create": "payment:write",
  "customer.create": "customer:write",
  "customer.update": "customer:write",
  "activity.create": "activity:write",
  "expense.create": "expense:write",
  "location.batch": "field:self",
  // The rep reads the dash of the van they are driving; it is their own
  // field record, like a breadcrumb, not a route edit.
  "route.odometer": "field:self",
  "delivery.deliver": "delivery:write",
};

export const POST = handler({}, async ({ principal, request }) => {
  const companyId = companyIdOf(principal);
  const body = await parseBody(request, bodySchema);

  const results: OpResult[] = [];

  for (const op of body.operations) {
    // Idempotency check first: a replay must not even re-enter the work.
    const seen = await db.idempotencyKey.findUnique({ where: { key: op.uuid } });
    if (seen) {
      results.push({
        uuid: op.uuid,
        status: "duplicate",
        entityId: seen.entityId ?? undefined,
        entityType: seen.entityType ?? undefined,
      });
      continue;
    }

    // After the idempotency check, not before: work that was accepted must
    // still resolve on replay even if the rep's role has changed since.
    const denied = denialReason(principal, OPERATION_PERMISSION[op.type]);
    if (denied) {
      results.push({
        uuid: op.uuid,
        status: "failed",
        code: denied === "module" ? "MODULE_NOT_LICENSED" : "FORBIDDEN",
        error:
          denied === "module"
            ? "Your company's subscription does not include this"
            : "Your role does not permit this action",
      });
      continue;
    }

    try {
      const outcome = await applyOperation(principal, companyId, op);
      // The work has committed. A failure to record the key must not turn
      // into a "failed" result — the handset would retry a write that
      // already happened. Log it and report the truth: applied.
      try {
        await db.idempotencyKey.create({
          data: {
            key: op.uuid,
            userId: principal.userId,
            endpoint: op.type,
            response: JSON.stringify(outcome),
            entityType: outcome.entityType,
            entityId: outcome.entityId,
          },
        });
      } catch (keyError) {
        console.error("[sync] applied but could not record idempotency key", op.uuid, keyError);
      }
      results.push({ uuid: op.uuid, status: "applied", ...outcome });
    } catch (error) {
      results.push({
        uuid: op.uuid,
        status: "failed",
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  if (body.deviceId) {
    await db.device
      .updateMany({
        where: { deviceId: body.deviceId, userId: principal.userId },
        data: { lastSyncAt: new Date(), lastSeenAt: new Date() },
      })
      .catch(() => undefined);
  }

  const applied = results.filter((r) => r.status === "applied").length;
  const failed = results.filter((r) => r.status === "failed").length;
  const refused = results.filter((r) => r.code).length;

  await auditAs(
    principal,
    "SYNC",
    "SyncBatch",
    body.deviceId ?? null,
    { total: results.length, applied, failed, refused },
    request,
  );

  return {
    syncedAt: new Date().toISOString(),
    summary: {
      total: results.length,
      applied,
      duplicates: results.filter((r) => r.status === "duplicate").length,
      failed,
    },
    results,
  };
});

/**
 * Resolves a client-supplied customer id **within the caller's tenant**.
 *
 * Ids arriving in a sync payload come from a handset, so they are input, not
 * authority. Without this, a device signed in to one company could attach its
 * writes to another company's customer — and `customer.update`, which keys off
 * the id alone, would happily rewrite that customer's contact details and GPS
 * pin. Scoping the lookup by companyId makes a foreign id indistinguishable
 * from a missing one, which is the same stance the REST layer takes.
 */
/**
 * The same rule for optional references: a territory or expense category named
 * by a handset must belong to the caller's company. Absent stays absent; a
 * foreign or unknown id is refused rather than silently linked.
 */
async function idInTenant(
  model: "territory" | "expenseCategory",
  companyId: string,
  id: string | undefined,
): Promise<string | null> {
  if (!id) return null;
  const where = { id, companyId };
  const found =
    model === "territory"
      ? await db.territory.findFirst({ where, select: { id: true } })
      : await db.expenseCategory.findFirst({ where, select: { id: true } });
  if (!found) throw new Error(`${model === "territory" ? "Territory" : "Expense category"} ${id} not found`);
  return found.id;
}

async function customerInTenant(companyId: string, id: unknown): Promise<string> {
  const customerId = String(id ?? "");
  const found = await db.customer.findFirst({
    where: { id: customerId, companyId },
    select: { id: true },
  });
  if (!found) throw new Error(`Customer ${customerId} not found`);
  return found.id;
}

async function applyOperation(
  principal: { userId: string; enabledModules: Set<string>; branchId?: string | null },
  companyId: string,
  op: z.infer<typeof operationSchema>,
): Promise<{ entityId: string; entityType: string }> {
  const p = op.payload as Record<string, never>;
  const at = op.at ? new Date(op.at) : undefined;
  const str = (k: string) => (p[k] != null ? String(p[k]) : undefined);
  const num = (k: string) => (p[k] != null ? Number(p[k]) : undefined);

  switch (op.type) {
    case "visit.create": {
      const visit = await db.visit.create({
        data: {
          companyId,
          customerId: await customerInTenant(companyId, p.customerId),
          repId: principal.userId,
          status: "SCHEDULED",
          purpose: str("purpose") ?? "SALES",
          scheduledAt: str("scheduledAt") ? new Date(String(p.scheduledAt)) : new Date(),
          notes: str("notes") ?? null,
          clientUuid: op.uuid,
        },
      });
      return { entityId: visit.id, entityType: "Visit" };
    }

    case "visit.checkin": {
      const result = await checkIn({
        visitId: String(p.visitId),
        companyId,
        userId: principal.userId,
        latitude: Number(p.latitude),
        longitude: Number(p.longitude),
        accuracyM: num("accuracyM") ?? null,
        at,
        geofencingEnabled: principal.enabledModules.has("GEOFENCING"),
      });
      return { entityId: result.visit.id, entityType: "Visit" };
    }

    case "visit.checkout": {
      const visit = await checkOut({
        visitId: String(p.visitId),
        companyId,
        userId: principal.userId,
        latitude: num("latitude") ?? null,
        longitude: num("longitude") ?? null,
        outcome: str("outcome") ?? null,
        notes: str("notes") ?? null,
        at,
      });
      return { entityId: visit.id, entityType: "Visit" };
    }

    case "order.create": {
      const order = await createSalesOrder({
        companyId,
        customerId: await customerInTenant(companyId, p.customerId),
        branchId: principal.branchId ?? null,
        lines: z.array(lineSchema).parse(p.lines),
        channel: "FIELD",
        visitId: str("visitId") ?? null,
        note: str("note") ?? null,
        clientUuid: op.uuid,
        createdById: principal.userId,
        confirm: true,
      });
      return { entityId: order.id, entityType: "SalesOrder" };
    }

    case "invoice.create": {
      const invoice = await createInvoice({
        companyId,
        customerId: await customerInTenant(companyId, p.customerId),
        branchId: principal.branchId ?? null,
        locationId: str("locationId") ?? null,
        orderId: str("orderId") ?? null,
        lines: z.array(lineSchema).parse(p.lines),
        channel: "FIELD",
        visitId: str("visitId") ?? null,
        note: str("note") ?? null,
        clientUuid: op.uuid,
        createdById: principal.userId,
        issue: true,
      });
      return { entityId: invoice.id, entityType: "Invoice" };
    }

    case "payment.create": {
      // A handset records money it was handed; it never books a gateway
      // collection. Those methods belong to settleIntent, which books under an
      // `intent:` uuid — so neither the method nor that uuid shape may arrive
      // from a device. 422 is permanent: retrying cannot make it valid.
      const pushedMethod = str("method") ?? "CASH";
      if (GATEWAY_METHODS.has(pushedMethod) || op.uuid.startsWith("intent:")) {
        throw new ApiError(
          422,
          "INVALID_METHOD",
          `${pushedMethod} payments are booked by the gateway when it confirms the collection, not from the handset`,
        );
      }
      const { payment, customer } = await recordPayment({
        companyId,
        customerId: await customerInTenant(companyId, p.customerId),
        amountCents: Number(p.amountCents),
        method: pushedMethod,
        reference: str("reference") ?? null,
        paidAt: at,
        note: str("note") ?? null,
        visitId: str("visitId") ?? null,
        clientUuid: op.uuid,
        createdById: principal.userId,
      });

      // Outside the transaction on purpose: a provider timeout must not undo
      // a payment the rep has already collected in cash.
      await notifyPayment({
        companyId,
        customerId: customer.id,
        amountCents: payment.amountCents,
        balanceCents: customer.balanceCents,
        phone: customer.phone,
        customerName: customer.name,
      });

      return { entityId: payment.id, entityType: "Payment" };
    }

    case "customer.create": {
      // Validated before anything is written or numbered. `String(p.name)` on
      // a payload without a name created a customer called "undefined".
      const name = z.string().trim().min(1, "A customer needs a name").parse(p.name);
      const territoryId = await idInTenant("territory", companyId, str("territoryId"));
      // The code is numbered inside the same transaction as the row, so a
      // failed insert burns no number and two reps cannot be handed the same.
      const customer = await db.$transaction(async (tx) => {
        const code = str("code") ?? (await nextNumber(companyId, "CUSTOMER", tx));
        return tx.customer.create({
          data: {
            companyId,
            code,
            name,
            type: str("type") ?? "RETAIL",
            phone: str("phone") ?? null,
            email: str("email") ?? null,
            address: str("address") ?? null,
            town: str("town") ?? null,
            latitude: num("latitude") ?? null,
            longitude: num("longitude") ?? null,
            territoryId,
            assignedRepId: principal.userId,
            notes: str("notes") ?? null,
            createdById: principal.userId,
          },
        });
      });
      return { entityId: customer.id, entityType: "Customer" };
    }

    case "customer.update": {
      // Reps may correct contact details and drop a GPS pin, nothing more —
      // credit limits and terms stay a back-office decision.
      const customer = await db.customer.update({
        where: { id: await customerInTenant(companyId, p.id) },
        data: {
          phone: str("phone"),
          email: str("email"),
          address: str("address"),
          town: str("town"),
          latitude: num("latitude"),
          longitude: num("longitude"),
          notes: str("notes"),
        },
      });
      return { entityId: customer.id, entityType: "Customer" };
    }

    case "activity.create": {
      const activity = await db.customerActivity.create({
        data: {
          companyId,
          customerId: await customerInTenant(companyId, p.customerId),
          userId: principal.userId,
          type: str("type") ?? "NOTE",
          subject: String(p.subject),
          body: str("body") ?? null,
          status: str("status") ?? "DONE",
          dueAt: str("dueAt") ? new Date(String(p.dueAt)) : null,
        },
      });
      return { entityId: activity.id, entityType: "CustomerActivity" };
    }

    case "expense.create": {
      const description = z
        .string()
        .trim()
        .min(1, "An expense needs a description")
        .parse(p.description);
      const amountCents = z
        .number()
        .int()
        .positive("An expense needs an amount above zero")
        .parse(p.amountCents);
      // The category decides which ledger account the expense posts to, so a
      // foreign id would book this company's spend against another's chart.
      const categoryId = await idInTenant("expenseCategory", companyId, str("categoryId"));
      // Number and row in one transaction — see customer.create.
      const expense = await db.$transaction(async (tx) => {
        const number = await nextNumber(companyId, "EXPENSE", tx);
        return tx.expense.create({
          data: {
            companyId,
            branchId: principal.branchId ?? null,
            categoryId,
            userId: principal.userId,
            number,
            description,
            amountCents,
            status: "SUBMITTED",
            incurredAt: at ?? new Date(),
            paymentMethod: str("paymentMethod") ?? "CASH",
            latitude: num("latitude") ?? null,
            longitude: num("longitude") ?? null,
            clientUuid: op.uuid,
          },
        });
      });
      return { entityId: expense.id, entityType: "Expense" };
    }

    case "location.batch": {
      // Background breadcrumbs arrive in bulk; a whole batch is one operation
      // so a day of tracking does not exhaust the 200-op batch limit.
      // `nullish`, not `optional`. A handset reads these from SQLite columns
      // that are frequently NULL — a stationary phone reports no speed or
      // heading — and serialises them as explicit nulls. `optional()` accepts
      // a missing key but rejects `null`, so every batch failed validation and
      // the whole day's breadcrumbs were refused, over and over, with nothing
      // on screen to say so.
      const pings = z
        .array(
          z.object({
            latitude: z.number(),
            longitude: z.number(),
            accuracyM: z.number().nullish(),
            speedMps: z.number().nullish(),
            heading: z.number().nullish(),
            batteryPct: z.number().nullish(),
            isMoving: z.boolean().nullish(),
            recordedAt: z.string(),
          }),
        )
        .parse(p.pings);

      // Stamped with the rep's route and vehicle for the day, and deduplicated
      // on (rep, instant): the handset's synthetic batch uuid changes on every
      // retry, so the idempotency table above cannot catch a resent trail —
      // the unique key on the rows themselves does.
      await storePings(
        companyId,
        principal.userId,
        pings.map((ping) => ({ ...ping, recordedAt: new Date(ping.recordedAt) })),
      );

      return { entityId: op.uuid, entityType: "LocationPing" };
    }

    case "route.odometer": {
      // Start and finish readings off the dash, queued offline like any other
      // field write. A rep may only report against their own route.
      const routeId = z.string().min(1).parse(p.routeId);
      const own = await db.route.findFirst({
        where: { id: routeId, companyId, repId: principal.userId },
        select: { id: true },
      });
      if (!own) throw new Error(`Route ${routeId} not found`);
      const reading = z
        .object({
          odometerStartKm: z.number().int().nonnegative().nullish(),
          odometerEndKm: z.number().int().nonnegative().nullish(),
        })
        .parse({ odometerStartKm: p.odometerStartKm, odometerEndKm: p.odometerEndKm });
      const route = await recordOdometer({
        routeId,
        companyId,
        ...(reading.odometerStartKm !== undefined ? { odometerStartKm: reading.odometerStartKm } : {}),
        ...(reading.odometerEndKm !== undefined ? { odometerEndKm: reading.odometerEndKm } : {}),
      });
      return { entityId: route.id, entityType: "Route" };
    }

    case "delivery.deliver": {
      // The rep confirms a drop from the handset. Only a note they raised or
      // are the named driver on; a foreign id is not found, not forbidden.
      const deliveryNoteId = z.string().min(1).parse(p.deliveryNoteId);
      const own = await db.deliveryNote.findFirst({
        where: {
          id: deliveryNoteId,
          companyId,
          OR: [{ createdById: principal.userId }, { deliveredById: principal.userId }],
        },
        select: { id: true },
      });
      if (!own) throw new Error(`Delivery note ${deliveryNoteId} not found`);
      const note = await markDelivered(
        companyId,
        deliveryNoteId,
        {
          receivedByName: z.string().min(1).parse(p.receivedByName),
          receivedByPhone: str("receivedByPhone") ?? null,
          receivedBySignature: str("receivedBySignature") ?? null,
          deliveredAt: at ?? null,
          deliveredById: principal.userId,
          notes: str("notes") ?? null,
        },
        principal.userId,
      );
      return { entityId: note.id, entityType: "DeliveryNote" };
    }

    default:
      throw new Error(`Unsupported operation type: ${op.type}`);
  }
}
