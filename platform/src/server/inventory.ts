import "server-only";

import { randomUUID } from "node:crypto";

import type { Prisma, PrismaClient } from "@prisma/client";

import { ApiError, conflict, notFound } from "@/lib/api";
import { db } from "@/lib/db";
import { nextNumber } from "@/lib/numbering";
import {
  postCogs,
  postGoodsReceiptEntry,
  postOpeningStock,
  postRepackRounding,
  postStockAdjustment,
} from "./posting";

/**
 * Module 03 · Inventory.
 *
 * Stock is kept in two places on purpose: `StockItem.quantity` is the fast
 * balance every screen reads, and `StockMovement` is the immutable ledger that
 * explains it. Every change goes through `applyMovement`, which writes both in
 * the same transaction — so the balance can always be rebuilt from the ledger
 * if they ever drift.
 */

type Tx = Prisma.TransactionClient | PrismaClient;

export type MovementType =
  | "PURCHASE"
  | "SALE"
  | "TRANSFER_IN"
  | "TRANSFER_OUT"
  | "ADJUSTMENT"
  | "WRITE_OFF"
  | "RETURN"
  | "OPENING"
  // A split/repack: one product leaves, another arrives, value carried across.
  | "REPACK_OUT"
  | "REPACK_IN";

export interface MovementInput {
  companyId: string;
  productId: string;
  locationId: string;
  type: MovementType;
  /** Signed. Positive increases stock at the location. */
  quantity: number;
  unitCostCents?: number;
  refType?: string;
  refId?: string;
  note?: string;
  createdById?: string | null;
}

/** Movement types whose value moves the inventory account. */
const VALUED_TYPES = new Set(["SALE", "RETURN", "ADJUSTMENT", "WRITE_OFF", "OPENING"]);

export async function applyMovement(tx: Tx, input: MovementInput) {
  if (!Number.isInteger(input.quantity) || input.quantity === 0) {
    throw new Error("A stock movement needs a non-zero whole quantity");
  }

  // Both ends of the movement must belong to the company. The stock route
  // passes client-supplied ids straight through, and without this a product id
  // from another tenant would quietly grow a StockItem under this company.
  const product = await tx.product.findFirst({
    where: { id: input.productId, companyId: input.companyId },
    select: { id: true, costPriceCents: true },
  });
  const location = await tx.stockLocation.findFirst({
    where: { id: input.locationId, companyId: input.companyId },
    select: { id: true },
  });
  if (!product) throw new Error("Product not found");
  if (!location) throw new Error("Stock location not found");

  // A valued movement with no cost given carries the product's cost, so the
  // inventory account moves with the quantity. A manual adjustment that moved
  // the shelf but not the books used to be the commonest source of a stock
  // valuation variance.
  const unitCostCents =
    input.unitCostCents ?? (VALUED_TYPES.has(input.type) ? product.costPriceCents : 0);

  // An atomic increment, not read-add-write: two movements against the same
  // item in overlapping transactions each add their own delta, and neither can
  // overwrite the other's. The balance is then read back inside the same
  // transaction, so `balanceAfter` is the figure this movement produced.
  await tx.stockItem.upsert({
    where: {
      productId_locationId: {
        productId: input.productId,
        locationId: input.locationId,
      },
    },
    create: {
      companyId: input.companyId,
      productId: input.productId,
      locationId: input.locationId,
      quantity: input.quantity,
    },
    update: { quantity: { increment: input.quantity } },
  });

  const item = await tx.stockItem.findUniqueOrThrow({
    where: {
      productId_locationId: {
        productId: input.productId,
        locationId: input.locationId,
      },
    },
    select: { quantity: true },
  });
  const balanceAfter = item.quantity;

  const movement = await tx.stockMovement.create({
    data: {
      companyId: input.companyId,
      productId: input.productId,
      locationId: input.locationId,
      type: input.type,
      quantity: input.quantity,
      balanceAfter,
      unitCostCents,
      refType: input.refType ?? null,
      refId: input.refId ?? null,
      note: input.note ?? null,
      createdById: input.createdById ?? null,
    },
  });

  // The ledger consequence hangs off the movement rather than off each caller,
  // because this is the one place every stock change passes through. A new
  // caller therefore cannot forget to book the cost.
  //
  // Transfers and conversions are deliberately excluded: goods moving between
  // this company's own locations change no value, and posting both legs would
  // inflate cost of sales and inventory in equal, invisible measure.
  await postMovementConsequence(tx, movement, input.createdById ?? null);

  return movement;
}

/** Which ledger rule, if any, a movement type implies. */
async function postMovementConsequence(
  tx: Tx,
  movement: {
    id: string;
    companyId: string;
    type: string;
    quantity: number;
    unitCostCents: number;
    createdAt: Date;
  },
  userId: string | null,
) {
  switch (movement.type) {
    // Both go through postCogs, which reads the direction off the quantity:
    // a sale is negative and relieves inventory, a return is positive and puts
    // the cost back.
    case "SALE":
    case "RETURN":
      return postCogs(tx, movement, userId);

    case "ADJUSTMENT":
    case "WRITE_OFF":
      return postStockAdjustment(tx, movement, userId);

    // Stock the company already held before it kept books here. The contra is
    // equity, not a purchase — nobody bought it through this system.
    case "OPENING":
      return postOpeningStock(tx, movement, userId);

    default:
      // PURCHASE is booked from the goods receipt, which also knows the
      // payable side. TRANSFER_IN / TRANSFER_OUT move goods between this
      // company's own locations and change no value. REPACK_OUT / REPACK_IN
      // carry one product's value into another; the two legs net to zero
      // except for the rounding cents, which repackStock posts on its own.
      return null;
  }
}

