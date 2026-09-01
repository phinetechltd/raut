import "server-only";

import { db } from "@/lib/db";
import {
  adapterFor,
  credentialFingerprint,
  isAlreadySubmitted,
  isRetryable,
  paymentTypeCode,
  taxTypeForRate,
  type EtimsAdapter,
  type EtimsCredentials,
  type EtimsResult,
  type SaleLine,
  type SaleResult,
} from "@/lib/etims";
import { resolveEtimsCredentials } from "./credentials";

/**
 * Transmitting documents to KRA.
 *
 * Everything here is per company. There is no platform-wide eTIMS account and
 * no path by which one company's document reaches another company's Digitax
 * business — `contextFor` resolves credentials from the tenant vault on every
 * call and returns nothing at all when a company has none.
 *
 * Nothing in this module is called from inside a database transaction. A
 * Digitax round trip holds SQLite's single write lock for as long as the
 * network takes, which would block every other writer and eventually fail the
 * sale that triggered it — the same deadlock already fixed once in
 * `nextNumber`. Invoices are queued after their transaction commits.
 */

export interface EtimsContext {
  companyId: string;
  adapter: EtimsAdapter;
  creds: EtimsCredentials;
  fingerprint: string;
  config: NonNullable<Awaited<ReturnType<typeof loadConfig>>>;
}

async function loadConfig(companyId: string) {
  return db.etimsConfig.findUnique({ where: { companyId } });
}

/** Whether this company has eTIMS licensed. Purely the commercial gate. */
export async function isLicensed(companyId: string): Promise<boolean> {
  const row = await db.companyModule.findFirst({
    where: { companyId, moduleKey: "ETIMS", enabled: true },
    select: { id: true },
  });
  return Boolean(row);
}

/**
 * Everything needed to transmit for one company, or null.
 *
 * Returns null — quietly, and without error — when the company has not bought
 * eTIMS or has it switched off. That is not a failure: it is the normal state
 * of most companies on the platform, and callers treat it as "nothing to do".
 *
 * Throws only when a company is switched ON and cannot transmit, because that
 * *is* a failure the company needs to see.
 */
export async function contextFor(companyId: string): Promise<EtimsContext | null> {
  const config = await loadConfig(companyId);
  if (!config?.enabled) return null;
  if (!(await isLicensed(companyId))) return null;

  const creds = await resolveEtimsCredentials(companyId);
  const adapter = adapterFor(config.environment, Boolean(creds));

  if (!adapter) {
    throw new Error(
      "eTIMS is switched on and set to LIVE, but this company has no Digitax API key stored. " +
        "Add one in Settings, or switch the environment back to sandbox.",
    );
  }

  // The console adapter needs no real credentials, but the rest of the code
  // wants the same shape.
  const resolved: EtimsCredentials = creds ?? {
    apiKey: "console",
    taxPin: config.taxPin ?? "CONSOLE",
    baseUrl: "console",
  };

  return {
    companyId,
    adapter,
    creds: resolved,
    fingerprint: credentialFingerprint(resolved),
    config,
  };
}

/**
 * Clears Digitax-side ids when the credential behind them has changed.
 *
 * `etimsItemCode`, `etimsCustomerId` and `etimsSaleId` are issued by one
 * Digitax business and mean nothing in another. If a company swaps its key for
 * a different business — a new PIN, a move from sandbox to live — every stored
 * id now points at another taxpayer's records, and submitting against them
 * would file this company's sales under that business.
 *
 * So the fingerprint is checked before anything is transmitted, and a change
 * retires the ids rather than trusting them.
 */
export async function reconcileCredentialChange(ctx: EtimsContext): Promise<boolean> {
  if (ctx.config.credentialFingerprint === ctx.fingerprint) return false;

  const { companyId } = ctx;
  await db.$transaction(async (tx) => {
    await tx.product.updateMany({
      where: { companyId, etimsItemCode: { not: null } },
      data: { etimsItemCode: null, etimsStatus: "UNREGISTERED", etimsSyncedAt: null },
    });
    await tx.customer.updateMany({
      where: { companyId, etimsCustomerId: { not: null } },
      data: { etimsCustomerId: null },
    });
    await tx.etimsConfig.update({
      where: { companyId },
      data: { credentialFingerprint: ctx.fingerprint },
    });
  });

  return true;
}

