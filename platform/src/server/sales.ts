import "server-only";

import { db } from "@/lib/db";
import { computeLine, computeTotals, deriveInvoiceStatus, formatKES } from "@/lib/money";
import { nextNumber } from "@/lib/numbering";

import { postInvoice, postPayment } from "./posting";
import { sendTemplated } from "@/lib/sms";

import { consumeForSale } from "./inventory";
import { queueInvoice } from "./etims";

/**
 * Module 02 · Sales & POS.
 *
 * Orders, invoices and payments are created here rather than in route handlers
 * because each has side effects — stock, customer balance, SMS — that must all
 * happen or none of them. The mobile app and the console both call these, which
 * is what keeps a field-captured invoice identical to a counter-captured one.
 */

export interface DraftLine {
  productId: string;
  /** Quantity in the unit being sold — cartons, not bottles. */
  quantity: number;
  /**
   * The selling unit. Omitted means the base unit, which is what every caller
   * written before variants existed sends.
   */
  variantId?: string | null;
  unitPriceCents?: number;
  discountCents?: number;
  description?: string;
}

/** Resolves lines against the catalogue, defaulting price and tax from the product. */
async function resolveLines(companyId: string, lines: DraftLine[]) {
  if (lines.length === 0) throw new Error("At least one line is required");

  const products = await db.product.findMany({
    where: { companyId, id: { in: lines.map((l) => l.productId) } },
  });
  const byId = new Map(products.map((p) => [p.id, p]));

  // Variants are looked up scoped to the company, so an id from another tenant
  // resolves to nothing and is rejected rather than silently priced.
  const variantIds = lines
    .map((l) => l.variantId)
    .filter((v): v is string => typeof v === "string" && v.length > 0);
  const variants = variantIds.length
    ? await db.productVariant.findMany({ where: { companyId, id: { in: variantIds } } })
    : [];
  const variantById = new Map(variants.map((v) => [v.id, v]));

  return lines.map((line) => {
    const product = byId.get(line.productId);
    if (!product) throw new Error(`Unknown product ${line.productId}`);
    if (line.quantity <= 0) throw new Error(`Quantity must be positive for ${product.name}`);

    const variant = line.variantId ? variantById.get(line.variantId) : undefined;
    if (line.variantId && !variant) {
      throw new Error(`Unknown selling unit for ${product.name}`);
    }
    if (variant && variant.productId !== product.id) {
      // A variant of a different product would price one thing and take another
      // off the shelf.
      throw new Error(`That selling unit does not belong to ${product.name}`);
    }

    // Price per unit sold. A carton has its own price rather than twelve times
    // a bottle, because it is cheaper by the carton and deriving it would both
    // lose that and round badly.
    const unitPriceCents =
      line.unitPriceCents ?? variant?.sellPriceCents ?? product.sellPriceCents;
    const discountCents = line.discountCents ?? 0;
    const taxRateBp = product.taxRateBp;
    const totals = computeLine({ quantity: line.quantity, unitPriceCents, discountCents, taxRateBp });

    // Stock and cost of sales move in base units. This multiplication is the
    // whole of "stock splitting": there is one pool, and a carton is twelve of
    // it, so nothing has to be converted.
    const perVariant = variant?.unitsPerVariant ?? 1;

    return {
      productId: product.id,
      variantId: variant?.id ?? null,
      // Snapshotted: renaming the variant later must not rewrite an invoice
      // that has been printed and filed.
      variantName: variant?.name ?? null,
      description: line.description ?? (variant ? `${product.name} - ${variant.name}` : product.name),
      quantity: line.quantity,
      baseQuantity: line.quantity * perVariant,
      unitPriceCents,
      discountCents,
      taxRateBp,
      lineTotalCents: totals.lineTotalCents,
    };
  });
}

// ── sales orders ───────────────────────────────────────────────────────

export interface CreateOrderInput {
  companyId: string;
  customerId: string;
  branchId?: string | null;
  lines: DraftLine[];
  channel?: "CONSOLE" | "POS" | "FIELD";
  visitId?: string | null;
  note?: string | null;
  deliveryDate?: Date | null;
  clientUuid?: string | null;
  createdById?: string | null;
  /** Confirm immediately — the mobile app always does; the console may draft. */
  confirm?: boolean;
}