/**
 * Applies the stock side of a sale.
 *
 * Negative stock is permitted rather than blocked. A van rep invoicing from a
 * moving load will regularly out-run the last sync, and refusing the sale would
 * make the app unusable in exactly the situation it exists for. Shortfalls
 * surface on the exceptions report instead of blocking revenue.
 */
export async function consumeForSale(
  tx: Tx,
  params: {
    companyId: string;
    locationId: string | null;
    lines: Array<{ productId: string; quantity: number }>;
    refType: string;
    refId: string;
    createdById?: string | null;
  },
) {
  if (!params.locationId) return;

  for (const line of params.lines) {
    const product = await tx.product.findUnique({
      where: { id: line.productId },
      select: { trackStock: true, costPriceCents: true },
    });
    if (!product?.trackStock) continue;

    await applyMovement(tx, {
      companyId: params.companyId,
      productId: line.productId,
      locationId: params.locationId,
      type: "SALE",
      quantity: -Math.abs(line.quantity),
      unitCostCents: product.costPriceCents,
      refType: params.refType,
      refId: params.refId,
      createdById: params.createdById,
    });
  }
}

/** Reverses a sale's stock effect, e.g. when an invoice is cancelled. */
export async function returnFromSale(
  tx: Tx,
  params: {
    companyId: string;
    locationId: string | null;
    lines: Array<{ productId: string; quantity: number }>;
    refType: string;
    refId: string;
    createdById?: string | null;
  },
) {
  if (!params.locationId) return;

  for (const line of params.lines) {
    const product = await tx.product.findUnique({
      where: { id: line.productId },
      select: { trackStock: true, costPriceCents: true },
    });
    if (!product?.trackStock) continue;

    await applyMovement(tx, {
      companyId: params.companyId,
      productId: line.productId,
      locationId: params.locationId,
      type: "RETURN",
      quantity: Math.abs(line.quantity),
      // Without this the goods return to the shelf but not to the balance
      // sheet: inventory quantity rises while its value does not, and cost of
      // sales stays overstated for ever.
      unitCostCents: product.costPriceCents,
      refType: params.refType,
      refId: params.refId,
      createdById: params.createdById,
    });
  }
}

export interface StockLevelRow {
  productId: string;
  sku: string;
  name: string;
  unit: string;
  reorderLevel: number;
  totalQuantity: number;
  byLocation: Array<{ locationId: string; locationName: string; quantity: number }>;
  belowReorder: boolean;
}

/** Stock levels across locations, with the low-stock flag Module 03 promises. */
export async function stockLevels(
  companyId: string,
  opts?: { locationId?: string; lowOnly?: boolean; search?: string },
): Promise<StockLevelRow[]> {
  const products = await db.product.findMany({
    where: {
      companyId,
      active: true,
      trackStock: true,
      ...(opts?.search
        ? {
            OR: [
              { name: { contains: opts.search } },
              { sku: { contains: opts.search } },
            ],
          }
        : {}),
    },
    include: {
      stockItems: {
        where: opts?.locationId ? { locationId: opts.locationId } : undefined,
        include: { location: { select: { id: true, name: true } } },
      },
    },
    orderBy: { name: "asc" },
  });

  const rows = products.map((p) => {
    const byLocation = p.stockItems.map((s) => ({
      locationId: s.locationId,
      locationName: s.location.name,
      quantity: s.quantity,
    }));
    const totalQuantity = byLocation.reduce((sum, l) => sum + l.quantity, 0);
    return {
      productId: p.id,
      sku: p.sku,
      name: p.name,
      unit: p.unit,
      reorderLevel: p.reorderLevel,
      totalQuantity,
      byLocation,
      belowReorder: p.reorderLevel > 0 && totalQuantity <= p.reorderLevel,
    };
  });

  return opts?.lowOnly ? rows.filter((r) => r.belowReorder) : rows;
}

export async function lowStockCount(companyId: string): Promise<number> {
  const rows = await stockLevels(companyId, { lowOnly: true });
  return rows.length;
}


// ── errors ──────────────────────────────────────────────────────────────

/** A stock operation the data cannot support: wrong quantity, not enough on hand. */
const invalid = (message: string, details?: unknown) =>
  new ApiError(422, "INVALID_STOCK_OPERATION", message, details);

// ── split / repack ──────────────────────────────────────────────────────

export interface RepackInput {
  companyId: string;
  locationId: string;
  fromProductId: string;
  /** Units of the source product consumed. */
  fromQuantity: number;
  toProductId: string;
  /** Units of the target product produced. Defaults to fromQuantity × source unitsPerPack. */
  toQuantity?: number;
  note?: string;
  userId?: string | null;
}

/**
 * Splits or repacks stock from one product into another at one location.
 *
 * Stock is one pool per product, so "carton → pieces" only needs movements when
 * the carton and the piece are two *products*. (Two selling units of the same
 * product are the same pool, and there is nothing to convert.) The source's
 * value — quantity × its cost — is carried into the target: REPACK_OUT leaves
 * at the source cost, REPACK_IN arrives at floor(value / toQuantity), and the
 * cents the floor loses are written off under REPACK_ROUNDING so the inventory
 * account still equals Σ quantity × cost over every movement.
 *
 * Rounding is written off rather than refused: a 1 240 00 carton into twelve
 * pieces leaves four cents, and refusing every repack whose value does not
 * divide evenly would refuse most of them.
 *
 * The target is repriced to a weighted average over everything the company
 * holds of it, so the valuation report does not jump when pieces made from a
 * dear carton land next to pieces bought cheaply.
 */