// ---------------------------------------------------------------------------
// Audit trail
// ---------------------------------------------------------------------------

async function record(
  ctx: EtimsContext,
  docType: string,
  docId: string,
  endpoint: string,
  result: EtimsResult<unknown>,
) {
  const attempts = await db.etimsSubmission.count({
    where: { companyId: ctx.companyId, docType, docId },
  });

  const retryable = !result.ok && isRetryable(result.httpStatus);

  return db.etimsSubmission.create({
    data: {
      companyId: ctx.companyId,
      docType,
      docId,
      attempt: attempts + 1,
      endpoint,
      status: result.ok ? "ACCEPTED" : retryable ? "PENDING" : "REJECTED",
      // Verbatim, because the question two years from now is what was sent,
      // not what today's code would send.
      request: result.request ? JSON.stringify(result.request) : null,
      response: result.response ? JSON.stringify(result.response) : null,
      httpStatus: result.httpStatus ?? null,
      error: result.error ?? null,
      retryAfter: retryable ? new Date(Date.now() + backoffMs(attempts + 1)) : null,
    },
  });
}

/** Exponential, capped at an hour. */
function backoffMs(attempt: number): number {
  return Math.min(60 * 60_000, 30_000 * 2 ** Math.min(attempt - 1, 7));
}

const MAX_ATTEMPTS = 8;

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/** Registers a product with eTIMS if it is not already. Idempotent. */
export async function ensureItemRegistered(ctx: EtimsContext, productId: string) {
  const product = await db.product.findFirst({
    where: { id: productId, companyId: ctx.companyId },
  });
  if (!product) throw new Error("Product not found in this company");
  if (product.etimsItemCode) return product;

  const c = ctx.config;
  const result = await ctx.adapter.registerItem(ctx.creds, {
    itemClassCode: product.etimsItemClassCode ?? c.defaultItemClassCode,
    itemTypeCode: product.etimsItemTypeCode ?? c.defaultItemTypeCode,
    itemName: product.name,
    originNationCode: product.etimsOriginNation ?? c.defaultOriginNation,
    packageUnitCode: product.etimsPackageUnit ?? c.defaultPackageUnit,
    quantityUnitCode: product.etimsQuantityUnit ?? c.defaultQuantityUnit,
    taxTypeCode: product.etimsTaxTypeCode ?? taxTypeForRate(product.taxRateBp),
    defaultUnitPrice: product.sellPriceCents / 100,
    // The SKU stands in when there is no barcode: eTIMS requires one on every
    // line, and a distributor's own code is a truthful identifier where an
    // EAN-13 does not exist.
    itemBarCode: product.barcode ?? product.sku,
    callbackUrl: callbackUrl(),
  });

  await record(ctx, "ITEM", product.id, "/items", result);

  return db.product.update({
    where: { id: product.id },
    data: result.ok
      ? {
          etimsItemCode: result.data?.etimsItemCode ?? result.data?.id ?? null,
          etimsStatus: "REGISTERED",
          etimsSyncedAt: new Date(),
          etimsError: null,
        }
      : { etimsStatus: "FAILED", etimsError: result.error ?? "Registration failed" },
  });
}

/** Registers a customer, but only one with a PIN — eTIMS requires the TIN. */
export async function ensureCustomerRegistered(ctx: EtimsContext, customerId: string) {
  const customer = await db.customer.findFirst({
    where: { id: customerId, companyId: ctx.companyId },
  });
  if (!customer) throw new Error("Customer not found in this company");
  if (customer.etimsCustomerId || !customer.taxPin) return customer;

  const result = await ctx.adapter.registerCustomer(ctx.creds, {
    name: customer.name,
    taxPin: customer.taxPin,
    phone: customer.phone,
  });

  await record(ctx, "CUSTOMER", customer.id, "/customers", result);

  if (!result.ok) return customer;

  return db.customer.update({
    where: { id: customer.id },
    data: { etimsCustomerId: result.data?.id ?? null },
  });
}

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------

/**
 * Marks an invoice for transmission.
 *
 * Called after `createInvoice` has committed. It only sets status: the actual
 * send happens in `transmitInvoice`, driven either straight after queueing (when
 * auto-transmit is on) or by the runner. Separating them means a Digitax outage
 * delays a filing instead of failing a sale.
 */
