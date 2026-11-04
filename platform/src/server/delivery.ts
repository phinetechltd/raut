import "server-only";

import type { Prisma, PrismaClient } from "@prisma/client";

import { badRequest, conflict, notFound } from "@/lib/api";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { nextNumber } from "@/lib/numbering";
import type { Principal } from "@/lib/rbac";

/**
 * Delivery notes.
 *
 * A delivery note is the paper that travels with the goods and comes back
 * signed. It is a **dispatch and acknowledgement record, not a stock
 * document**: stock leaves the shelf when the invoice is issued (see
 * `applyIssueConsequences` in ./sales), so a note raised against an issued
 * invoice moves nothing, and a note raised against an order that has not been
 * invoiced yet moves nothing either — the invoice that follows will. What the
 * note records is what physically went out on this trip, who signed for it,
 * and what came straight back.
 *
 * Several notes may cover one invoice or order — a split delivery is the
 * normal case for a distributor — so every quantity is checked against what
 * the source line still has undelivered across the other, uncancelled notes.
 * A returned quantity is treated as not delivered: it can go out again on a
 * later note, or be credited back with a credit note, which is a separate
 * document with its own rules.
 *
 * Lifecycle: DRAFT → ISSUED → DELIVERED → RETURNED, with CANCELLED reachable
 * from DRAFT and ISSUED only. A note the customer has signed for is a fact;
 * it is corrected with a return or a credit note, never deleted.
 */

type Tx = Prisma.TransactionClient;
type Client = Tx | PrismaClient;

export const DELIVERY_STATUSES = ["DRAFT", "ISSUED", "DELIVERED", "RETURNED", "CANCELLED"] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

/** Statuses whose quantities count as "out of the door". */
const COUNTED = ["DRAFT", "ISSUED", "DELIVERED", "RETURNED"];

// ── remaining quantities ───────────────────────────────────────────────

export interface Remaining {
  /** Net delivered so far across uncancelled notes: delivered − returned. */
  delivered: number;
  /** ordered − delivered, never negative. */
  remaining: number;
}

/**
 * How much of each source line is still undelivered.
 *
 * One query for all the lines a caller cares about, so the dialog that lists
 * sixty open invoices does not fire sixty queries. Cancelled notes are
 * excluded because they never went out; returned goods are subtracted because
 * they came back.
 */
export async function remainingBySourceLine(
  client: Client,
  companyId: string,
  source:
    | { invoiceLineIds: string[]; ordered: Map<string, number> }
    | { orderLineIds: string[]; ordered: Map<string, number> },
): Promise<Map<string, Remaining>> {
  const byInvoice = "invoiceLineIds" in source;
  const ids = byInvoice ? source.invoiceLineIds : source.orderLineIds;
  const out = new Map<string, Remaining>();
  if (ids.length === 0) return out;

  const rows = await client.deliveryNoteLine.findMany({
    where: {
      ...(byInvoice ? { invoiceLineId: { in: ids } } : { orderLineId: { in: ids } }),
      deliveryNote: { companyId, status: { in: COUNTED } },
    },
    select: { invoiceLineId: true, orderLineId: true, deliveredQty: true, returnedQty: true },
  });

  const net = new Map<string, number>();
  for (const r of rows) {
    const key = byInvoice ? r.invoiceLineId : r.orderLineId;
    if (!key) continue;
    net.set(key, (net.get(key) ?? 0) + r.deliveredQty - r.returnedQty);
  }
  for (const id of ids) {
    const delivered = Math.max(0, net.get(id) ?? 0);
    const ordered = source.ordered.get(id) ?? 0;
    out.set(id, { delivered, remaining: Math.max(0, ordered - delivered) });
  }
  return out;
}

// ── create ─────────────────────────────────────────────────────────────