export async function createSalesOrder(input: CreateOrderInput) {
  const lines = await resolveLines(input.companyId, input.lines);
  const totals = computeTotals(lines);
  const number = await nextNumber(input.companyId, "ORDER");

  const order = await db.salesOrder.create({
    data: {
      companyId: input.companyId,
      customerId: input.customerId,
      branchId: input.branchId ?? null,
      number,
      status: input.confirm === false ? "DRAFT" : "CONFIRMED",
      channel: input.channel ?? "CONSOLE",
      visitId: input.visitId ?? null,
      note: input.note ?? null,
      deliveryDate: input.deliveryDate ?? null,
      clientUuid: input.clientUuid ?? null,
      createdById: input.createdById ?? null,
      subtotalCents: totals.subtotalCents,
      discountCents: totals.discountCents,
      taxCents: totals.taxCents,
      totalCents: totals.totalCents,
      lines: { create: lines },
    },
    include: { lines: true, customer: true },
  });

  await db.customerActivity.create({
    data: {
      companyId: input.companyId,
      customerId: input.customerId,
      userId: input.createdById ?? null,
      type: "ORDER",
      subject: `Order ${number}`,
      body: `${lines.length} line(s), ${formatKES(totals.totalCents)}`,
    },
  });

  await sendTemplated({
    companyId: input.companyId,
    templateKey: "ORDER_CONFIRMATION",
    customerId: input.customerId,
    toPhone: order.customer.phone,
    vars: {
      customer: order.customer.name,
      number,
      amount: formatKES(totals.totalCents),
      company: "",
    },
  });

  return order;
}

// ── invoices ───────────────────────────────────────────────────────────

export interface CreateInvoiceInput {
  companyId: string;
  customerId: string;
  branchId?: string | null;
  locationId?: string | null;
  orderId?: string | null;
  lines: DraftLine[];
  channel?: "CONSOLE" | "POS" | "FIELD";
  visitId?: string | null;
  note?: string | null;
  dueDate?: Date | null;
  clientUuid?: string | null;
  createdById?: string | null;
  /** Issue immediately (moves stock and customer balance) or leave as draft. */
  issue?: boolean;
}

/**
 * Creates an invoice and, when issued, applies every consequence atomically:
 * stock leaves the selling location, the customer's receivable grows, and any
 * linked order is marked invoiced.
 */
export async function createInvoice(input: CreateInvoiceInput) {
  const lines = await resolveLines(input.companyId, input.lines);
  const totals = computeTotals(lines);
  const number = await nextNumber(input.companyId, "INVOICE");
  const issue = input.issue !== false;

  const customer = await db.customer.findFirst({
    where: { id: input.customerId, companyId: input.companyId },
  });
  if (!customer) throw new Error("Customer not found");

  const dueDate =
    input.dueDate ??
    (customer.paymentTermsDays > 0
      ? new Date(Date.now() + customer.paymentTermsDays * 86_400_000)
      : null);

  const invoice = await db.$transaction(async (tx) => {
    const created = await tx.invoice.create({
      data: {
        companyId: input.companyId,
        customerId: input.customerId,
        branchId: input.branchId ?? null,
        locationId: input.locationId ?? null,
        orderId: input.orderId ?? null,
        number,
        status: issue ? "ISSUED" : "DRAFT",
        channel: input.channel ?? "CONSOLE",
        visitId: input.visitId ?? null,
        note: input.note ?? null,
        dueDate,
        clientUuid: input.clientUuid ?? null,
        createdById: input.createdById ?? null,
        subtotalCents: totals.subtotalCents,
        discountCents: totals.discountCents,
        taxCents: totals.taxCents,
        totalCents: totals.totalCents,
        lines: { create: lines },
      },
      include: { lines: true },
    });

    if (issue) {
      await consumeForSale(tx, {
        companyId: input.companyId,
        locationId: input.locationId ?? null,
        // baseQuantity, not quantity: two cartons of twelve take twenty-four
        // units off the shelf. Falling back to quantity keeps lines written
        // before variants existed correct.
        lines: created.lines.map((l) => ({
          productId: l.productId,
          quantity: l.baseQuantity || l.quantity,
        })),
        refType: "INVOICE",
        refId: created.id,
        createdById: input.createdById,
      });

      await tx.customer.update({
        where: { id: input.customerId },
        data: { balanceCents: { increment: totals.totalCents } },
      });

      if (input.orderId) {
        await tx.salesOrder.update({
          where: { id: input.orderId },
          data: { status: "INVOICED" },
        });
      }

      // Inside the same transaction on purpose: an invoice that exists without
      // its journal entry is a silent hole in the books, and the only way to
      // guarantee they arrive together is to let one roll the other back.
      await postInvoice(tx, created, input.createdById ?? null);
    }

    return created;
  }, {
    // SQLite serialises writers, and this transaction now also posts to the
    // ledger. The 5s default was enough to fail a legitimate sale under load,
    // and a sale failing because bookkeeping was slow is the wrong trade.
    timeout: 15_000,
  });

  // eTIMS AFTER the commit, never inside it. A Digitax round trip holds
  // SQLite's single write lock for as long as the network takes, which would
  // block every other writer and eventually fail the sale that triggered it.
  //
  // And it must never fail the sale: a company that cannot reach KRA still has
  // a customer in front of it. Anything that goes wrong leaves the invoice
  // queued for the runner.
  await queueInvoice(invoice.id, input.companyId).catch(() => {});

  return invoice;
}