export async function queueInvoice(invoiceId: string, companyId: string): Promise<void> {
  let ctx: EtimsContext | null;
  try {
    ctx = await contextFor(companyId);
  } catch {
    // Switched on but misconfigured. The invoice is already issued and must
    // stand; the problem surfaces in Settings, not at the counter.
    return;
  }
  if (!ctx) return;

  const invoice = await db.invoice.findFirst({
    where: { id: invoiceId, companyId },
    select: { id: true, issueDate: true, status: true, etimsStatus: true },
  });
  if (!invoice) return;

  // A draft is not a tax document yet.
  if (invoice.status === "DRAFT") return;
  // Already queued or filed.
  if (invoice.etimsStatus !== "NOT_APPLICABLE") return;
  // Switching the feature on must not push the back catalogue at KRA.
  if (ctx.config.activeFrom && invoice.issueDate < ctx.config.activeFrom) return;

  await db.invoice.update({
    where: { id: invoiceId },
    data: { etimsStatus: "QUEUED" },
  });

  if (ctx.config.autoTransmit) {
    // Deliberately not awaited by the caller's request path — see transmitInvoice.
    await transmitInvoice(invoiceId, companyId).catch(() => {
      /* stays QUEUED; the runner will pick it up */
    });
  }
}

/**
 * Sends one invoice.
 *
 * Registration of the customer and every line item happens first, because a
 * sale referencing an unregistered item is rejected. Each step is idempotent,
 * so a retry resumes rather than restarting.
 */
export async function transmitInvoice(
  invoiceId: string,
  companyId: string,
): Promise<{ ok: boolean; reason?: string }> {
  const ctx = await contextFor(companyId);
  if (!ctx) return { ok: false, reason: "eTIMS is not enabled for this company" };

  await reconcileCredentialChange(ctx);

  const invoice = await db.invoice.findFirst({
    where: { id: invoiceId, companyId },
    include: {
      customer: true,
      lines: { include: { product: true } },
    },
  });
  if (!invoice) return { ok: false, reason: "Invoice not found" };
  if (invoice.etimsStatus === "ACCEPTED") return { ok: true };

  const attempts = await db.etimsSubmission.count({
    where: { companyId, docType: "SALE", docId: invoiceId },
  });
  if (attempts >= MAX_ATTEMPTS) {
    return { ok: false, reason: "Too many attempts; needs attention" };
  }

  if (invoice.customer.taxPin) {
    await ensureCustomerRegistered(ctx, invoice.customerId);
  }
  for (const line of invoice.lines) {
    await ensureItemRegistered(ctx, line.productId);
  }

  // Payment method drives the eTIMS payment type, so read what was actually
  // received rather than assuming cash.
  const payment = await db.paymentAllocation.findFirst({
    where: { invoiceId },
    include: { payment: { select: { method: true } } },
    orderBy: { id: "asc" },
  });

  const items: SaleLine[] = invoice.lines.map((l) => {
    const net = l.lineTotalCents - l.discountCents;
    const tax = Math.round((net * l.taxRateBp) / (10_000 + l.taxRateBp));

    // Filed in **base units**, not in cartons. eTIMS deducts stock from the
    // item it registered, and that item is the product; sending two cartons
    // would take two units off KRA's pool while twenty-four left the shelf,
    // and the difference compounds until a stock take cannot be explained.
    // The line total is authoritative, so the unit price is derived back from
    // it rather than the other way round.
    const units = l.baseQuantity || l.quantity;
    const unitPrice = units > 0 ? l.lineTotalCents / units / 100 : 0;

    return {
      id: l.product.etimsItemCode ?? l.productId,
      itemName: l.product.name,
      itemClassCode: l.product.etimsItemClassCode ?? ctx.config.defaultItemClassCode,
      itemBarCode: l.product.barcode ?? l.product.sku,
      taxTypeCode: l.product.etimsTaxTypeCode ?? taxTypeForRate(l.taxRateBp),
      quantity: units,
      unitPrice,
      totalAmount: l.lineTotalCents / 100,
      taxableAmount: (net - tax) / 100,
      taxAmount: tax / 100,
      discountAmount: l.discountCents ? l.discountCents / 100 : undefined,
      isStockable: l.product.trackStock,
      description: l.variantName ? `${l.description} (${l.variantName})` : l.description,
    };
  });

  const result = await ctx.adapter.submitSale(ctx.creds, {
    saleDate: invoice.issueDate.toISOString().slice(0, 10),
    traderInvoiceNumber: invoice.number,
    paymentTypeCode: paymentTypeCode(payment?.payment.method),
    // 02 = Approved. Raut only transmits invoices it has already issued.
    invoiceStatusCode: "02",
    customerTin: invoice.customer.taxPin,
    customerName: invoice.customer.name,
    callbackUrl: callbackUrl(),
    items,
  });

  await record(ctx, "SALE", invoice.id, "/sales-with-items", result);

  // Digitax already holds it. Read the authoritative status rather than
  // sending a second copy.
  if (!result.ok && isAlreadySubmitted(result.httpStatus)) {
    return { ok: false, reason: "Already submitted; awaiting reconciliation" };
  }

  if (!result.ok) {
    await db.invoice.update({
      where: { id: invoice.id },
      data: {
        etimsStatus: isRetryable(result.httpStatus) ? "QUEUED" : "REJECTED",
        etimsError: result.error ?? "Submission failed",
      },
    });
    return { ok: false, reason: result.error };
  }

  await applySaleResult("Invoice", invoice.id, result.data!);
  return { ok: true };
}