export interface CreateDeliveryNoteInput {
  companyId: string;
  /** At least one of these. When both are set the invoice is the source. */
  invoiceId?: string | null;
  orderId?: string | null;
  /**
   * Which source lines go out, and how many of each. Omitted entirely, every
   * line goes out at whatever it still has undelivered. A line listed with a
   * quantity of zero is left off the note.
   */
  lines?: Array<{
    invoiceLineId?: string;
    orderLineId?: string;
    deliveredQty?: number;
    note?: string | null;
  }>;
  locationId?: string | null;
  deliveredById?: string | null;
  vehicleId?: string | null;
  routeId?: string | null;
  visitId?: string | null;
  branchId?: string | null;
  /** Overrides the customer's address snapshot. */
  deliveryAddress?: string | null;
  notes?: string | null;
  /** Issue at once (the default) or hold as a draft. */
  issue?: boolean;
  clientUuid?: string | null;
  createdById?: string | null;
}

interface SourceLine {
  id: string;
  productId: string;
  variantId: string | null;
  variantName: string | null;
  description: string;
  quantity: number;
  baseQuantity: number;
}

const positiveWhole = (n: unknown, what: string) => {
  if (!Number.isInteger(n) || (n as number) < 0) {
    throw badRequest(`${what} must be a whole number of zero or more`);
  }
  return n as number;
};

