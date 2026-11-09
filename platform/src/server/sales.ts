import "server-only";

import type { Prisma, PrismaClient } from "@prisma/client";

import { ApiError, notFound } from "@/lib/api";
import { db } from "@/lib/db";
import {
  computeLine,
  computeTotals,
  deriveInvoiceStatus,
  formatKES,
  outstandingCents,
} from "@/lib/money";
import { nextNumber } from "@/lib/numbering";

import { GATEWAY_METHODS, MPESA_CODE_PATTERN } from "@/lib/payments";
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

type Tx = Prisma.TransactionClient;
type Client = Tx | PrismaClient;

const invalid = (message: string, details?: unknown) =>
  new ApiError(422, "INVALID_ALLOCATION", message, details);

// ── derived figures ────────────────────────────────────────────────────

/**
 * What has been credited back against each invoice, by invoice id.
 *
 * Cancelled credit notes are excluded: a cancelled note never reduced the debt.
 * Invoices with no credit are simply absent from the map, so read with `?? 0`.
 */
export async function creditedByInvoice(
  client: Client,
  invoiceIds: string[],
): Promise<Map<string, number>> {
  if (invoiceIds.length === 0) return new Map();
  const grouped = await client.creditNote.groupBy({
    by: ["invoiceId"],
    where: { invoiceId: { in: invoiceIds }, status: { not: "CANCELLED" } },
    _sum: { totalCents: true },
  });
  return new Map(grouped.map((g) => [g.invoiceId, g._sum.totalCents ?? 0]));
}

/**
 * Rebuilds `Customer.balanceCents` from the documents that define it.
 *
 *   balance = Σ non-draft invoice totals (cancelled included)
 *           − Σ payments
 *           − Σ non-cancelled credit note totals
 *
 * Cancelled invoices stay in the first sum because the only way an issued
 * invoice becomes cancelled is a credit note for its full value, which is in
 * the third sum; dropping both would be right, dropping one would not.
 *
 * Called at the end of every write that moves the balance, in that write's
 * transaction, instead of incrementing or decrementing a stored figure. Blind
 * increments drift the first time a write is retried, replayed from the
 * offline outbox or half-applied, and nothing ever pulls them back. A
 * recomputation cannot drift; it can only be wrong if the documents are.
 */
export async function recomputeCustomerBalance(tx: Client, customerId: string) {
  const [invoices, payments, credits] = await Promise.all([
    tx.invoice.aggregate({
      where: { customerId, status: { not: "DRAFT" } },
      _sum: { totalCents: true },
    }),
    tx.payment.aggregate({ where: { customerId }, _sum: { amountCents: true } }),
    tx.creditNote.aggregate({
      where: { customerId, status: { not: "CANCELLED" } },
      _sum: { totalCents: true },
    }),
  ]);

  const balanceCents =
    (invoices._sum.totalCents ?? 0) -
    (payments._sum.amountCents ?? 0) -
    (credits._sum.totalCents ?? 0);

  return tx.customer.update({
    where: { id: customerId },
    data: { balanceCents },
  });
}

// ── lines ──────────────────────────────────────────────────────────────

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
export async function resolveLines(client: Client, companyId: string, lines: DraftLine[]) {
  if (lines.length === 0) throw new Error("At least one line is required");

  const products = await client.product.findMany({
    where: { companyId, id: { in: lines.map((l) => l.productId) } },
  });
  const byId = new Map(products.map((p) => [p.id, p]));

  // Variants are looked up scoped to the company, so an id from another tenant
  // resolves to nothing and is rejected rather than silently priced.
  const variantIds = lines
    .map((l) => l.variantId)
    .filter((v): v is string => typeof v === "string" && v.length > 0);
  const variants = variantIds.length
    ? await client.productVariant.findMany({ where: { companyId, id: { in: variantIds } } })
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
  /** The quotation this order was raised from, when converted. */
  quotationId?: string | null;
  /** Confirm immediately — the mobile app always does; the console may draft. */
  confirm?: boolean;
}

/**
 * Creates an order with its lines and the customer's activity entry in one
 * transaction, numbered inside it, so a failure anywhere leaves nothing behind
 * — no half-order, no activity pointing at an order that does not exist, and
 * no burnt SO number. The confirmation SMS is queued after the commit and can
 * never fail the order: a rep without network has still taken the order.
 */