/** Writes a Digitax sale result onto an invoice or credit note. */
async function applySaleResult(
  model: "Invoice" | "CreditNote",
  id: string,
  sale: SaleResult,
) {
  const data = {
    etimsStatus: statusFor(sale.status),
    etimsSaleId: sale.id,
    etimsControlCode: sale.controlCode ?? null,
    etimsInvoiceNumber: sale.invoiceNumber ?? null,
    etimsSerialNumber: sale.serialNumber ?? null,
    etimsReceiptNumber: sale.receiptNumber ?? null,
    etimsQrUrl: sale.qrUrl ?? null,
    etimsOfflineUrl: sale.offlineUrl ?? null,
    etimsSubmittedAt: new Date(),
    etimsError: sale.status === "FAILED" ? "eTIMS rejected the transaction" : null,
  };

  if (model === "Invoice") {
    await db.invoice.update({ where: { id }, data });
  } else {
    await db.creditNote.update({ where: { id }, data });
  }
}

/**
 * Digitax status onto ours.
 *
 * SUBMITTED is the one that must not be treated as either success or a retry:
 * Digitax's own documentation says eTIMS synced but the final data never came
 * back, and the resolution is to contact support. Retrying would risk a
 * duplicate filing.
 */
function statusFor(digitax: string): string {
  switch (digitax) {
    case "COMPLETED":
    case "COMPLETE":
      return "ACCEPTED";
    case "FAILED":
      return "REJECTED";
    case "SUBMITTED":
      return "SUBMITTED";
    default:
      return "QUEUED";
  }
}

// ---------------------------------------------------------------------------
// Credit notes
// ---------------------------------------------------------------------------

/**
 * Marks a credit note for transmission, mirroring `queueInvoice`.
 *
 * Called before the send is attempted, so that a crash mid-transmission leaves
 * the note QUEUED for the runner rather than NOT_APPLICABLE and forgotten. An
 * unfiled reversal is worse than an unfiled sale: KRA still holds the original.
 */
export async function queueCreditNote(creditNoteId: string, companyId: string): Promise<void> {
  let ctx: EtimsContext | null;
  try {
    ctx = await contextFor(companyId);
  } catch {
    return;
  }
  if (!ctx) return;

  await db.creditNote.updateMany({
    where: { id: creditNoteId, companyId, etimsStatus: "NOT_APPLICABLE" },
    data: { etimsStatus: "QUEUED" },
  });
}