export async function createDeliveryNote(input: CreateDeliveryNoteInput) {
  if (!input.invoiceId && !input.orderId) {
    throw badRequest("A delivery note needs the invoice or the order it delivers");
  }

  const created = await db.$transaction(
    async (tx) => {
      // Resolve the source inside the transaction and take the write lock on
      // it first, so two notes raised against the same document at the same
      // moment see each other's quantities rather than both passing.
      let customerId: string;
      let locationId: string | null = input.locationId ?? null;
      let branchId: string | null = input.branchId ?? null;
      let orderId: string | null = input.orderId ?? null;
      let invoiceId: string | null = input.invoiceId ?? null;
      let sourceLines: SourceLine[];
      let remaining: Map<string, Remaining>;
      let byInvoice: boolean;

      if (invoiceId) {
        const locked = await tx.invoice.updateMany({
          where: { id: invoiceId, companyId: input.companyId },
          data: { updatedAt: new Date() },
        });
        if (locked.count === 0) throw notFound("Invoice not found");
        const invoice = await tx.invoice.findFirstOrThrow({
          where: { id: invoiceId, companyId: input.companyId },
          include: { lines: true },
        });
        if (invoice.status === "DRAFT") {
          throw conflict("Issue the invoice before raising a delivery note against it");
        }
        if (invoice.status === "CANCELLED") {
          throw conflict("This invoice is cancelled; nothing on it can be delivered");
        }
        if (orderId && invoice.orderId && orderId !== invoice.orderId) {
          throw badRequest("That order does not belong to this invoice");
        }
        customerId = invoice.customerId;
        locationId = locationId ?? invoice.locationId;
        branchId = branchId ?? invoice.branchId;
        orderId = orderId ?? invoice.orderId;
        sourceLines = invoice.lines;
        byInvoice = true;
        remaining = await remainingBySourceLine(tx, input.companyId, {
          invoiceLineIds: invoice.lines.map((l) => l.id),
          ordered: new Map(invoice.lines.map((l) => [l.id, l.quantity])),
        });
      } else {
        const locked = await tx.salesOrder.updateMany({
          where: { id: orderId!, companyId: input.companyId },
          data: { updatedAt: new Date() },
        });
        if (locked.count === 0) throw notFound("Order not found");
        const order = await tx.salesOrder.findFirstOrThrow({
          where: { id: orderId!, companyId: input.companyId },
          include: { lines: true },
        });
        if (order.status === "DRAFT") {
          throw conflict("Confirm the order before raising a delivery note against it");
        }
        if (order.status === "CANCELLED") {
          throw conflict("This order is cancelled; nothing on it can be delivered");
        }
        if (order.status === "INVOICED") {
          // The invoice is the document the goods now belong to, and its own
          // lines are what the delivery is checked against.
          throw conflict("This order has been invoiced; raise the delivery note from the invoice");
        }
        customerId = order.customerId;
        branchId = branchId ?? order.branchId;
        sourceLines = order.lines;
        byInvoice = false;
        remaining = await remainingBySourceLine(tx, input.companyId, {
          orderLineIds: order.lines.map((l) => l.id),
          ordered: new Map(order.lines.map((l) => [l.id, l.quantity])),
        });
      }

      // Everything the note points at must be this company's. A foreign id is
      // indistinguishable from a missing one, by design.
      if (locationId) {
        const loc = await tx.stockLocation.findFirst({
          where: { id: locationId, companyId: input.companyId },
          select: { id: true },
        });
        if (!loc) throw notFound("Stock location not found");
      }
      if (input.vehicleId) {
        const v = await tx.vehicle.findFirst({
          where: { id: input.vehicleId, companyId: input.companyId },
          select: { id: true },
        });
        if (!v) throw notFound("Vehicle not found");
      }
      if (input.routeId) {
        const r = await tx.route.findFirst({
          where: { id: input.routeId, companyId: input.companyId },
          select: { id: true },
        });
        if (!r) throw notFound("Route not found");
      }
      if (input.deliveredById) {
        const u = await tx.user.findFirst({
          where: { id: input.deliveredById, companyId: input.companyId },
          select: { id: true },
        });
        if (!u) throw notFound("Delivering user not found");
      }

      const customer = await tx.customer.findFirstOrThrow({
        where: { id: customerId, companyId: input.companyId },
        select: { address: true, town: true },
      });

      // Pick the lines. Each source line may appear once; a repeated line
      // would be checked against earlier notes but not against its twin.
      const requested = input.lines;
      const seen = new Set<string>();
      const chosen: Array<{ line: SourceLine; qty: number; note: string | null }> = [];

      if (requested === undefined) {
        for (const line of sourceLines) {
          const qty = remaining.get(line.id)?.remaining ?? 0;
          if (qty > 0) chosen.push({ line, qty, note: null });
        }
      } else {
        for (const req of requested) {
          const key = byInvoice ? req.invoiceLineId : req.orderLineId;
          if (!key) {
            throw badRequest(
              byInvoice
                ? "Each line must name the invoice line it delivers"
                : "Each line must name the order line it delivers",
            );
          }
          if (seen.has(key)) throw badRequest("Each line can appear only once on a delivery note");
          seen.add(key);
          const line = sourceLines.find((l) => l.id === key);
          if (!line) {
            throw badRequest(byInvoice ? "That line is not on this invoice" : "That line is not on this order");
          }
          const left = remaining.get(line.id)?.remaining ?? 0;
          const qty = req.deliveredQty === undefined ? left : positiveWhole(req.deliveredQty, "Delivered quantity");
          if (qty > left) {
            throw conflict(
              `Cannot deliver ${qty} of ${line.description}: only ${left} remain undelivered`,
            );
          }
          if (qty > 0) chosen.push({ line, qty, note: req.note ?? null });
        }
      }

      if (chosen.length === 0) {
        throw conflict("Nothing left to deliver: every line has already gone out in full");
      }

      // Numbered inside the transaction, so a note that fails validation does
      // not burn a DN number.
      const number = await nextNumber(input.companyId, "DELIVERY_NOTE", tx);

      const address = input.deliveryAddress ?? [customer.address, customer.town].filter(Boolean).join(", ");

      const note = await tx.deliveryNote.create({
        data: {
          companyId: input.companyId,
          branchId,
          number,
          invoiceId,
          orderId,
          customerId,
          locationId,
          deliveredById: input.deliveredById ?? null,
          vehicleId: input.vehicleId ?? null,
          routeId: input.routeId ?? null,
          visitId: input.visitId ?? null,
          status: input.issue === false ? "DRAFT" : "ISSUED",
          deliveryAddress: address || null,
          notes: input.notes?.trim() || null,
          clientUuid: input.clientUuid ?? null,
          createdById: input.createdById ?? null,
          lines: {
            create: chosen.map(({ line, qty, note: lineNote }) => {
              // Base units per unit sold, mirroring the invoice line: one
              // carton delivered is twelve bottles out of the door.
              const perUnit = line.quantity > 0 ? (line.baseQuantity || line.quantity) / line.quantity : 1;
              return {
                productId: line.productId,
                invoiceLineId: byInvoice ? line.id : null,
                orderLineId: byInvoice ? null : line.id,
                variantId: line.variantId,
                variantName: line.variantName,
                description: line.description,
                orderedQty: line.quantity,
                deliveredQty: qty,
                baseQuantity: Math.round(qty * perUnit),
                note: lineNote,
              };
            }),
          },
        },
        include: { lines: true },
      });

      return note;
    },
    { timeout: 15_000 },
  );

  // After the commit, never inside it: the audit log writes through the shared
  // client, and SQLite has one writer, so a write from inside the transaction
  // waits on the transaction's own lock until it times out.
  await audit({
    companyId: input.companyId,
    userId: input.createdById ?? null,
    action: "CREATE",
    entity: "DeliveryNote",
    entityId: created.id,
    changes: {
      number: created.number,
      invoiceId: created.invoiceId,
      orderId: created.orderId,
      status: created.status,
      lines: created.lines.length,
    },
  });

  return created;
}