export async function repackStock(tx: Tx, input: RepackInput) {
  const { companyId } = input;
  if (!Number.isInteger(input.fromQuantity) || input.fromQuantity <= 0) {
    throw invalid("The quantity to split must be a positive whole number");
  }
  if (input.fromProductId === input.toProductId) {
    throw invalid(
      "Choose two different products. A different pack size of the same product is already the same stock.",
    );
  }

  const productSelect = {
    id: true,
    name: true,
    trackStock: true,
    unitsPerPack: true,
    costPriceCents: true,
  } as const;
  const [from, to, location] = await Promise.all([
    tx.product.findFirst({ where: { id: input.fromProductId, companyId }, select: productSelect }),
    tx.product.findFirst({ where: { id: input.toProductId, companyId }, select: productSelect }),
    tx.stockLocation.findFirst({
      where: { id: input.locationId, companyId },
      select: { id: true, name: true },
    }),
  ]);
  if (!from) throw notFound("Source product not found");
  if (!to) throw notFound("Target product not found");
  if (!location) throw notFound("Stock location not found");
  if (!from.trackStock) throw invalid(`${from.name} does not track stock`);
  if (!to.trackStock) throw invalid(`${to.name} does not track stock`);

  const toQuantity =
    input.toQuantity ?? (from.unitsPerPack > 1 ? input.fromQuantity * from.unitsPerPack : undefined);
  if (toQuantity === undefined) {
    throw invalid(`Say how many ${to.name} the split produces; ${from.name} has no pack size`);
  }
  if (!Number.isInteger(toQuantity) || toQuantity <= 0) {
    throw invalid("The quantity produced must be a positive whole number");
  }

  const held = await tx.stockItem.findUnique({
    where: { productId_locationId: { productId: from.id, locationId: location.id } },
    select: { quantity: true },
  });
  const onHand = held?.quantity ?? 0;
  if (onHand < input.fromQuantity) {
    throw invalid(`Only ${onHand} ${from.name} on hand at ${location.name}`, {
      onHand,
      requested: input.fromQuantity,
    });
  }

  const valueCents = input.fromQuantity * from.costPriceCents;
  const inUnitCostCents = Math.floor(valueCents / toQuantity);
  const remainderCents = valueCents - inUnitCostCents * toQuantity;

  // Weighted average across every location, because cost is per product and
  // stock is one pool. Negative on-hand (a van ahead of its sync) is treated
  // as nothing held, so a debt of units cannot drag the price negative.
  const pool = await tx.stockItem.aggregate({
    where: { productId: to.id },
    _sum: { quantity: true },
  });
  const poolQty = Math.max(0, pool._sum.quantity ?? 0);
  const targetCostPriceCents = Math.round(
    (poolQty * to.costPriceCents + valueCents) / (poolQty + toQuantity),
  );

  const refId = randomUUID();
  const out = await applyMovement(tx, {
    companyId,
    productId: from.id,
    locationId: location.id,
    type: "REPACK_OUT",
    quantity: -input.fromQuantity,
    unitCostCents: from.costPriceCents,
    refType: "REPACK",
    refId,
    note: input.note ?? `Split into ${toQuantity} × ${to.name}`,
    createdById: input.userId ?? null,
  });
  const arrived = await applyMovement(tx, {
    companyId,
    productId: to.id,
    locationId: location.id,
    type: "REPACK_IN",
    quantity: toQuantity,
    unitCostCents: inUnitCostCents,
    refType: "REPACK",
    refId,
    note: input.note ?? `Split from ${input.fromQuantity} × ${from.name}`,
    createdById: input.userId ?? null,
  });

  await tx.product.update({
    where: { id: to.id },
    data: { costPriceCents: targetCostPriceCents },
  });

  if (remainderCents > 0) {
    await postRepackRounding(tx, arrived, remainderCents, input.userId ?? null);
  }

  return {
    refId,
    out,
    in: arrived,
    valueCents,
    remainderCents,
    targetCostPriceCents,
    previousTargetCostPriceCents: to.costPriceCents,
  };
}

// ── transfers ───────────────────────────────────────────────────────────

export type TransferStatus =
  | "DRAFT"
  | "PARTIALLY_DISPATCHED"
  | "IN_TRANSIT"
  | "PARTIALLY_RECEIVED"
  | "RECEIVED"
  | "CANCELLED";

export const TRANSFER_STATUSES: TransferStatus[] = [
  "DRAFT",
  "PARTIALLY_DISPATCHED",
  "IN_TRANSIT",
  "PARTIALLY_RECEIVED",
  "RECEIVED",
  "CANCELLED",
];

interface TransferCounters {
  quantity: number;
  dispatched: number;
  received: number;
}

/**
 * The status the counters imply. Pure, so the consistency script can apply the
 * same rule to stored rows.
 *
 * A short-closed transfer is RECEIVED whatever its counters say: what was not
 * delivered has been written off and nothing more will move.
 */
export function deriveTransferStatus(
  lines: TransferCounters[],
  opts: { shortClosed?: boolean } = {},
): TransferStatus {
  if (opts.shortClosed) return "RECEIVED";
  const quantity = lines.reduce((n, l) => n + l.quantity, 0);
  const dispatched = lines.reduce((n, l) => n + l.dispatched, 0);
  const received = lines.reduce((n, l) => n + l.received, 0);
  if (dispatched === 0) return "DRAFT";
  if (received >= quantity) return "RECEIVED";
  if (received > 0) return "PARTIALLY_RECEIVED";
  if (dispatched >= quantity) return "IN_TRANSIT";
  return "PARTIALLY_DISPATCHED";
}