export async function transmitCreditNote(
  creditNoteId: string,
  companyId: string,
): Promise<{ ok: boolean; reason?: string }> {
  const ctx = await contextFor(companyId);
  if (!ctx) return { ok: false, reason: "eTIMS is not enabled for this company" };

  const note = await db.creditNote.findFirst({
    where: { id: creditNoteId, companyId },
    include: { invoice: true, lines: { include: { product: true } } },
  });
  if (!note) return { ok: false, reason: "Credit note not found" };
  if (note.etimsStatus === "ACCEPTED") return { ok: true };

  // A credit note references the original sale by its Digitax id. If the
  // invoice was never filed there is nothing to reverse at KRA, and sending
  // one would be a reversal of a sale KRA has no record of.
  if (!note.invoice.etimsSaleId) {
    return {
      ok: false,
      reason: "The original invoice has not been accepted by eTIMS yet",
    };
  }

  const result = await ctx.adapter.submitCreditNote(ctx.creds, {
    saleId: note.invoice.etimsSaleId,
    traderInvoiceNumber: note.invoice.number,
    returnDate: note.issueDate.toISOString().slice(0, 10),
    invoiceDetails: note.reason,
    callbackUrl: callbackUrl(),
    // Base units, matching how the sale was filed. Sending two cartons against
    // a sale KRA recorded as twenty-four bottles would credit two units and
    // leave twenty-two sold on their ledger for ever — the customer's return
    // would be complete on our books and invisible on theirs.
    items: note.lines.map((l) => {
      const units = l.baseQuantity || l.quantity;
      return {
        id: l.product.etimsItemCode ?? l.productId,
        quantity: units,
        unitPrice: units > 0 ? l.lineTotalCents / units / 100 : 0,
        totalAmount: l.lineTotalCents / 100,
        description: l.variantName ? `${l.description} (${l.variantName})` : l.description,
      };
    }),
  });

  await record(ctx, "CREDIT_NOTE", note.id, "/credit-notes", result);

  if (!result.ok) {
    await db.creditNote.update({
      where: { id: note.id },
      data: {
        etimsStatus: isRetryable(result.httpStatus) ? "QUEUED" : "REJECTED",
        etimsError: result.error ?? "Submission failed",
      },
    });
    return { ok: false, reason: result.error };
  }

  await applySaleResult("CreditNote", note.id, result.data!);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Stock
// ---------------------------------------------------------------------------

/**
 * Which stock movements eTIMS needs to hear about, and which it must not.
 *
 * Two exclusions matter more than the mapping itself:
 *
 * **Sales and returns are already reported.** A sale line marked stockable
 * deducts at KRA when the invoice is filed, and a return is carried by its
 * credit note. Reporting either again as an adjustment double-counts the
 * movement in KRA's stock ledger.
 *
 * **Internal transfers are not eTIMS transfers.** Digitax's `/stock/transfer`
 * moves goods *between businesses*; `TRANSFER_IN`/`TRANSFER_OUT` here move them
 * between one company's own stores, which changes nothing at the business level
 * KRA tracks.
 */
export function stockMovementFor(
  type: string,
  quantity: number,
): { action: "ADD" | "DEDUCT"; movementType: string } | null {
  switch (type) {
    case "PURCHASE":
      return { action: "ADD", movementType: "02" };
    case "OPENING":
      return { action: "ADD", movementType: "06" };
    case "ADJUSTMENT":
      return quantity >= 0
        ? { action: "ADD", movementType: "06" }
        : { action: "DEDUCT", movementType: "16" };
    case "WRITE_OFF":
      return { action: "DEDUCT", movementType: "15" };
    default:
      return null;
  }
}

export async function reportStockMovement(movementId: string, companyId: string) {
  const ctx = await contextFor(companyId);
  if (!ctx) return;

  const movement = await db.stockMovement.findFirst({
    where: { id: movementId, companyId },
    include: { product: true },
  });
  if (!movement) return;

  const mapped = stockMovementFor(movement.type, movement.quantity);
  if (!mapped) return;
  if (!movement.product.trackStock) return;

  const product = await ensureItemRegistered(ctx, movement.productId);
  if (!product.etimsItemCode) return;

  const result = await ctx.adapter.adjustStock(ctx.creds, {
    itemId: product.etimsItemCode,
    quantity: Math.abs(movement.quantity),
    action: mapped.action,
    movementType: mapped.movementType,
  });

  await record(ctx, "STOCK", movement.id, "/stock/adjust", result);
}

// ---------------------------------------------------------------------------
// Runner and reconciliation
// ---------------------------------------------------------------------------

/**
 * Drains what is outstanding, across every company.
 *
 * Credentials are resolved per document, not once per sweep — a single
 * resolution reused across tenants is exactly how one company's invoice would
 * be filed under another's PIN.
 */
export async function runPending(limit = 50): Promise<{
  invoices: number;
  creditNotes: number;
  stock: number;
  failures: number;
}> {
  const now = new Date();
  let invoices = 0;
  let creditNotes = 0;
  let stock = 0;
  let failures = 0;

  const pendingInvoices = await db.invoice.findMany({
    where: { etimsStatus: { in: ["QUEUED"] } },
    select: { id: true, companyId: true },
    orderBy: { issueDate: "asc" },
    take: limit,
  });

  for (const inv of pendingInvoices) {
    const due = await db.etimsSubmission.findFirst({
      where: { companyId: inv.companyId, docType: "SALE", docId: inv.id },
      orderBy: { createdAt: "desc" },
      select: { retryAfter: true, attempt: true },
    });
    if (due?.retryAfter && due.retryAfter > now) continue;
    if ((due?.attempt ?? 0) >= MAX_ATTEMPTS) continue;

    const r = await transmitInvoice(inv.id, inv.companyId).catch(() => ({ ok: false }));
    r.ok ? invoices++ : failures++;
  }

  const pendingNotes = await db.creditNote.findMany({
    where: { etimsStatus: "QUEUED" },
    select: { id: true, companyId: true },
    take: limit,
  });

  for (const n of pendingNotes) {
    const r = await transmitCreditNote(n.id, n.companyId).catch(() => ({ ok: false }));
    r.ok ? creditNotes++ : failures++;
  }

  // Stock is swept rather than hooked into applyMovement, for the same reason
  // invoices are queued after commit: applyMovement runs inside the caller's
  // transaction, and a network call there would hold SQLite's write lock.
  //
  // Only companies with eTIMS switched on are considered, and only movement
  // types eTIMS has not already heard about through a sale or a credit note.
  const enabled = await db.etimsConfig.findMany({
    where: { enabled: true },
    select: { companyId: true, activeFrom: true },
  });

  for (const cfg of enabled) {
    const movements = await db.stockMovement.findMany({
      where: {
        companyId: cfg.companyId,
        type: { in: ["PURCHASE", "OPENING", "ADJUSTMENT", "WRITE_OFF"] },
        ...(cfg.activeFrom ? { createdAt: { gte: cfg.activeFrom } } : {}),
      },
      select: { id: true },
      orderBy: { createdAt: "asc" },
      take: limit,
    });
    if (movements.length === 0) continue;

    const reported = new Set(
      (
        await db.etimsSubmission.findMany({
          where: {
            companyId: cfg.companyId,
            docType: "STOCK",
            docId: { in: movements.map((m) => m.id) },
            status: "ACCEPTED",
          },
          select: { docId: true },
        })
      ).map((r) => r.docId),
    );

    for (const m of movements) {
      if (reported.has(m.id)) continue;
      try {
        await reportStockMovement(m.id, cfg.companyId);
        stock++;
      } catch {
        failures++;
      }
    }
  }

  return { invoices, creditNotes, stock, failures };
}

/**
 * Re-reads one document's status from Digitax.
 *
 * This is what a callback triggers. The callback body itself is never written
 * to a control code: Digitax documents no signature on it, so anyone who learns
 * an invoice number could otherwise stamp a forged code onto a real invoice.
 * The payload is a hint that something changed; this fetches the truth.
 */
export async function reconcileInvoice(invoiceId: string, companyId: string) {
  const ctx = await contextFor(companyId);
  if (!ctx) return;

  const invoice = await db.invoice.findFirst({
    where: { id: invoiceId, companyId },
    select: { id: true, etimsSaleId: true },
  });
  if (!invoice?.etimsSaleId) return;

  const result = await ctx.adapter.fetchSale(ctx.creds, invoice.etimsSaleId);
  if (result.ok && result.data) await applySaleResult("Invoice", invoice.id, result.data);
}

/**
 * Where Digitax should send status updates.
 *
 * Same variable the payment callbacks already use. Null when it is unset, and
 * the callback field is simply omitted — a callback URL pointing at localhost
 * is worse than none, because Digitax would retry against it and the queue
 * would look healthy while nothing ever arrived.
 */
function callbackUrl(): string | null {
  const base = process.env.PUBLIC_BASE_URL;
  return base ? `${base.replace(/\/$/, "")}/api/v1/etims/callbacks` : null;
}