// ── transitions ────────────────────────────────────────────────────────

async function loadOwned(tx: Tx, companyId: string, id: string) {
  const note = await tx.deliveryNote.findFirst({
    where: { id, companyId },
    include: { lines: true },
  });
  if (!note) throw notFound("Delivery note not found");
  return note;
}

function expectStatus(note: { number: string; status: string }, allowed: DeliveryStatus[], verb: string) {
  if (!allowed.includes(note.status as DeliveryStatus)) {
    throw conflict(
      `Delivery note ${note.number} is ${note.status.toLowerCase().replace(/_/g, " ")} and cannot be ${verb}`,
    );
  }
}

/**
 * SQLite serialises writers, and these transactions touch the order and its
 * lines as well as the note. The 5 s default was enough to fail a legitimate
 * transition when the dev server was busy.
 */
const TX = { timeout: 15_000 } as const;

/** Called after the transaction has committed — see createDeliveryNote. */
async function transitionAudit(
  companyId: string,
  userId: string | null | undefined,
  noteId: string,
  from: string,
  to: string,
  extra?: Record<string, unknown>,
) {
  await audit({
    companyId,
    userId: userId ?? null,
    action: "UPDATE",
    entity: "DeliveryNote",
    entityId: noteId,
    changes: { status: { from, to }, ...(extra ?? {}) },
  });
}

/**
 * Rebuilds `SalesOrderLine.fulfilled` and the order's status from the notes
 * that have actually been delivered. Recomputed rather than incremented, so a
 * replayed or retried transition cannot double-count.
 *
 * Only an order that is still an order is touched. Once it is INVOICED the
 * invoice owns the goods, and a cancelled order is left as it is.
 */