export interface CreateTransferInput {
  companyId: string;
  fromLocationId: string;
  toLocationId: string;
  note?: string | null;
  lines: Array<{ productId: string; quantity: number }>;
  createdById?: string | null;
}

/** Creates a DRAFT transfer. Nothing moves until it is dispatched. */
export async function createTransfer(tx: Tx, input: CreateTransferInput) {
  const { companyId } = input;
  if (input.fromLocationId === input.toLocationId) {
    throw invalid("A transfer needs two different locations");
  }
  if (input.lines.length === 0) throw invalid("A transfer needs at least one line");

  const seen = new Set<string>();
  for (const line of input.lines) {
    if (!Number.isInteger(line.quantity) || line.quantity <= 0) {
      throw invalid("Each line needs a positive whole quantity");
    }
    if (seen.has(line.productId)) throw invalid("List each product once");
    seen.add(line.productId);
  }

  const [from, to, products] = await Promise.all([
    tx.stockLocation.findFirst({ where: { id: input.fromLocationId, companyId }, select: { id: true } }),
    tx.stockLocation.findFirst({ where: { id: input.toLocationId, companyId }, select: { id: true } }),
    tx.product.findMany({
      where: { companyId, id: { in: [...seen] } },
      select: { id: true, name: true, trackStock: true },
    }),
  ]);
  if (!from) throw notFound("Source location not found");
  if (!to) throw notFound("Destination location not found");
  const byId = new Map(products.map((p) => [p.id, p]));
  for (const id of seen) {
    const p = byId.get(id);
    if (!p) throw notFound("Product not found");
    if (!p.trackStock) throw invalid(`${p.name} does not track stock`);
  }

  return tx.stockTransfer.create({
    data: {
      companyId,
      number: await nextNumber(companyId, "TRANSFER", tx as Prisma.TransactionClient),
      fromLocationId: from.id,
      toLocationId: to.id,
      status: "DRAFT",
      note: input.note ?? null,
      createdById: input.createdById ?? null,
      lines: { create: input.lines.map((l) => ({ productId: l.productId, quantity: l.quantity })) },
    },
    include: { lines: true },
  });
}

export interface TransferLineQuantity {
  lineId: string;
  quantity: number;
}

export interface TransferStepOptions {
  /** Scope the lookup to a tenant; an id from another company is not found. */
  companyId?: string;
  /** Per-line quantities. Omitted: everything still outstanding on every line. */
  lines?: TransferLineQuantity[];
}

type StoredTransferLine = {
  id: string;
  productId: string;
  quantity: number;
  dispatched: number;
  received: number;
};

/**
 * Resolves what each line moves this time. Explicit quantities must name lines
 * of this transfer and sit in 0 < q ≤ remaining; an omitted list takes the
 * remainder of every line that still has one.
 */
function resolveStep(
  lines: StoredTransferLine[],
  requested: TransferLineQuantity[] | undefined,
  remainingOf: (l: StoredTransferLine) => number,
  verb: string,
): Array<{ line: StoredTransferLine; quantity: number }> {
  if (!requested) {
    return lines
      .map((line) => ({ line, quantity: remainingOf(line) }))
      .filter((s) => s.quantity > 0);
  }
  const byId = new Map(lines.map((l) => [l.id, l]));
  const seen = new Set<string>();
  const steps: Array<{ line: StoredTransferLine; quantity: number }> = [];
  for (const r of requested) {
    const line = byId.get(r.lineId);
    if (!line) throw invalid("A line does not belong to this transfer", { lineId: r.lineId });
    if (seen.has(r.lineId)) throw invalid("A line appears more than once", { lineId: r.lineId });
    seen.add(r.lineId);
    if (!Number.isInteger(r.quantity) || r.quantity <= 0) {
      throw invalid(`Quantity to ${verb} must be a positive whole number`, { lineId: r.lineId });
    }
    const remaining = remainingOf(line);
    if (r.quantity > remaining) {
      throw invalid(`Only ${remaining} remain to be ${verb}d on this line`, {
        lineId: r.lineId,
        remaining,
        requested: r.quantity,
      });
    }
    steps.push({ line, quantity: r.quantity });
  }
  return steps;
}

const TRANSFER_INCLUDE = {
  lines: { include: { product: { select: { name: true, sku: true } } } },
  fromLocation: { select: { id: true, name: true } },
  toLocation: { select: { id: true, name: true } },
} as const;

/** Re-reads the counters and stores the status they imply, plus the timestamps. */
async function settleTransfer(tx: Tx, transferId: string) {
  const t = await tx.stockTransfer.findUniqueOrThrow({
    where: { id: transferId },
    include: { lines: true },
  });
  const status = deriveTransferStatus(t.lines, { shortClosed: Boolean(t.shortClosedAt) });
  const dispatched = t.lines.some((l) => l.dispatched > 0);
  return tx.stockTransfer.update({
    where: { id: transferId },
    data: {
      status,
      dispatchedAt: t.dispatchedAt ?? (dispatched ? new Date() : null),
      receivedAt: status === "RECEIVED" ? (t.receivedAt ?? new Date()) : t.receivedAt,
    },
    include: TRANSFER_INCLUDE,
  });
}