/** Issues a previously drafted invoice, applying the same consequences. */
export async function issueInvoice(invoiceId: string, userId: string) {
  const issued = await db.$transaction(async (tx) => {
    const invoice = await tx.invoice.findUnique({
      where: { id: invoiceId },
      include: { lines: true },
    });
    if (!invoice) throw new Error("Invoice not found");
    if (invoice.status !== "DRAFT") throw new Error("Only draft invoices can be issued");

    await consumeForSale(tx, {
      companyId: invoice.companyId,
      locationId: invoice.locationId,
      lines: invoice.lines.map((l) => ({
        productId: l.productId,
        quantity: l.baseQuantity || l.quantity,
      })),
      refType: "INVOICE",
      refId: invoice.id,
      createdById: userId,
    });

    await tx.customer.update({
      where: { id: invoice.customerId },
      data: { balanceCents: { increment: invoice.totalCents } },
    });

    return tx.invoice.update({
      where: { id: invoiceId },
      data: { status: "ISSUED" },
    });
  }, {
    // SQLite serialises writers, and this transaction now also posts to the
    // ledger. The 5s default was enough to fail a legitimate sale under load,
    // and a sale failing because bookkeeping was slow is the wrong trade.
    timeout: 15_000,
  });

  // eTIMS AFTER the commit, never inside it. A Digitax round trip holds
  // SQLite's single write lock for as long as the network takes, which would
  // block every other writer and eventually fail the sale that triggered it.
  //
  // And it can never fail the sale: a company that cannot reach KRA must still
  // be able to serve the customer in front of them. Anything that goes wrong
  // leaves the invoice queued, to be retried by the runner.
  await queueInvoice(issued.id, issued.companyId).catch(() => {});

  return issued;
}

// ── payments ───────────────────────────────────────────────────────────

export interface RecordPaymentInput {
  companyId: string;
  customerId: string;
  amountCents: number;
  method?: string;
  reference?: string | null;
  paidAt?: Date;
  note?: string | null;
  visitId?: string | null;
  clientUuid?: string | null;
  createdById?: string | null;
  /** Explicit allocations; when omitted the payment is applied oldest-first. */
  allocations?: Array<{ invoiceId: string; amountCents: number }>;
}

/**
 * Records a customer payment and allocates it across invoices.
 *
 * Default allocation is oldest-due-first, which is what a distributor's
 * collections clerk does by hand and what keeps the ageing report meaningful.
 * Unallocated remainder stays as a credit on the customer balance.
 */
