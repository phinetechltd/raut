import "server-only";

import type { Prisma, PrismaClient } from "@prisma/client";

import { db } from "@/lib/db";
import {
  postCogs,
  postGoodsReceiptEntry,
  postOpeningStock,
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
  | "RETURN"
  | "OPENING";

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

export async function applyMovement(tx: Tx, input: MovementInput) {
  const item = await tx.stockItem.upsert({
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
      quantity: 0,
    },
    update: {},
  });

  const balanceAfter = item.quantity + input.quantity;

  await tx.stockItem.update({
    where: { id: item.id },
    data: { quantity: balanceAfter },
  });

  const movement = await tx.stockMovement.create({
    data: {
      companyId: input.companyId,
      productId: input.productId,
      locationId: input.locationId,
      type: input.type,
      quantity: input.quantity,
      balanceAfter,
      unitCostCents: input.unitCostCents ?? 0,
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
      // company's own locations and change no value.
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

/** Dispatches a transfer: stock leaves the source and is marked in transit. */
export async function dispatchTransfer(transferId: string, userId: string) {
  return db.$transaction(async (tx) => {
    const transfer = await tx.stockTransfer.findUnique({
      where: { id: transferId },
      include: { lines: true },
    });
    if (!transfer) throw new Error("Transfer not found");
    if (transfer.status !== "DRAFT") throw new Error("Transfer already dispatched");

    for (const line of transfer.lines) {
      await applyMovement(tx, {
        companyId: transfer.companyId,
        productId: line.productId,
        locationId: transfer.fromLocationId,
        type: "TRANSFER_OUT",
        quantity: -Math.abs(line.quantity),
        refType: "TRANSFER",
        refId: transfer.id,
        createdById: userId,
      });
    }

    return tx.stockTransfer.update({
      where: { id: transferId },
      data: { status: "IN_TRANSIT", dispatchedAt: new Date() },
    });
  });
}

/** Receives a transfer at the destination. */
export async function receiveTransfer(transferId: string, userId: string) {
  return db.$transaction(async (tx) => {
    const transfer = await tx.stockTransfer.findUnique({
      where: { id: transferId },
      include: { lines: true },
    });
    if (!transfer) throw new Error("Transfer not found");
    if (transfer.status !== "IN_TRANSIT") throw new Error("Transfer is not in transit");

    for (const line of transfer.lines) {
      await applyMovement(tx, {
        companyId: transfer.companyId,
        productId: line.productId,
        locationId: transfer.toLocationId,
        type: "TRANSFER_IN",
        quantity: Math.abs(line.quantity),
        refType: "TRANSFER",
        refId: transfer.id,
        createdById: userId,
      });
      await tx.stockTransferLine.update({
        where: { id: line.id },
        data: { received: line.quantity },
      });
    }

    return tx.stockTransfer.update({
      where: { id: transferId },
      data: { status: "RECEIVED", receivedAt: new Date() },
    });
  });
}

/** Posts a goods receipt: stock arrives and PO lines are marked received. */
export async function postGoodsReceipt(grnId: string, userId: string) {
  return db.$transaction(async (tx) => {
    const grn = await tx.goodsReceipt.findUnique({
      where: { id: grnId },
      include: { lines: true },
    });
    if (!grn) throw new Error("Goods receipt not found");
    if (grn.status === "POSTED") throw new Error("Goods receipt already posted");

    for (const line of grn.lines) {
      await applyMovement(tx, {
        companyId: grn.companyId,
        productId: line.productId,
        locationId: grn.locationId,
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

      if (grn.poId) {
        const poLine = await tx.purchaseOrderLine.findFirst({
          where: { poId: grn.poId, productId: line.productId },
        });
        if (poLine) {
          await tx.purchaseOrderLine.update({
            where: { id: poLine.id },
            data: { received: Math.min(poLine.quantity, poLine.received + line.quantity) },
          });
        }
      }
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
    const valueCents = grn.lines.reduce(
      (n, l) => n + Math.abs(l.quantity) * l.unitCostCents,
      0,
    );
    await postGoodsReceiptEntry(
      tx,
      {
        id: grn.id,
        companyId: grn.companyId,
        receivedAt: grn.receivedAt ?? new Date(),
        valueCents,
      },
      userId,
    );

    return tx.goodsReceipt.update({
      where: { id: grnId },
      data: { status: "POSTED" },
    });
  }, {
    // Also posts to the ledger now; see the note in sales.ts.
    timeout: 15_000,
  });
}