async function loadOpenTransfer(tx: Tx, transferId: string, companyId?: string) {
  const transfer = await tx.stockTransfer.findFirst({
    where: { id: transferId, ...(companyId ? { companyId } : {}) },
    include: { lines: true },
  });
  if (!transfer) throw notFound("Transfer not found");
  if (transfer.status === "CANCELLED") throw conflict("This transfer was cancelled");
  if (transfer.shortClosedAt) throw conflict("This transfer was closed short");
  return transfer;
}

/**
 * Dispatches all or part of a transfer: stock leaves the source.
 *
 * Each line is claimed with a conditional UPDATE (`dispatched ≤ quantity − q`)
 * so two dispatches racing on the same line cannot both succeed; the loser
 * sees no row updated and the whole transaction rolls back.
 */
export async function dispatchTransferIn(
  tx: Tx,
  transferId: string,
  userId: string | null,
  opts: TransferStepOptions = {},
) {
  const transfer = await loadOpenTransfer(tx, transferId, opts.companyId);
  const steps = resolveStep(transfer.lines, opts.lines, (l) => l.quantity - l.dispatched, "dispatche");
  if (steps.length === 0) throw conflict("Nothing is left to dispatch on this transfer");

  for (const { line, quantity } of steps) {
    const claimed = await tx.stockTransferLine.updateMany({
      where: { id: line.id, transferId: transfer.id, dispatched: { lte: line.quantity - quantity } },
      data: { dispatched: { increment: quantity } },
    });
    if (claimed.count !== 1) {
      throw conflict("Part of this transfer was dispatched by someone else a moment ago; reload and try again");
    }
    await applyMovement(tx, {
      companyId: transfer.companyId,
      productId: line.productId,
      locationId: transfer.fromLocationId,
      type: "TRANSFER_OUT",
      quantity: -quantity,
      refType: "TRANSFER",
      refId: transfer.id,
      createdById: userId,
    });
  }

  return settleTransfer(tx, transfer.id);
}

/** Receives all or part of what is in transit: stock arrives at the destination. */
export async function receiveTransferIn(
  tx: Tx,
  transferId: string,
  userId: string | null,
  opts: TransferStepOptions = {},
) {
  const transfer = await loadOpenTransfer(tx, transferId, opts.companyId);
  const steps = resolveStep(transfer.lines, opts.lines, (l) => l.dispatched - l.received, "receive");
  if (steps.length === 0) throw conflict("Nothing is in transit on this transfer");

  for (const { line, quantity } of steps) {
    // `dispatched` only ever grows, so the snapshot's figure is a safe bound.
    const claimed = await tx.stockTransferLine.updateMany({
      where: { id: line.id, transferId: transfer.id, received: { lte: line.dispatched - quantity } },
      data: { received: { increment: quantity } },
    });
    if (claimed.count !== 1) {
      throw conflict("Part of this transfer was received by someone else a moment ago; reload and try again");
    }
    await applyMovement(tx, {
      companyId: transfer.companyId,
      productId: line.productId,
      locationId: transfer.toLocationId,
      type: "TRANSFER_IN",
      quantity,
      refType: "TRANSFER",
      refId: transfer.id,
      createdById: userId,
    });
  }

  return settleTransfer(tx, transfer.id);
}

/** Cancels a transfer nothing has left on. */
export async function cancelTransferIn(tx: Tx, transferId: string, companyId?: string) {
  const cancelled = await tx.stockTransfer.updateMany({
    where: { id: transferId, status: "DRAFT", ...(companyId ? { companyId } : {}) },
    data: { status: "CANCELLED" },
  });
  if (cancelled.count !== 1) {
    const t = await tx.stockTransfer.findFirst({
      where: { id: transferId, ...(companyId ? { companyId } : {}) },
      select: { status: true },
    });
    if (!t) throw notFound("Transfer not found");
    throw conflict(
      `Only draft transfers can be cancelled; this one is ${t.status.toLowerCase().replaceAll("_", " ")}`,
    );
  }
  return tx.stockTransfer.findUniqueOrThrow({ where: { id: transferId }, include: TRANSFER_INCLUDE });
}

/**
 * Closes a transfer short: whatever was dispatched and never received is
 * brought back onto the source's books with TRANSFER_IN and then written off
 * there with WRITE_OFF, which posts the loss. Undispatched quantity simply
 * never moves. The transfer ends RECEIVED with `shortClosedAt` set.
 */
export async function closeTransferShortIn(
  tx: Tx,
  transferId: string,
  userId: string | null,
  opts: { companyId?: string; note?: string } = {},
) {
  const now = new Date();
  const claimed = await tx.stockTransfer.updateMany({
    where: {
      id: transferId,
      shortClosedAt: null,
      status: { in: ["PARTIALLY_DISPATCHED", "IN_TRANSIT", "PARTIALLY_RECEIVED"] },
      ...(opts.companyId ? { companyId: opts.companyId } : {}),
    },
    data: { shortClosedAt: now, status: "RECEIVED", receivedAt: now },
  });
  if (claimed.count !== 1) {
    const t = await tx.stockTransfer.findFirst({
      where: { id: transferId, ...(opts.companyId ? { companyId: opts.companyId } : {}) },
      select: { status: true, shortClosedAt: true },
    });
    if (!t) throw notFound("Transfer not found");
    if (t.shortClosedAt) throw conflict("This transfer was already closed short");
    throw conflict(
      `A ${t.status.toLowerCase().replaceAll("_", " ")} transfer has nothing in transit to close`,
    );
  }

  const transfer = await tx.stockTransfer.findUniqueOrThrow({
    where: { id: transferId },
    include: { lines: true },
  });
  const note = opts.note ?? `Transfer ${transfer.number} closed short`;
  for (const line of transfer.lines) {
    const lost = line.dispatched - line.received;
    if (lost <= 0) continue;
    await applyMovement(tx, {
      companyId: transfer.companyId,
      productId: line.productId,
      locationId: transfer.fromLocationId,
      type: "TRANSFER_IN",
      quantity: lost,
      refType: "TRANSFER",
      refId: transfer.id,
      note,
      createdById: userId,
    });
    await applyMovement(tx, {
      companyId: transfer.companyId,
      productId: line.productId,
      locationId: transfer.fromLocationId,
      type: "WRITE_OFF",
      quantity: -lost,
      refType: "TRANSFER",
      refId: transfer.id,
      note,
      createdById: userId,
    });
  }

  return tx.stockTransfer.findUniqueOrThrow({ where: { id: transferId }, include: TRANSFER_INCLUDE });
}