async function syncOrderFulfilment(tx: Tx, companyId: string, orderId: string | null) {
  if (!orderId) return;
  const order = await tx.salesOrder.findFirst({
    where: { id: orderId, companyId },
    include: { lines: true },
  });
  if (!order) return;
  if (!["CONFIRMED", "PARTIALLY_FULFILLED", "FULFILLED"].includes(order.status)) return;

  const delivered = await tx.deliveryNoteLine.findMany({
    where: {
      orderLineId: { in: order.lines.map((l) => l.id) },
      deliveryNote: { companyId, orderId, status: { in: ["DELIVERED", "RETURNED"] } },
    },
    select: { orderLineId: true, deliveredQty: true, returnedQty: true },
  });
  const net = new Map<string, number>();
  for (const d of delivered) {
    if (!d.orderLineId) continue;
    net.set(d.orderLineId, (net.get(d.orderLineId) ?? 0) + d.deliveredQty - d.returnedQty);
  }

  let any = false;
  let all = true;
  for (const line of order.lines) {
    const fulfilled = Math.min(line.quantity, Math.max(0, net.get(line.id) ?? 0));
    if (fulfilled !== line.fulfilled) {
      await tx.salesOrderLine.update({ where: { id: line.id }, data: { fulfilled } });
    }
    if (fulfilled > 0) any = true;
    if (fulfilled < line.quantity) all = false;
  }

  const status = all && order.lines.length > 0 ? "FULFILLED" : any ? "PARTIALLY_FULFILLED" : "CONFIRMED";
  if (status !== order.status) {
    await tx.salesOrder.update({ where: { id: orderId }, data: { status } });
  }
}

/** DRAFT → ISSUED. */
export async function issueDeliveryNote(companyId: string, id: string, userId?: string | null) {
  const { updated, from } = await db.$transaction(async (tx) => {
    const note = await loadOwned(tx, companyId, id);
    expectStatus(note, ["DRAFT"], "issued");
    const updated = await tx.deliveryNote.update({
      where: { id: note.id },
      data: { status: "ISSUED", issueDate: new Date() },
      include: { lines: true },
    });
    return { updated, from: note.status };
  }, TX);
  await transitionAudit(companyId, userId, updated.id, from, "ISSUED");
  return updated;
}

export interface DeliverInput {
  /** Who took the goods. Required: an unsigned delivery is a dispatch, not a delivery. */
  receivedByName: string;
  receivedByPhone?: string | null;
  /** A typed name or a data: URL of the drawn signature. */
  receivedBySignature?: string | null;
  deliveredAt?: Date | null;
  /** The rep or driver who handed them over, when it was not already set. */
  deliveredById?: string | null;
  notes?: string | null;
}

/** DRAFT|ISSUED → DELIVERED. */
export async function markDelivered(
  companyId: string,
  id: string,
  input: DeliverInput,
  userId?: string | null,
) {
  const receivedBy = input.receivedByName?.trim();
  if (!receivedBy) throw badRequest("Record who received the goods");
  if (input.deliveredAt && Number.isNaN(input.deliveredAt.getTime())) {
    throw badRequest("Invalid delivery time");
  }
  if (input.deliveredAt && input.deliveredAt.getTime() > Date.now() + 5 * 60_000) {
    throw badRequest("A delivery cannot be recorded in the future");
  }

  const { updated, from } = await db.$transaction(async (tx) => {
    const note = await loadOwned(tx, companyId, id);
    expectStatus(note, ["DRAFT", "ISSUED"], "marked delivered");

    if (input.deliveredById) {
      const u = await tx.user.findFirst({
        where: { id: input.deliveredById, companyId },
        select: { id: true },
      });
      if (!u) throw notFound("Delivering user not found");
    }

    const updated = await tx.deliveryNote.update({
      where: { id: note.id },
      data: {
        status: "DELIVERED",
        deliveredAt: input.deliveredAt ?? new Date(),
        receivedByName: receivedBy,
        receivedByPhone: input.receivedByPhone?.trim() || null,
        receivedBySignature: input.receivedBySignature || null,
        deliveredById: input.deliveredById ?? note.deliveredById,
        notes: input.notes !== undefined ? input.notes?.trim() || null : note.notes,
      },
      include: { lines: true },
    });

    await syncOrderFulfilment(tx, companyId, note.invoiceId ? null : note.orderId);
    return { updated, from: note.status };
  }, TX);
  await transitionAudit(companyId, userId, updated.id, from, "DELIVERED", { receivedBy });
  return updated;
}

export interface ReturnInput {
  lines: Array<{ lineId: string; returnedQty: number }>;
  notes?: string | null;
}