export async function createSalesOrder(input: CreateOrderInput) {
  const order = await db.$transaction(
    async (tx) => {
      const customer = await tx.customer.findFirst({
        where: { id: input.customerId, companyId: input.companyId },
        select: { id: true },
      });
      if (!customer) throw notFound("Customer not found");

      const lines = await resolveLines(tx, input.companyId, input.lines);
      const totals = computeTotals(lines);
      const number = await nextNumber(input.companyId, "ORDER", tx);

      const created = await tx.salesOrder.create({
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
          quotationId: input.quotationId ?? null,
          subtotalCents: totals.subtotalCents,
          discountCents: totals.discountCents,
          taxCents: totals.taxCents,
          totalCents: totals.totalCents,
          lines: { create: lines },
        },
        include: { lines: true, customer: true },
      });

      await tx.customerActivity.create({
        data: {
          companyId: input.companyId,
          customerId: input.customerId,
          userId: input.createdById ?? null,
          type: "ORDER",
          subject: `Order ${number}`,
          body: `${lines.length} line(s), ${formatKES(totals.totalCents)}`,
        },
      });

      return created;
    },
    { timeout: 15_000 },
  );

  // After the commit, and swallowed: the order exists whether or not the
  // message can be queued, and a messaging fault must not look like a failed
  // sale to the rep.
  await sendTemplated({
    companyId: input.companyId,
    templateKey: "ORDER_CONFIRMATION",
    customerId: input.customerId,
    toPhone: order.customer.phone,
    vars: {
      customer: order.customer.name,
      number: order.number,
      amount: formatKES(order.totalCents),
      company: "",
    },
  }).catch((error) => {
    console.error("[sales] order confirmation SMS not queued", order.number, error);
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
 * stock leaves the selling location, the customer's receivable grows, the
 * journal entry is written, and any linked order is marked invoiced.
 */
export async function createInvoice(input: CreateInvoiceInput) {
  const issue = input.issue !== false;

  const customer = await db.customer.findFirst({
    where: { id: input.customerId, companyId: input.companyId },
  });
  if (!customer) throw notFound("Customer not found");

  const dueDate =
    input.dueDate ??
    (customer.paymentTermsDays > 0
      ? new Date(Date.now() + customer.paymentTermsDays * 86_400_000)
      : null);

  const invoice = await db.$transaction(async (tx) => {
    const lines = await resolveLines(tx, input.companyId, input.lines);
    const totals = computeTotals(lines);
    // Inside the transaction: a rolled-back invoice must not burn its number,
    // and two invoices racing must not share one.
    const number = await nextNumber(input.companyId, "INVOICE", tx);

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
      await applyIssueConsequences(tx, created, input.createdById ?? null);

      if (input.orderId) {
        await tx.salesOrder.update({
          where: { id: input.orderId },
          data: { status: "INVOICED" },
        });
      }
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

/**
 * Everything issuing an invoice does besides flipping its status, shared by
 * create-and-issue and issue-later so the two can never diverge: stock leaves,
 * the journal entry is written, the customer's balance is rebuilt.
 *
 * The journal entry is inside the same transaction on purpose. An invoice that
 * exists without its entry is a silent hole in the books, and the only way to
 * guarantee they arrive together is to let one roll the other back.
 */
async function applyIssueConsequences(
  tx: Tx,
  invoice: {
    id: string;
    companyId: string;
    customerId: string;
    locationId: string | null;
    number: string;
    issueDate: Date;
    subtotalCents: number;
    discountCents: number;
    taxCents: number;
    totalCents: number;
    lines: Array<{ productId: string; quantity: number; baseQuantity: number }>;
  },
  userId: string | null,
) {
  await consumeForSale(tx, {
    companyId: invoice.companyId,
    locationId: invoice.locationId,
    // baseQuantity, not quantity: two cartons of twelve take twenty-four
    // units off the shelf. Falling back to quantity keeps lines written
    // before variants existed correct.
    lines: invoice.lines.map((l) => ({
      productId: l.productId,
      quantity: l.baseQuantity || l.quantity,
    })),
    refType: "INVOICE",
    refId: invoice.id,
    createdById: userId,
  });

  await postInvoice(tx, invoice, userId);
  await recomputeCustomerBalance(tx, invoice.customerId);
}

/** Issues a previously drafted invoice, applying the same consequences. */
export async function issueInvoice(invoiceId: string, userId: string, companyId?: string) {
  const issued = await db.$transaction(async (tx) => {
    const invoice = await tx.invoice.findFirst({
      where: { id: invoiceId, ...(companyId ? { companyId } : {}) },
      include: { lines: true },
    });
    if (!invoice) throw notFound("Invoice not found");
    if (invoice.status !== "DRAFT") {
      throw new ApiError(409, "CONFLICT", "Only draft invoices can be issued");
    }

    // Status first, so the issue date on the entry is the date it was issued
    // rather than the date it was drafted.
    const updated = await tx.invoice.update({
      where: { id: invoiceId },
      data: { status: "ISSUED", issueDate: new Date() },
      include: { lines: true },
    });

    await applyIssueConsequences(tx, updated, userId);

    return updated;
  }, {
    timeout: 15_000,
  });

  // eTIMS AFTER the commit, never inside it — see createInvoice.
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
  /**
   * Runs inside the payment's transaction, after the payment row exists and
   * before anything commits. Used to link a document to the payment — a
   * gateway intent, say — so the link and the money can only arrive together.
   */
  inTransaction?: (tx: Tx, payment: { id: string; number: string }) => Promise<void>;
}

/** Methods a payment may carry. A credit note is a document, not a method. */
const PAYMENT_METHODS = new Set([
  "CASH",
  "MPESA",
  "MPESA_STK",
  "BANK",
  "CHEQUE",
  "PAYSTACK",
  "KCB_BUNI",
]);

/**
 * Records a customer payment and allocates it across invoices.
 *
 * Default allocation is oldest-due-first, which is what a distributor's
 * collections clerk does by hand and what keeps the ageing report meaningful.
 * Explicit allocations are checked rather than trusted: each must name an
 * issued invoice of this customer in this company, none may exceed what that
 * invoice still owes net of credit notes, and together they may not exceed the
 * payment. Unallocated remainder stays as a credit on the customer balance.
 */
export async function recordPayment(input: RecordPaymentInput) {
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    throw new ApiError(422, "INVALID_AMOUNT", "Payment amount must be a positive whole number of cents");
  }

  const method = input.method ?? "CASH";
  if (method === "CREDIT_NOTE") {
    // A credit note reduces what the customer owes without any cash arriving.
    // Booked as a payment it would debit Cash for money that never came in.
    throw new ApiError(
      422,
      "INVALID_METHOD",
      "A credit note is not a payment method. Raise a credit note against the invoice instead.",
    );
  }
  if (!PAYMENT_METHODS.has(method)) {
    throw new ApiError(422, "INVALID_METHOD", `Unknown payment method: ${method}`);
  }
  // A gateway method (MPESA_STK, PAYSTACK, KCB_BUNI) means "the provider
  // confirmed this", and only settleIntent can say so — it books under the
  // `intent:<id>` clientUuid. A handset or a REST caller naming one of these
  // is asserting money moved without the provider's word for it.
  if (GATEWAY_METHODS.has(method) && !input.clientUuid?.startsWith("intent:")) {
    throw new ApiError(
      422,
      "INVALID_METHOD",
      `${method} payments are booked by the gateway when it confirms the collection. Use /payments/initiate to collect, or MPESA to record a code the customer already paid.`,
    );
  }
  // A manual M-Pesa record must carry the confirmation code the customer
  // quotes — ten upper-case letters and digits — and each code can only be
  // recorded once per company. Two reps keying the same SMS is the commonest
  // way a customer is credited twice.
  if (method === "MPESA") {
    const code = (input.reference ?? "").trim().toUpperCase();
    if (!MPESA_CODE_PATTERN.test(code)) {
      throw new ApiError(
        422,
        "INVALID_REFERENCE",
        "An M-Pesa payment needs the 10-character confirmation code from the customer's SMS (for example QHX7K2M9PL)",
      );
    }
    const reused = await db.payment.findFirst({
      where: { companyId: input.companyId, method: "MPESA", reference: code },
      select: { number: true },
    });
    if (reused) {
      throw new ApiError(409, "DUPLICATE_REFERENCE", `M-Pesa code ${code} was already recorded as payment ${reused.number}`);
    }
    input = { ...input, reference: code };
  }

  return db.$transaction(async (tx) => {
    // The customer must be this company's. Taken inside the transaction so
    // the row cannot vanish between the check and the write.
    const owner = await tx.customer.findFirst({
      where: { id: input.customerId, companyId: input.companyId },
      select: { id: true },
    });
    if (!owner) throw notFound("Customer not found");

    const allocations = input.allocations
      ? await validateAllocations(tx, input)
      : await autoAllocate(tx, input);

    const number = await nextNumber(input.companyId, "PAYMENT", tx);

    const payment = await tx.payment.create({
      data: {
        companyId: input.companyId,
        customerId: input.customerId,
        number,
        amountCents: input.amountCents,
        method,
        reference: input.reference ?? null,
        paidAt: input.paidAt ?? new Date(),
        note: input.note ?? null,
        visitId: input.visitId ?? null,
        clientUuid: input.clientUuid ?? null,
        createdById: input.createdById ?? null,
      },
    });

    for (const allocation of allocations) {
      const paidCents = allocation.invoice.paidCents + allocation.amountCents;

      await tx.paymentAllocation.create({
        data: {
          paymentId: payment.id,
          invoiceId: allocation.invoice.id,
          amountCents: allocation.amountCents,
        },
      });

      await tx.invoice.update({
        where: { id: allocation.invoice.id },
        data: {
          paidCents,
          status: deriveInvoiceStatus({
            totalCents: allocation.invoice.totalCents,
            paidCents,
            creditedCents: allocation.creditedCents,
            dueDate: allocation.invoice.dueDate,
            current: allocation.invoice.status,
          }),
        },
      });
    }

    await tx.customerActivity.create({
      data: {
        companyId: input.companyId,
        customerId: input.customerId,
        userId: input.createdById ?? null,
        type: "PAYMENT",
        subject: `Payment ${number}`,
        body: `${formatKES(input.amountCents)} via ${method}`,
      },
    });

    await postPayment(tx, payment, input.createdById ?? null);

    if (input.inTransaction) await input.inTransaction(tx, payment);

    const customer = await recomputeCustomerBalance(tx, input.customerId);

    return { payment, customer };
  }, {
    // SQLite serialises writers, and this transaction now also posts to the
    // ledger. The 5s default was enough to fail a legitimate sale under load,
    // and a sale failing because bookkeeping was slow is the wrong trade.
    timeout: 15_000,
  });
}

interface ResolvedAllocation {
  invoice: {
    id: string;
    customerId: string;
    status: string;
    totalCents: number;
    paidCents: number;
    dueDate: Date | null;
  };
  creditedCents: number;
  amountCents: number;
}

const OPEN_STATUSES = ["ISSUED", "PARTIALLY_PAID", "OVERDUE"];

/** Oldest-due-first, against what each invoice still owes net of credits. */
async function autoAllocate(tx: Tx, input: RecordPaymentInput): Promise<ResolvedAllocation[]> {
  const open = await tx.invoice.findMany({
    where: {
      companyId: input.companyId,
      customerId: input.customerId,
      status: { in: OPEN_STATUSES },
    },
    orderBy: [{ dueDate: "asc" }, { issueDate: "asc" }],
  });
  const credited = await creditedByInvoice(tx, open.map((i) => i.id));

  const allocations: ResolvedAllocation[] = [];
  let remaining = input.amountCents;
  for (const invoice of open) {
    if (remaining <= 0) break;
    const creditedCents = credited.get(invoice.id) ?? 0;
    const outstanding = outstandingCents({ ...invoice, creditedCents });
    if (outstanding <= 0) continue;
    const amount = Math.min(remaining, outstanding);
    allocations.push({ invoice, creditedCents, amountCents: amount });
    remaining -= amount;
  }
  return allocations;
}

/**
 * Checks caller-supplied allocations. Every failure is a 422 naming the
 * invoice, never a silent skip: an allocation the caller asked for and did not
 * get leaves the invoice open and the money floating on the balance, which is
 * exactly the kind of difference nobody finds until the customer disputes it.
 */
async function validateAllocations(
  tx: Tx,
  input: RecordPaymentInput,
): Promise<ResolvedAllocation[]> {
  const requested = input.allocations ?? [];

  const seen = new Set<string>();
  let sum = 0;
  for (const a of requested) {
    if (!Number.isInteger(a.amountCents) || a.amountCents <= 0) {
      throw invalid("Each allocation must be a positive whole number of cents", { invoiceId: a.invoiceId });
    }
    if (seen.has(a.invoiceId)) {
      throw invalid("An invoice can appear only once in a payment's allocations", { invoiceId: a.invoiceId });
    }
    seen.add(a.invoiceId);
    sum += a.amountCents;
  }
  if (sum > input.amountCents) {
    throw invalid(
      `Allocations total ${formatKES(sum)} but the payment is ${formatKES(input.amountCents)}`,
      { allocatedCents: sum, amountCents: input.amountCents },
    );
  }

  const invoices = await tx.invoice.findMany({
    where: { id: { in: [...seen] }, companyId: input.companyId },
  });
  const byId = new Map(invoices.map((i) => [i.id, i]));
  const credited = await creditedByInvoice(tx, invoices.map((i) => i.id));

  return requested.map((a) => {
    const invoice = byId.get(a.invoiceId);
    if (!invoice) throw invalid("Unknown invoice in allocations", { invoiceId: a.invoiceId });
    if (invoice.customerId !== input.customerId) {
      throw invalid(`Invoice ${invoice.number} belongs to a different customer`, { invoiceId: invoice.id });
    }
    if (invoice.status === "DRAFT" || invoice.status === "CANCELLED") {
      throw invalid(`Invoice ${invoice.number} is ${invoice.status.toLowerCase()} and cannot take a payment`, {
        invoiceId: invoice.id,
      });
    }
    const creditedCents = credited.get(invoice.id) ?? 0;
    const outstanding = outstandingCents({ ...invoice, creditedCents });
    if (a.amountCents > outstanding) {
      throw invalid(
        `Invoice ${invoice.number} has ${formatKES(outstanding)} outstanding; cannot allocate ${formatKES(a.amountCents)}`,
        { invoiceId: invoice.id, outstandingCents: outstanding, amountCents: a.amountCents },
      );
    }
    return { invoice, creditedCents, amountCents: a.amountCents };
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