const TX_OPTS = { timeout: 15_000 } as const;

/** Dispatches a transfer in its own transaction. */
export async function dispatchTransfer(
  transferId: string,
  userId: string | null,
  opts: TransferStepOptions = {},
) {
  return db.$transaction((tx) => dispatchTransferIn(tx, transferId, userId, opts), TX_OPTS);
}

/** Receives a transfer in its own transaction. */
export async function receiveTransfer(
  transferId: string,
  userId: string | null,
  opts: TransferStepOptions = {},
) {
  return db.$transaction((tx) => receiveTransferIn(tx, transferId, userId, opts), TX_OPTS);
}

export async function cancelTransfer(transferId: string, companyId?: string) {
  return db.$transaction((tx) => cancelTransferIn(tx, transferId, companyId), TX_OPTS);
}

export async function closeTransferShort(
  transferId: string,
  userId: string | null,
  opts: { companyId?: string; note?: string } = {},
) {
  return db.$transaction((tx) => closeTransferShortIn(tx, transferId, userId, opts), TX_OPTS);
}

// ── multi-location adjustment / relocation ──────────────────────────────

export interface MultiLocationAdjustInput {
  companyId: string;
  productId: string;
  lines: Array<{ locationId: string; quantity: number }>;
  note?: string;
  userId?: string | null;
}

/**
 * One product counted at several locations at once.
 *
 * When the lines net to zero the count did not find or lose anything — it found
 * stock standing somewhere else — so it is recorded as transfers, dispatched and
 * received on the spot, rather than as a write-off here and a write-up there
 * that would put the same goods through the P&L twice. Otherwise every line is
 * a valued ADJUSTMENT. Either way one transaction.
 */
export async function adjustAcrossLocations(tx: Tx, input: MultiLocationAdjustInput) {
  const { companyId } = input;
  if (input.lines.length === 0) throw invalid("At least one location is needed");
  const seen = new Set<string>();
  for (const l of input.lines) {
    if (!Number.isInteger(l.quantity) || l.quantity === 0) {
      throw invalid("Each location needs a non-zero whole quantity");
    }
    if (seen.has(l.locationId)) throw invalid("List each location once");
    seen.add(l.locationId);
  }

  const [product, locations] = await Promise.all([
    tx.product.findFirst({
      where: { id: input.productId, companyId },
      select: { id: true, name: true, costPriceCents: true, trackStock: true },
    }),
    tx.stockLocation.findMany({ where: { companyId, id: { in: [...seen] } }, select: { id: true } }),
  ]);
  if (!product) throw notFound("Product not found");
  if (!product.trackStock) throw invalid(`${product.name} does not track stock`);
  if (locations.length !== seen.size) throw notFound("Stock location not found");

  const net = input.lines.reduce((n, l) => n + l.quantity, 0);

  if (net === 0 && input.lines.length > 1) {
    const transfers = await relocateStock(tx, input);
    return { kind: "RELOCATION" as const, transfers, movements: [] };
  }

  const movements = [];
  for (const line of input.lines) {
    movements.push(
      await applyMovement(tx, {
        companyId,
        productId: product.id,
        locationId: line.locationId,
        type: "ADJUSTMENT",
        quantity: line.quantity,
        unitCostCents: product.costPriceCents,
        note: input.note,
        createdById: input.userId ?? null,
      }),
    );
  }
  return { kind: "ADJUSTMENT" as const, transfers: [], movements };
}

/**
 * Pairs the locations that lost units with the ones that gained them and
 * writes one completed transfer per pair. Greedy, in the order given: a
 * three-way move becomes two transfers, which is what actually happened.
 */
async function relocateStock(tx: Tx, input: MultiLocationAdjustInput) {
  const sources = input.lines.filter((l) => l.quantity < 0).map((l) => ({ ...l, left: -l.quantity }));
  const sinks = input.lines.filter((l) => l.quantity > 0).map((l) => ({ ...l, left: l.quantity }));
  const transfers = [];
  for (const src of sources) {
    for (const dst of sinks) {
      if (src.left === 0) break;
      if (dst.left === 0) continue;
      const q = Math.min(src.left, dst.left);
      const created = await createTransfer(tx, {
        companyId: input.companyId,
        fromLocationId: src.locationId,
        toLocationId: dst.locationId,
        note: input.note ?? "Relocation from a stock count",
        lines: [{ productId: input.productId, quantity: q }],
        createdById: input.userId ?? null,
      });
      await dispatchTransferIn(tx, created.id, input.userId ?? null);
      transfers.push(await receiveTransferIn(tx, created.id, input.userId ?? null));
      src.left -= q;
      dst.left -= q;
    }
  }
  return transfers;
}

