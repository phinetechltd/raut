import { z } from "zod";

import { handler, parseBody } from "@/lib/api";
import { auditAs } from "@/lib/audit";
import { db } from "@/lib/db";
import { nextNumber } from "@/lib/numbering";
import { companyIdOf } from "@/lib/tenant";
import { checkIn, checkOut } from "@/server/field";
import { createInvoice, createSalesOrder, notifyPayment, recordPayment } from "@/server/sales";

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
}

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

    try {
      const outcome = await applyOperation(principal, companyId, op);
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

  await auditAs(
    principal,
    "SYNC",
    "SyncBatch",
    body.deviceId ?? null,
    { total: results.length, applied, failed },
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
      const { payment, customer } = await recordPayment({
        companyId,
        customerId: await customerInTenant(companyId, p.customerId),
        amountCents: Number(p.amountCents),
        method: str("method") ?? "CASH",
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
      const code = str("code") ?? (await nextNumber(companyId, "CUSTOMER"));
      const customer = await db.customer.create({
        data: {
          companyId,
          code,
          name: String(p.name),
          type: str("type") ?? "RETAIL",
          phone: str("phone") ?? null,
          email: str("email") ?? null,
          address: str("address") ?? null,
          town: str("town") ?? null,
          latitude: num("latitude") ?? null,
          longitude: num("longitude") ?? null,
          territoryId: str("territoryId") ?? null,
          assignedRepId: principal.userId,
          notes: str("notes") ?? null,
          createdById: principal.userId,
        },
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
      const number = await nextNumber(companyId, "EXPENSE");
      const expense = await db.expense.create({
        data: {
          companyId,
          branchId: principal.branchId ?? null,
          categoryId: str("categoryId") ?? null,
          userId: principal.userId,
          number,
          description: String(p.description),
          amountCents: Number(p.amountCents),
          status: "SUBMITTED",
          incurredAt: at ?? new Date(),
          paymentMethod: str("paymentMethod") ?? "CASH",
          latitude: num("latitude") ?? null,
          longitude: num("longitude") ?? null,
          clientUuid: op.uuid,
        },
      });
      return { entityId: expense.id, entityType: "Expense" };
    }

    case "location.batch": {
      // Background breadcrumbs arrive in bulk; a whole batch is one operation
      // so a day of tracking does not exhaust the 200-op batch limit.
      const pings = z
        .array(
          z.object({
            latitude: z.number(),
            longitude: z.number(),
            accuracyM: z.number().optional(),
            speedMps: z.number().optional(),
            heading: z.number().optional(),
            batteryPct: z.number().optional(),
            isMoving: z.boolean().optional(),
            recordedAt: z.string(),
          }),
        )
        .parse(p.pings);

      await db.locationPing.createMany({
        data: pings.map((ping) => ({
          companyId,
          userId: principal.userId,
          latitude: ping.latitude,
          longitude: ping.longitude,
          accuracyM: ping.accuracyM != null ? Math.round(ping.accuracyM) : null,
          speedMps: ping.speedMps ?? null,
          heading: ping.heading ?? null,
          batteryPct: ping.batteryPct != null ? Math.round(ping.batteryPct) : null,
          isMoving: ping.isMoving ?? true,
          recordedAt: new Date(ping.recordedAt),
        })),
      });

      return { entityId: op.uuid, entityType: "LocationPing" };
    }

    default:
      throw new Error(`Unsupported operation type: ${op.type}`);
  }
}