/**
 * DELIVERED → RETURNED. Records what the customer handed back on the spot.
 *
 * This frees the quantity to be delivered again on a later note; it does not
 * credit the customer. Money comes back through a credit note, which also
 * decides whether the goods are fit to restock.
 */
export async function markReturned(
  companyId: string,
  id: string,
  input: ReturnInput,
  userId?: string | null,
) {
  if (!input.lines || input.lines.length === 0) {
    throw badRequest("Say which lines came back, and how many of each");
  }
  const seen = new Set<string>();
  for (const l of input.lines) {
    if (seen.has(l.lineId)) throw badRequest("Each line can appear only once in a return");
    seen.add(l.lineId);
    positiveWhole(l.returnedQty, "Returned quantity");
  }

  const { updated, from } = await db.$transaction(async (tx) => {
    const note = await loadOwned(tx, companyId, id);
    expectStatus(note, ["DELIVERED"], "marked returned");

    let anyReturned = false;
    for (const req of input.lines) {
      const line = note.lines.find((l) => l.id === req.lineId);
      if (!line) throw badRequest("That line is not on this delivery note");
      if (req.returnedQty > line.deliveredQty) {
        throw conflict(
          `Cannot return ${req.returnedQty} of ${line.description}: only ${line.deliveredQty} were delivered on this note`,
        );
      }
      if (req.returnedQty > 0) anyReturned = true;
      await tx.deliveryNoteLine.update({
        where: { id: line.id },
        data: { returnedQty: req.returnedQty },
      });
    }
    if (!anyReturned) throw badRequest("A return needs at least one line with a quantity");

    const updated = await tx.deliveryNote.update({
      where: { id: note.id },
      data: {
        status: "RETURNED",
        notes: input.notes !== undefined ? input.notes?.trim() || null : note.notes,
      },
      include: { lines: true },
    });

    await syncOrderFulfilment(tx, companyId, note.invoiceId ? null : note.orderId);
    return { updated, from: note.status };
  }, TX);
  await transitionAudit(companyId, userId, updated.id, from, "RETURNED", {
    returned: input.lines.filter((l) => l.returnedQty > 0),
  });
  return updated;
}

/** DRAFT|ISSUED → CANCELLED. A signed-for delivery is corrected, not cancelled. */
export async function cancelDeliveryNote(companyId: string, id: string, userId?: string | null) {
  const { updated, from } = await db.$transaction(async (tx) => {
    const note = await loadOwned(tx, companyId, id);
    expectStatus(note, ["DRAFT", "ISSUED"], "cancelled");
    const updated = await tx.deliveryNote.update({
      where: { id: note.id },
      data: { status: "CANCELLED" },
      include: { lines: true },
    });
    return { updated, from: note.status };
  }, TX);
  await transitionAudit(companyId, userId, updated.id, from, "CANCELLED");
  return updated;
}

// ── reading ────────────────────────────────────────────────────────────

/**
 * The tenant filter for delivery notes. A field rep sees the notes they raised
 * and the ones they are the named driver for — the office raises a note and
 * puts the rep on it, and the rep then confirms the drop from the handset.
 */
export function deliveryScope(principal: Principal): Prisma.DeliveryNoteWhereInput {
  if (!principal.companyId) throw notFound("Delivery note not found");
  if (principal.role === "FIELD_REP") {
    return {
      companyId: principal.companyId,
      OR: [{ createdById: principal.userId }, { deliveredById: principal.userId }],
    };
  }
  return { companyId: principal.companyId };
}

export const DELIVERY_NOTE_INCLUDE = {
  customer: { select: { id: true, name: true, code: true, phone: true, town: true } },
  invoice: { select: { id: true, number: true, status: true } },
  order: { select: { id: true, number: true, status: true } },
  deliveredBy: { select: { id: true, name: true } },
  vehicle: { select: { id: true, plate: true } },
  route: { select: { id: true, name: true } },
  lines: { include: { product: { select: { sku: true, name: true } } } },
} satisfies Prisma.DeliveryNoteInclude;