// ── goods receipts ──────────────────────────────────────────────────────

export interface GoodsReceiptLineInput {
  productId: string;
  quantity: number;
  /** Defaults to the matched PO line's cost, else the product's cost. */
  unitCostCents?: number;
  /** Where the line lands; null means the receipt's location. */
  locationId?: string | null;
  /** The PO line this fulfils; null matches by product in PO order. */
  poLineId?: string | null;
}

export interface CreateGoodsReceiptInput {
  companyId: string;
  supplierId?: string;
  poId?: string | null;
  locationId: string;
  receivedAt?: Date;
  note?: string | null;
  /** Accept more than the PO ordered. */
  allowOver?: boolean;
  lines: GoodsReceiptLineInput[];
  createdById?: string | null;
}

type PoLineRow = {
  id: string;
  productId: string;
  quantity: number;
  received: number;
  unitCostCents: number;
};

/**
 * Works out how each receipt line is applied to the purchase order. A line
 * naming a PO line takes it; otherwise the product's PO lines are filled in
 * order. Receiving beyond what was ordered is refused unless `allowOver`, in
 * which case the excess lands on the last line it was being filled against.
 * Pure over an in-memory copy, so the same plan can be previewed on create and
 * applied on post.
 */
function planPoAllocation(
  poLines: PoLineRow[],
  lines: Array<{ productId: string; quantity: number; poLineId?: string | null }>,
  allowOver: boolean,
): Map<string, number> {
  const received = new Map(poLines.map((l) => [l.id, l.received]));
  const add = new Map<string, number>();
  const bump = (id: string, q: number) => {
    received.set(id, (received.get(id) ?? 0) + q);
    add.set(id, (add.get(id) ?? 0) + q);
  };
  for (const line of lines) {
    if (line.poLineId) {
      const po = poLines.find((l) => l.id === line.poLineId);
      if (!po) {
        throw invalid("A line names a purchase order line that is not on this order", {
          poLineId: line.poLineId,
        });
      }
      if (po.productId !== line.productId) {
        throw invalid("A line's product differs from its purchase order line", { poLineId: po.id });
      }
      const remaining = Math.max(0, po.quantity - (received.get(po.id) ?? 0));
      if (line.quantity > remaining && !allowOver) {
        throw invalid(`Only ${remaining} remain to be received on that purchase order line`, {
          poLineId: po.id,
          remaining,
          requested: line.quantity,
        });
      }
      bump(po.id, line.quantity);
      continue;
    }
    const candidates = poLines.filter((l) => l.productId === line.productId);
    if (candidates.length === 0) {
      if (!allowOver) {
        throw invalid("A product on this receipt is not on the purchase order", {
          productId: line.productId,
        });
      }
      continue;
    }
    let left = line.quantity;
    let last = candidates[0]!;
    for (const po of candidates) {
      if (left === 0) break;
      const remaining = po.quantity - (received.get(po.id) ?? 0);
      if (remaining <= 0) continue;
      const take = Math.min(left, remaining);
      bump(po.id, take);
      left -= take;
      last = po;
    }
    if (left > 0) {
      if (!allowOver) {
        const ordered = candidates.reduce((n, l) => n + l.quantity, 0);
        const already = candidates.reduce((n, l) => n + l.received, 0);
        const remaining = Math.max(0, ordered - already);
        throw invalid(
          `Only ${remaining} remain to be received for this product on the purchase order`,
          { productId: line.productId, remaining, requested: line.quantity },
        );
      }
      bump(last.id, left);
    }
  }
  return add;
}

/** Creates a DRAFT goods receipt, from a purchase order or free-standing. */
export async function createGoodsReceipt(tx: Tx, input: CreateGoodsReceiptInput) {
  const { companyId } = input;
  if (input.lines.length === 0) throw invalid("A goods receipt needs at least one line");
  for (const l of input.lines) {
    if (!Number.isInteger(l.quantity) || l.quantity <= 0) {
      throw invalid("Each line needs a positive whole quantity");
    }
    if (l.unitCostCents !== undefined && (!Number.isInteger(l.unitCostCents) || l.unitCostCents < 0)) {
      throw invalid("Unit cost must be a whole number of cents, zero or more");
    }
  }

  const po = input.poId
    ? await tx.purchaseOrder.findFirst({
        where: { id: input.poId, companyId },
        include: { lines: { orderBy: { id: "asc" } } },
      })
    : null;
  if (input.poId && !po) throw notFound("Purchase order not found");
  if (po && !["SENT", "PARTIALLY_RECEIVED"].includes(po.status)) {
    throw conflict(
      `Purchase order ${po.number} is ${po.status.toLowerCase().replaceAll("_", " ")} and cannot be received against`,
    );
  }
  const supplierId = input.supplierId ?? po?.supplierId;
  if (!supplierId) throw invalid("Name the supplier, or the purchase order the goods arrived against");
  if (po && input.supplierId && input.supplierId !== po.supplierId) {
    throw invalid("The supplier differs from the purchase order's supplier");
  }

  const locationIds = new Set<string>([
    input.locationId,
    ...input.lines.flatMap((l) => (l.locationId ? [l.locationId] : [])),
  ]);
  const productIds = new Set(input.lines.map((l) => l.productId));
  const [supplier, locations, products] = await Promise.all([
    tx.supplier.findFirst({ where: { id: supplierId, companyId }, select: { id: true } }),
    tx.stockLocation.findMany({ where: { companyId, id: { in: [...locationIds] } }, select: { id: true } }),
    tx.product.findMany({
      where: { companyId, id: { in: [...productIds] } },
      select: { id: true, name: true, trackStock: true, costPriceCents: true },
    }),
  ]);
  if (!supplier) throw notFound("Supplier not found");
  if (locations.length !== locationIds.size) throw notFound("Stock location not found");
  const productById = new Map(products.map((p) => [p.id, p]));
  for (const id of productIds) {
    const p = productById.get(id);
    if (!p) throw notFound("Product not found");
    if (!p.trackStock) throw invalid(`${p.name} does not track stock`);
  }
  if (!po && input.lines.some((l) => l.poLineId)) {
    throw invalid("A line names a purchase order line but the receipt has no purchase order");
  }

  // Preview the allocation so an over-receipt is refused before a draft exists.
  if (po) planPoAllocation(po.lines, input.lines, input.allowOver ?? false);

  const lines = input.lines.map((l) => {
    const poLine =
      po?.lines.find((x) => x.id === l.poLineId) ?? po?.lines.find((x) => x.productId === l.productId);
    return {
      productId: l.productId,
      quantity: l.quantity,
      unitCostCents:
        l.unitCostCents ?? poLine?.unitCostCents ?? productById.get(l.productId)!.costPriceCents,
      locationId: l.locationId && l.locationId !== input.locationId ? l.locationId : null,
      poLineId: l.poLineId ?? null,
    };
  });

  return tx.goodsReceipt.create({
    data: {
      companyId,
      supplierId,
      poId: po?.id ?? null,
      locationId: input.locationId,
      number: await nextNumber(companyId, "GRN", tx as Prisma.TransactionClient),
      status: "DRAFT",
      receivedAt: input.receivedAt ?? new Date(),
      note: input.note ?? null,
      createdById: input.createdById ?? null,
      lines: { create: lines },
    },
    include: { lines: true },
  });
}