export async function recordPayment(input: RecordPaymentInput) {
  if (input.amountCents <= 0) throw new Error("Payment amount must be positive");

  const number = await nextNumber(input.companyId, "PAYMENT");

  return db.$transaction(async (tx) => {
    const payment = await tx.payment.create({
      data: {
        companyId: input.companyId,
        customerId: input.customerId,
        number,
        amountCents: input.amountCents,
        method: input.method ?? "CASH",
        reference: input.reference ?? null,
        paidAt: input.paidAt ?? new Date(),
        note: input.note ?? null,
        visitId: input.visitId ?? null,
        clientUuid: input.clientUuid ?? null,
        createdById: input.createdById ?? null,
      },
    });

    let allocations = input.allocations;

    if (!allocations) {
      const open = await tx.invoice.findMany({
        where: {
          companyId: input.companyId,
          customerId: input.customerId,
          status: { in: ["ISSUED", "PARTIALLY_PAID", "OVERDUE"] },
        },
        orderBy: [{ dueDate: "asc" }, { issueDate: "asc" }],
      });

      allocations = [];
      let remaining = input.amountCents;
      for (const invoice of open) {
        if (remaining <= 0) break;
        const outstanding = invoice.totalCents - invoice.paidCents;
        if (outstanding <= 0) continue;
        const amount = Math.min(remaining, outstanding);
        allocations.push({ invoiceId: invoice.id, amountCents: amount });
        remaining -= amount;
      }
    }

    for (const allocation of allocations) {
      const invoice = await tx.invoice.findFirst({
        where: { id: allocation.invoiceId, companyId: input.companyId },
      });
      if (!invoice) continue;

      const paidCents = invoice.paidCents + allocation.amountCents;

      await tx.paymentAllocation.create({
        data: {
          paymentId: payment.id,
          invoiceId: invoice.id,
          amountCents: allocation.amountCents,
        },
      });

      await tx.invoice.update({
        where: { id: invoice.id },
        data: {
          paidCents,
          status: deriveInvoiceStatus({
            totalCents: invoice.totalCents,
            paidCents,
            dueDate: invoice.dueDate,
            current: invoice.status,
          }),
        },
      });
    }

    const customer = await tx.customer.update({
      where: { id: input.customerId },
      data: { balanceCents: { decrement: input.amountCents } },
    });

    await tx.customerActivity.create({
      data: {
        companyId: input.companyId,
        customerId: input.customerId,
        userId: input.createdById ?? null,
        type: "PAYMENT",
        subject: `Payment ${number}`,
        body: `${formatKES(input.amountCents)} via ${input.method ?? "CASH"}`,
      },
    });

    await postPayment(tx, payment, input.createdById ?? null);

    return { payment, customer };
  }, {
    // SQLite serialises writers, and this transaction now also posts to the
    // ledger. The 5s default was enough to fail a legitimate sale under load,
    // and a sale failing because bookkeeping was slow is the wrong trade.
    timeout: 15_000,
  });
}

/** Fired after `recordPayment` commits, so a failed SMS cannot roll back money. */
export async function notifyPayment(params: {
  companyId: string;
  customerId: string;
  amountCents: number;
  balanceCents: number;
  phone: string | null;
  customerName: string;
}) {
  await sendTemplated({
    companyId: params.companyId,
    templateKey: "PAYMENT_RECEIPT",
    customerId: params.customerId,
    toPhone: params.phone,
    vars: {
      customer: params.customerName,
      amount: formatKES(params.amountCents),
      balance: formatKES(params.balanceCents),
      date: new Date().toLocaleDateString("en-KE"),
      company: "",
    },
  });
}

/**
 * Recomputes OVERDUE status across a company. Cheap enough to run on dashboard
 * load; invoice status is otherwise only recalculated when money moves, so a
 * due date passing overnight would go unnoticed.
 */
export async function refreshOverdueStatuses(companyId: string): Promise<number> {
  const now = new Date();
  const result = await db.invoice.updateMany({
    where: {
      companyId,
      status: { in: ["ISSUED", "PARTIALLY_PAID"] },
      dueDate: { lt: now },
    },
    data: { status: "OVERDUE" },
  });
  return result.count;
}