const GRN_INCLUDE = {
  lines: { include: { product: { select: { name: true, sku: true } } } },
  supplier: { select: { id: true, name: true } },
  location: { select: { id: true, name: true } },
} as const;

/**
 * Posts a goods receipt: stock arrives, the product's cost basis moves to the
 * landed cost, PO lines are marked received, and inventory/GRNI are booked.
 *
 * DRAFT → POSTED is claimed with a conditional UPDATE first, so two clicks on
 * "Post" cannot both put the goods on the shelf.
 */
export async function postGoodsReceiptIn(
  tx: Tx,
  grnId: string,
  userId: string | null,
  opts: { companyId?: string; allowOver?: boolean } = {},
) {
  const claimed = await tx.goodsReceipt.updateMany({
    where: { id: grnId, status: "DRAFT", ...(opts.companyId ? { companyId: opts.companyId } : {}) },
    data: { status: "POSTED" },
  });
  if (claimed.count !== 1) {
    const g = await tx.goodsReceipt.findFirst({
      where: { id: grnId, ...(opts.companyId ? { companyId: opts.companyId } : {}) },
      select: { status: true },
    });
    if (!g) throw notFound("Goods receipt not found");
    throw conflict("Goods receipt already posted");
  }

  const grn = await tx.goodsReceipt.findUniqueOrThrow({
    where: { id: grnId },
    include: { lines: true },
  });

  const poLines = grn.poId
    ? await tx.purchaseOrderLine.findMany({ where: { poId: grn.poId }, orderBy: { id: "asc" } })
    : [];
  const allocation = grn.poId
    ? planPoAllocation(poLines, grn.lines, opts.allowOver ?? false)
    : new Map<string, number>();

  for (const line of grn.lines) {
    await applyMovement(tx, {
      companyId: grn.companyId,
      productId: line.productId,
      locationId: line.locationId ?? grn.locationId,
      type: "PURCHASE",
      quantity: Math.abs(line.quantity),
      unitCostCents: line.unitCostCents,
      refType: "GRN",
      refId: grn.id,
      createdById: userId,
    });

    // Landed cost becomes the product's running cost basis.
    await tx.product.update({
      where: { id: line.productId },
      data: { costPriceCents: line.unitCostCents },
    });
  }

  for (const [poLineId, add] of allocation) {
    if (add === 0) continue;
    await tx.purchaseOrderLine.update({
      where: { id: poLineId },
      data: { received: { increment: add } },
    });
  }

  if (grn.poId) {
    const lines = await tx.purchaseOrderLine.findMany({ where: { poId: grn.poId } });
    const complete = lines.every((l) => l.received >= l.quantity);
    await tx.purchaseOrder.update({
      where: { id: grn.poId },
      data: { status: complete ? "RECEIVED" : "PARTIALLY_RECEIVED" },
    });
  }

  // Inventory rises and a liability to the supplier is created. Valued from
  // the receipt's own lines, so it matches exactly what applyMovement put on
  // the shelf rather than what a purchase order once expected.
  const valueCents = grn.lines.reduce((n, l) => n + Math.abs(l.quantity) * l.unitCostCents, 0);
  await postGoodsReceiptEntry(
    tx,
    { id: grn.id, companyId: grn.companyId, receivedAt: grn.receivedAt ?? new Date(), valueCents },
    userId,
  );

  return tx.goodsReceipt.findUniqueOrThrow({ where: { id: grnId }, include: GRN_INCLUDE });
}

/** Posts a goods receipt in its own transaction. */
export async function postGoodsReceipt(
  grnId: string,
  userId: string | null,
  opts: { companyId?: string; allowOver?: boolean } = {},
) {
  return db.$transaction((tx) => postGoodsReceiptIn(tx, grnId, userId, opts), TX_OPTS);
}
