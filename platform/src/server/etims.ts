import "server-only";

import { db } from "@/lib/db";
import { chargedLine } from "@/lib/money";
import {
  MAX_ATTEMPTS,
  adapterFor,
  backoffMs,
  baseUrlFor,
  credentialFingerprint,
  isAlreadySubmitted,
  isItemClassCode,
  isValidKraPin,
  lineAmounts,
  nairobiDate,
  paymentTypeCode,
  shouldRetry,
  statusFor,
  taxTypeForRate,
  toAmount,
  type EtimsAdapter,
  type EtimsCredentials,
  type EtimsResult,
  type SaleLine,
  type SaleResult,
} from "@/lib/etims";
import { resolveCredentials } from "./credentials";

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
 *
 * The invariant the whole file is organised around: **a document is POSTed to
 * Digitax at most once per attempt, and never while Digitax may already hold
 * it.** Every path that could send twice — a sale left PENDING at Digitax, a
 * timeout that landed, a 409, two runners overlapping, a rep pressing "Send
 * all" while the office presses "Retry" — is closed below, and each has a test.
 */

export interface EtimsContext {
  companyId: string;
  adapter: EtimsAdapter;
  creds: EtimsCredentials;
  fingerprint: string;
  config: NonNullable<Awaited<ReturnType<typeof loadConfig>>>;
}

export interface TransmitResult {
  ok: boolean;
  /** Our status for the document after this call. */
  status?: string;
  reason?: string;
}

export { MAX_ATTEMPTS };

const SALE_ENDPOINT = "/sales-with-items";
const CREDIT_NOTE_ENDPOINT = "/credit-notes";

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
 * *is* a failure the company needs to see. Callers put the message on the
 * document (`etimsError`) rather than swallowing it.
 */
export async function contextFor(companyId: string): Promise<EtimsContext | null> {
  const config = await loadConfig(companyId);
  if (!config?.enabled) return null;
  if (!(await isLicensed(companyId))) return null;

  // Read raw so the base URL can honour the environment: a SANDBOX company with
  // no URL of its own goes to the sandbox host when the deployment has one.
  const raw = await resolveCredentials(companyId, "DIGITAX");
  const creds: EtimsCredentials | null =
    raw?.DIGITAX_API_KEY && raw?.DIGITAX_TIN
      ? {
          apiKey: raw.DIGITAX_API_KEY,
          taxPin: raw.DIGITAX_TIN.trim(),
          baseUrl: baseUrlFor(raw.DIGITAX_BASE_URL, config.environment),
          branchId: raw.DIGITAX_BRANCH_ID,
        }
      : null;

  const adapter = adapterFor(config.environment, Boolean(creds));

  if (!adapter) {
    throw new Error(
      "eTIMS is switched on and set to LIVE, but this company has no Digitax API key stored. " +
        "Add one in Settings, or switch the environment back to sandbox.",
    );
  }

  if (creds && !isValidKraPin(creds.taxPin)) {
    throw new Error(
      `The stored Digitax TIN "${creds.taxPin}" is not a valid KRA PIN (expected the form P051234567X). ` +
        "Correct it under Settings → Payments before anything can be filed.",
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

/** Whether documents go on issue, or wait for someone to release them. */
export async function shouldAutoTransmit(companyId: string): Promise<boolean> {
  const config = await loadConfig(companyId);
  return Boolean(config?.enabled && config.autoTransmit);
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
// Locking
// ---------------------------------------------------------------------------

/**
 * One transmission per document at a time.
 *
 * Four things can try to send the same invoice at once: auto-transmit on issue,
 * the timer's sweep, the console's Retry and a rep's "Send all". The lock is a
 * row in `IdempotencyKey`, whose `key` is unique — the database arbitrates, so
 * it holds across processes, not just within one. A lock older than ten
 * minutes belongs to a transmission that died mid-flight and is taken over.
 */
const LOCK_USER = "system:etims";
const LOCK_STALE_MS = 10 * 60_000;

async function acquireLock(kind: string, id: string): Promise<boolean> {
  const key = `etims-lock:${kind}:${id}`;
  const create = () =>
    db.idempotencyKey.create({
      data: { key, userId: LOCK_USER, endpoint: "etims-lock", response: "{}", entityType: kind, entityId: id },
    });

  try {
    await create();
    return true;
  } catch {
    const held = await db.idempotencyKey.findUnique({ where: { key } });
    if (!held) {
      // Released between our failed insert and this read; try once more.
      try {
        await create();
        return true;
      } catch {
        return false;
      }
    }
    if (held.createdAt.getTime() > Date.now() - LOCK_STALE_MS) return false;

    // Stale. Delete exactly the row we saw — not a fresher one another process
    // may have just written — then take it.
    const removed = await db.idempotencyKey.deleteMany({ where: { key, createdAt: held.createdAt } });
    if (removed.count === 0) return false;
    try {
      await create();
      return true;
    } catch {
      return false;
    }
  }
}

async function releaseLock(kind: string, id: string): Promise<void> {
  await db.idempotencyKey.deleteMany({ where: { key: `etims-lock:${kind}:${id}` } }).catch(() => undefined);
}

async function withLock<T>(kind: string, id: string, busy: T, fn: () => Promise<T>): Promise<T> {
  if (!(await acquireLock(kind, id))) return busy;
  try {
    return await fn();
  } finally {
    await releaseLock(kind, id);
  }
}

// ---------------------------------------------------------------------------
// Audit trail
// ---------------------------------------------------------------------------

/**
 * Submission statuses:
 *   ACCEPTED  — Digitax answered and KRA has the document (status COMPLETED).
 *   SENT      — Digitax has it; KRA has not answered (PENDING / SUBMITTED / 409).
 *   PENDING   — a retryable failure. `retryAfter` says when.
 *   REJECTED  — a permanent one. Someone has to look.
 */
async function record(
  ctx: EtimsContext,
  docType: string,
  docId: string,
  endpoint: string,
  result: EtimsResult<unknown>,
  status?: string,
) {
  // Count and insert in one transaction, so two attempts recorded at the same
  // moment cannot both be "attempt 3". The lock makes this rare for sales and
  // credit notes; items and customers are registered from several documents
  // at once and have no lock of their own.
  return db.$transaction(async (tx) => {
    const attempts = await tx.etimsSubmission.count({
      where: { companyId: ctx.companyId, docType, docId },
    });
    const attempt = attempts + 1;
    const final = status ?? (result.ok ? "ACCEPTED" : shouldRetry(result) ? "PENDING" : "REJECTED");
    const backoff = final === "PENDING" || final === "SENT";

    return tx.etimsSubmission.create({
      data: {
        companyId: ctx.companyId,
        docType,
        docId,
        attempt,
        endpoint,
        status: final,
        // Verbatim, because the question two years from now is what was sent,
        // not what today's code would send.
        request: result.request ? JSON.stringify(result.request) : null,
        response: result.response ? JSON.stringify(result.response) : null,
        httpStatus: result.httpStatus ?? null,
        error: result.error ?? null,
        retryAfter: backoff ? new Date(Date.now() + backoffMs(attempt)) : null,
      },
    });
  });
}

/** A failure that never reached the wire — a blocked prerequisite or bad data. */
function localFailure(error: string, retryable: boolean): EtimsResult<never> {
  // No status for a retryable one (treated like a network failure); a 422 for a
  // permanent one, so `shouldRetry` and the log agree on what it was.
  return retryable ? { ok: false, error } : { ok: false, error, httpStatus: 422 };
}

/** Retryable failures of the *send* itself, which is what the attempt cap counts. */
async function failedSendAttempts(ctx: EtimsContext, docType: string, docId: string, endpoint: string) {
  return db.etimsSubmission.count({
    where: { companyId: ctx.companyId, docType, docId, endpoint, status: "PENDING" },
  });
}

async function latestSubmission(companyId: string, docType: string, docId: string) {
  return db.etimsSubmission.findFirst({
    where: { companyId, docType, docId },
    orderBy: { createdAt: "desc" },
    select: { status: true, retryAfter: true, httpStatus: true, endpoint: true, attempt: true },
  });
}

function giveUpMessage(attempts: number, lastError: string | undefined): string {
  return (
    `Gave up after ${attempts} attempts${lastError ? ` (last error: ${lastError})` : ""}. ` +
    "Fix the cause and retry manually from the transmission log."
  );
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Registers a product with eTIMS if it is not already.
 *
 * Returns the product either way; the caller checks `etimsItemCode`. A product
 * that could not be registered is **not** sent on a sale under its local id —
 * KRA has no such item, and the line would be rejected or, worse, accepted
 * against nothing.
 */
export async function ensureItemRegistered(ctx: EtimsContext, productId: string) {
  const product = await db.product.findFirst({
    where: { id: productId, companyId: ctx.companyId },
  });
  if (!product) throw new Error("Product not found in this company");
  if (product.etimsItemCode) return product;

  // A registration that failed a moment ago is not retried on every sale that
  // touches the product; the submission's own backoff governs it.
  if (product.etimsStatus === "FAILED") {
    const last = await db.etimsSubmission.findFirst({
      where: { companyId: ctx.companyId, docType: "ITEM", docId: product.id },
      orderBy: { createdAt: "desc" },
      select: { status: true, retryAfter: true, createdAt: true },
    });
    // A permanent rejection is tried again only once someone has edited the
    // product — the classification, say — since it was refused.
    if (last?.status === "REJECTED" && product.updatedAt <= last.createdAt) return product;
    if (last?.retryAfter && last.retryAfter > new Date()) return product;
  }

  const c = ctx.config;
  const itemClassCode = product.etimsItemClassCode ?? c.defaultItemClassCode;
  if (!isItemClassCode(itemClassCode)) {
    const result = localFailure(`Item classification code "${itemClassCode}" is not a valid eTIMS code`, false);
    await record(ctx, "ITEM", product.id, "/items", result);
    return db.product.update({
      where: { id: product.id },
      data: { etimsStatus: "FAILED", etimsError: result.error },
    });
  }

  const result = await ctx.adapter.registerItem(ctx.creds, {
    itemClassCode,
    itemTypeCode: product.etimsItemTypeCode ?? c.defaultItemTypeCode,
    itemName: product.name,
    originNationCode: product.etimsOriginNation ?? c.defaultOriginNation,
    packageUnitCode: product.etimsPackageUnit ?? c.defaultPackageUnit,
    quantityUnitCode: product.etimsQuantityUnit ?? c.defaultQuantityUnit,
    // The same resolution the sale line uses, so an item is never registered
    // as exempt and sold as zero-rated.
    taxTypeCode: taxTypeForRate(product.taxRateBp, product.etimsTaxTypeCode),
    defaultUnitPrice: toAmount(product.sellPriceCents),
    // The SKU stands in when there is no barcode: eTIMS requires one on every
    // line, and a distributor's own code is a truthful identifier where an
    // EAN-13 does not exist.
    itemBarCode: product.barcode ?? product.sku,
    callbackUrl: callbackUrl(),
  });

  // Registered only when the response says so. A 200 whose status is FAILED
  // is a failure; one with no id registered nothing.
  const digitaxStatus = result.ok ? statusFor(result.data?.status) : "REJECTED";
  const registered = result.ok && Boolean(result.data?.id) && digitaxStatus !== "REJECTED";

  // The product is written before the log row, so that "edited since the last
  // refusal" (above) compares a product stamp that is older than the refusal.
  const updated = await db.product.update({
    where: { id: product.id },
    data: registered
      ? {
          etimsItemCode: result.data?.etimsItemCode ?? result.data?.id ?? null,
          etimsStatus: digitaxStatus === "ACCEPTED" ? "REGISTERED" : "PENDING",
          etimsSyncedAt: new Date(),
          etimsError: null,
        }
      : {
          etimsStatus: "FAILED",
          etimsError: result.error ?? `Registration failed (Digitax status ${result.data?.status ?? "unknown"})`,
        },
  });

  await record(
    ctx,
    "ITEM",
    product.id,
    "/items",
    registered ? result : { ...result, ok: false, error: result.error ?? `Digitax reported ${result.data?.status ?? "no id"}` },
    registered ? (digitaxStatus === "ACCEPTED" ? "ACCEPTED" : "SENT") : undefined,
  );

  return updated;
}

/** Registers a customer, but only one with a PIN — eTIMS requires the TIN. */
export async function ensureCustomerRegistered(ctx: EtimsContext, customerId: string) {
  const customer = await db.customer.findFirst({
    where: { id: customerId, companyId: ctx.companyId },
  });
  if (!customer) throw new Error("Customer not found in this company");
  if (customer.etimsCustomerId || !customer.taxPin) return customer;
  if (!isValidKraPin(customer.taxPin)) return customer; // the sale refuses it with a readable error

  const result = await ctx.adapter.registerCustomer(ctx.creds, {
    name: customer.name,
    taxPin: customer.taxPin.trim(),
    phone: customer.phone,
  });

  const registered = result.ok && Boolean(result.data?.id);
  await record(ctx, "CUSTOMER", customer.id, "/customers", registered ? result : { ...result, ok: false, error: result.error ?? "No customer id returned" });

  if (!registered) return customer;

  return db.customer.update({
    where: { id: customer.id },
    data: { etimsCustomerId: result.data!.id },
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
 *
 * A company that is switched on but misconfigured — LIVE with no key, a
 * malformed TIN — still gets the invoice **queued**, with the problem written
 * on it. Leaving it NOT_APPLICABLE would make a configuration mistake look like
 * a company that does not file, and the invoice would never be sent.
 */
export async function queueInvoice(invoiceId: string, companyId: string): Promise<void> {
  const config = await loadConfig(companyId);
  if (!config?.enabled) return;
  if (!(await isLicensed(companyId))) return;

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
  if (config.activeFrom && invoice.issueDate < config.activeFrom) return;

  let configError: string | null = null;
  try {
    await contextFor(companyId);
  } catch (error) {
    configError = error instanceof Error ? error.message : String(error);
  }

  await db.invoice.update({
    where: { id: invoiceId },
    data: { etimsStatus: "QUEUED", etimsError: configError },
  });

  if (configError) return;

  if (config.autoTransmit) {
    await transmitInvoice(invoiceId, companyId).catch(() => {
      /* stays QUEUED; the runner will pick it up */
    });
  }
}

/**
 * Sends one invoice, or reads back the result of a send that already happened.
 *
 * Registration of the customer and every line item happens first, because a
 * sale referencing an unregistered item is rejected. Each step is idempotent,
 * so a retry resumes rather than restarting.
 *
 * `manual` is the console's Retry and the handset's "Send all": it may re-send
 * a REJECTED document a person has fixed. The runner never does.
 */
export async function transmitInvoice(
  invoiceId: string,
  companyId: string,
  opts: { manual?: boolean } = {},
): Promise<TransmitResult> {
  let ctx: EtimsContext | null;
  try {
    ctx = await contextFor(companyId);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await stampError("Invoice", invoiceId, companyId, reason);
    return { ok: false, reason };
  }
  if (!ctx) return { ok: false, reason: "eTIMS is not enabled for this company" };

  await reconcileCredentialChange(ctx);

  return withLock(
    "SALE",
    invoiceId,
    { ok: false, reason: "Another transmission of this invoice is already in progress" },
    () => sendInvoice(ctx!, invoiceId, opts),
  );
}

async function sendInvoice(
  ctx: EtimsContext,
  invoiceId: string,
  opts: { manual?: boolean },
): Promise<TransmitResult> {
  const { companyId } = ctx;
  const invoice = await db.invoice.findFirst({
    where: { id: invoiceId, companyId },
    include: {
      customer: true,
      lines: { include: { product: true } },
    },
  });
  if (!invoice) return { ok: false, reason: "Invoice not found" };

  const refuse = (reason: string): TransmitResult => ({ ok: false, status: invoice.etimsStatus, reason });
  const park = async (etimsStatus: string, reason: string): Promise<TransmitResult> => {
    await db.invoice.update({ where: { id: invoice.id }, data: { etimsStatus, etimsError: reason } });
    return { ok: false, status: etimsStatus, reason };
  };

  // ── what must never be sent ───────────────────────────────────────────
  if (invoice.etimsStatus === "ACCEPTED") return { ok: true, status: "ACCEPTED" };
  if (invoice.status === "DRAFT") return refuse("A draft is not a tax document yet");
  if (invoice.etimsStatus === "NOT_APPLICABLE") {
    return refuse(
      "This invoice is not marked for eTIMS filing: it was raised before the start date or while eTIMS was off",
    );
  }
  if (ctx.config.activeFrom && invoice.issueDate < ctx.config.activeFrom) {
    return park("NOT_APPLICABLE", `Raised before the eTIMS start date (${nairobiDate(ctx.config.activeFrom)}); not transmitted`);
  }
  if (invoice.status === "CANCELLED" && !invoice.etimsSaleId) {
    return park("NOT_APPLICABLE", "Cancelled before it was filed; not transmitted");
  }

  // Digitax already holds it. Read the authoritative status — never POST.
  if (invoice.etimsStatus === "SUBMITTED" || invoice.etimsSaleId) {
    return reconcileSale(ctx, "Invoice", invoice);
  }

  if (invoice.etimsStatus === "REJECTED" && !opts.manual) {
    return refuse("Rejected by eTIMS; a person has to fix it and retry from the transmission log");
  }

  const failed = await failedSendAttempts(ctx, "SALE", invoice.id, SALE_ENDPOINT);
  if (failed >= MAX_ATTEMPTS && !opts.manual) {
    return park("REJECTED", giveUpMessage(failed, invoice.etimsError ?? undefined));
  }

  // ── data that KRA would refuse ────────────────────────────────────────
  if (invoice.customer.taxPin && !isValidKraPin(invoice.customer.taxPin)) {
    const reason =
      `Customer "${invoice.customer.name}" has KRA PIN "${invoice.customer.taxPin}", which is not a valid PIN ` +
      "(expected the form P051234567X). Correct it on the customer and retry manually.";
    await record(ctx, "SALE", invoice.id, SALE_ENDPOINT, localFailure(reason, false));
    return park("REJECTED", reason);
  }

  // ── prerequisites at Digitax ──────────────────────────────────────────
  if (invoice.customer.taxPin) {
    await ensureCustomerRegistered(ctx, invoice.customerId);
  }

  const products = new Map<string, Awaited<ReturnType<typeof ensureItemRegistered>>>();
  for (const line of invoice.lines) {
    if (products.has(line.productId)) continue;
    const product = await ensureItemRegistered(ctx, line.productId);
    if (!product.etimsItemCode) {
      // Not sent with a local id in place of KRA's. The attempt fails and is
      // retried: the item's own registration carries the real error.
      const reason = `Item "${product.name}" is not registered with eTIMS: ${product.etimsError ?? "registration pending"}`;
      await record(ctx, "SALE", invoice.id, SALE_ENDPOINT, localFailure(reason, true));
      if (failed + 1 >= MAX_ATTEMPTS) return park("REJECTED", giveUpMessage(failed + 1, reason));
      return park("QUEUED", reason);
    }
    products.set(line.productId, product);
  }

  // ── did the last attempt land? ────────────────────────────────────────
  // A timeout or a malformed answer proves nothing either way. Ask before
  // sending a second copy; if Digitax cannot say, the 409 path below catches it.
  const last = await latestSubmission(companyId, "SALE", invoice.id);
  if (last && last.endpoint === SALE_ENDPOINT && last.status === "PENDING" && mayHaveLanded(last.httpStatus)) {
    const found = await ctx.adapter.findSaleByTraderNumber(ctx.creds, invoice.number);
    if (found.ok && found.data?.id) {
      await record(ctx, "SALE", invoice.id, `/sales?trader_invoice_number=`, found, sentStatus(found.data.status));
      await applySaleResult("Invoice", invoice.id, found.data);
      const status = statusFor(found.data.status);
      return { ok: status === "ACCEPTED", status, reason: status === "ACCEPTED" ? undefined : "Found at Digitax; awaiting KRA" };
    }
  }

  // Payment method drives the eTIMS payment type, so read what was actually
  // received rather than assuming cash.
  const payment = await db.paymentAllocation.findFirst({
    where: { invoiceId: invoice.id },
    include: { payment: { select: { method: true } } },
    orderBy: { id: "asc" },
  });

  const items: SaleLine[] = invoice.lines.map((l) => {
    const product = products.get(l.productId)!;
    // The stored line total is already net of the discount. This used to take
    // the discount off again, so every discounted sale reached KRA with its
    // taxable amount and VAT understated — and a taxable + VAT that no longer
    // added up to the total it was filed with.
    const charged = chargedLine(l);

    // Filed in **base units**, not in cartons. eTIMS deducts stock from the
    // item it registered, and that item is the product; sending two cartons
    // would take two units off KRA's pool while twenty-four left the shelf,
    // and the difference compounds until a stock take cannot be explained.
    // The line total is authoritative, so the unit price is derived back from
    // it rather than the other way round — see `reconcileUnitPrice`.
    const units = l.baseQuantity || l.quantity;
    const amounts = lineAmounts(units, charged.lineTotalCents, charged.netCents, charged.taxCents);

    return {
      id: product.etimsItemCode!,
      itemName: product.name,
      itemClassCode: product.etimsItemClassCode ?? ctx.config.defaultItemClassCode,
      itemBarCode: product.barcode ?? product.sku,
      taxTypeCode: taxTypeForRate(l.taxRateBp, product.etimsTaxTypeCode),
      ...amounts,
      // No discount_amount. The unit price and total above are what the
      // customer paid, discount already applied; Digitax defines the discount
      // against total_amount, so sending it as well invites it to be taken
      // off a second time. KRA is filed the consideration actually charged.
      isStockable: product.trackStock,
      description: l.variantName ? `${l.description} (${l.variantName})` : l.description,
    };
  });

  const result = await ctx.adapter.submitSale(ctx.creds, {
    // The calendar day in Nairobi, not UTC: a sale at one in the morning is
    // not yesterday's sale.
    saleDate: nairobiDate(invoice.issueDate),
    traderInvoiceNumber: invoice.number,
    paymentTypeCode: paymentTypeCode(payment?.payment.method),
    // 02 = Approved. Raut only transmits invoices it has already issued.
    invoiceStatusCode: "02",
    customerTin: invoice.customer.taxPin?.trim() || null,
    customerName: invoice.customer.name,
    callbackUrl: callbackUrl(),
    items,
  });

  return settleSend(ctx, "Invoice", invoice, SALE_ENDPOINT, result, failed);
}

/**
 * Whether a failed attempt may nonetheless have been processed.
 *
 * No status at all is a timeout or a dropped socket; a 2xx recorded as a
 * failure is a non-JSON body. Either way the request may have arrived.
 */
function mayHaveLanded(httpStatus: number | null): boolean {
  return httpStatus === null || (httpStatus >= 200 && httpStatus < 300);
}

function sentStatus(digitaxStatus: string | undefined): string {
  const mapped = statusFor(digitaxStatus);
  return mapped === "ACCEPTED" ? "ACCEPTED" : mapped === "REJECTED" ? "REJECTED" : "SENT";
}

/**
 * What to do with the answer to a POST, for a sale or a credit note.
 *
 *   2xx           → apply whatever status Digitax gave. PENDING stays QUEUED
 *                   with the Digitax id on it, and is read back later.
 *   409           → Digitax already has it. Look it up; failing that, SUBMITTED
 *                   until a later sweep can read it. Never REJECTED.
 *   retryable     → QUEUED with backoff, until the cap parks it as REJECTED.
 *   anything else → REJECTED, with the reason.
 */
async function settleSend(
  ctx: EtimsContext,
  model: "Invoice" | "CreditNote",
  doc: { id: string; number: string },
  endpoint: string,
  result: EtimsResult<SaleResult>,
  failedBefore: number,
): Promise<TransmitResult> {
  const docType = model === "Invoice" ? "SALE" : "CREDIT_NOTE";
  const update = (data: Record<string, unknown>) =>
    model === "Invoice"
      ? db.invoice.update({ where: { id: doc.id }, data })
      : db.creditNote.update({ where: { id: doc.id }, data });

  if (result.ok && !result.data?.id) {
    // A 2xx with no id is not a filing. Treat it like a malformed answer.
    result = { ...result, ok: false, malformed: true, error: result.error ?? "Digitax answered without a sale id" };
  }

  if (result.ok) {
    const sale = result.data!;
    await record(ctx, docType, doc.id, endpoint, result, sentStatus(sale.status));
    await applySaleResult(model, doc.id, sale);
    const status = statusFor(sale.status);
    return {
      ok: status === "ACCEPTED",
      status,
      reason:
        status === "ACCEPTED"
          ? undefined
          : status === "REJECTED"
            ? "eTIMS rejected the transaction"
            : `Digitax has it (status ${sale.status}); awaiting KRA`,
    };
  }

  if (isAlreadySubmitted(result.httpStatus)) {
    // Filed, as far as Digitax is concerned. Reconcile rather than resend.
    await record(ctx, docType, doc.id, endpoint, result, "SENT");
    const found = await ctx.adapter.findSaleByTraderNumber(ctx.creds, doc.number);
    if (found.ok && found.data?.id) {
      await applySaleResult(model, doc.id, found.data);
      const status = statusFor(found.data.status);
      return { ok: status === "ACCEPTED", status, reason: status === "ACCEPTED" ? undefined : "Found at Digitax; awaiting KRA" };
    }
    const reason =
      "Digitax reports this document as already filed (409) but it could not be read back yet; " +
      "it will be reconciled on the next sweep";
    await update({ etimsStatus: "SUBMITTED", etimsError: reason });
    return { ok: false, status: "SUBMITTED", reason };
  }

  if (shouldRetry(result)) {
    await record(ctx, docType, doc.id, endpoint, result);
    const failed = failedBefore + 1;
    if (failed >= MAX_ATTEMPTS) {
      const reason = giveUpMessage(failed, result.error);
      await update({ etimsStatus: "REJECTED", etimsError: reason });
      return { ok: false, status: "REJECTED", reason };
    }
    await update({ etimsStatus: "QUEUED", etimsError: result.error ?? "Submission failed; will retry" });
    return { ok: false, status: "QUEUED", reason: result.error };
  }

  await record(ctx, docType, doc.id, endpoint, result);
  await update({ etimsStatus: "REJECTED", etimsError: result.error ?? "Submission rejected" });
  return { ok: false, status: "REJECTED", reason: result.error };
}

/**
 * Reads a document Digitax already holds, and applies what it says.
 *
 * This is the only path for anything with a Digitax id or in SUBMITTED. It
 * issues GETs and never a POST, which is what makes a sale left PENDING safe
 * to revisit as often as the sweep likes.
 */
async function reconcileSale(
  ctx: EtimsContext,
  model: "Invoice" | "CreditNote",
  doc: { id: string; number: string; etimsSaleId: string | null; etimsStatus: string },
): Promise<TransmitResult> {
  const docType = model === "Invoice" ? "SALE" : "CREDIT_NOTE";

  const result = doc.etimsSaleId
    ? await ctx.adapter.fetchSale(ctx.creds, doc.etimsSaleId)
    : await ctx.adapter.findSaleByTraderNumber(ctx.creds, doc.number);
  const endpoint = doc.etimsSaleId ? `/sales/${doc.etimsSaleId}` : "/sales?trader_invoice_number=";

  if (result.ok && result.data?.id) {
    await record(ctx, docType, doc.id, endpoint, result, sentStatus(result.data.status));
    await applySaleResult(model, doc.id, result.data);
    const status = statusFor(result.data.status);
    return {
      ok: status === "ACCEPTED",
      status,
      reason: status === "ACCEPTED" ? undefined : `Digitax status ${result.data.status}; awaiting KRA`,
    };
  }

  // Could not read it. Keep the status we have — SUBMITTED or QUEUED-with-id —
  // and back off. Nothing here is a reason to send again.
  await record(ctx, docType, doc.id, endpoint, { ...result, ok: false, error: result.error ?? "Not found at Digitax" }, "SENT");
  const reason = result.ok
    ? "Digitax has no record of this document under its number yet; it will be checked again"
    : `Could not read the document back from Digitax: ${result.error}`;
  const data = { etimsError: reason };
  if (model === "Invoice") await db.invoice.update({ where: { id: doc.id }, data });
  else await db.creditNote.update({ where: { id: doc.id }, data });
  return { ok: false, status: doc.etimsStatus, reason };
}

/** Writes a Digitax sale result onto an invoice or credit note. */
async function applySaleResult(
  model: "Invoice" | "CreditNote",
  id: string,
  sale: SaleResult,
) {
  const status = statusFor(sale.status);
  const data = {
    etimsStatus: status,
    etimsSaleId: sale.id,
    etimsControlCode: sale.controlCode ?? null,
    etimsInvoiceNumber: sale.invoiceNumber ?? null,
    etimsSerialNumber: sale.serialNumber ?? null,
    etimsReceiptNumber: sale.receiptNumber ?? null,
    etimsQrUrl: sale.qrUrl ?? null,
    etimsOfflineUrl: sale.offlineUrl ?? null,
    etimsSubmittedAt: new Date(),
    etimsError:
      status === "ACCEPTED"
        ? null
        : status === "REJECTED"
          ? "eTIMS rejected the transaction"
          : status === "SUBMITTED"
            ? "Digitax reports SUBMITTED: eTIMS synced but the final data never came back. Contact Digitax support."
            : `Awaiting KRA (Digitax status ${sale.status})`,
  };

  if (model === "Invoice") {
    await db.invoice.update({ where: { id }, data });
  } else {
    await db.creditNote.update({ where: { id }, data });
  }
}

/** Puts a configuration problem on a queued document so it is seen. */
async function stampError(model: "Invoice" | "CreditNote", id: string, companyId: string, reason: string) {
  const where = { id, companyId, etimsStatus: { in: ["QUEUED", "SUBMITTED"] } };
  const data = { etimsError: reason };
  if (model === "Invoice") await db.invoice.updateMany({ where, data }).catch(() => undefined);
  else await db.creditNote.updateMany({ where, data }).catch(() => undefined);
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
 *
 * A note against an invoice that was never marked for filing is itself not
 * filed — there is nothing at KRA to reverse.
 */
export async function queueCreditNote(creditNoteId: string, companyId: string): Promise<void> {
  const config = await loadConfig(companyId);
  if (!config?.enabled) return;
  if (!(await isLicensed(companyId))) return;

  const note = await db.creditNote.findFirst({
    where: { id: creditNoteId, companyId },
    select: {
      id: true,
      status: true,
      etimsStatus: true,
      invoice: { select: { number: true, etimsStatus: true } },
    },
  });
  if (!note) return;
  if (note.status === "DRAFT") return;
  if (note.etimsStatus !== "NOT_APPLICABLE") return;
  if (note.invoice.etimsStatus === "NOT_APPLICABLE") return;

  let configError: string | null = null;
  try {
    await contextFor(companyId);
  } catch (error) {
    configError = error instanceof Error ? error.message : String(error);
  }

  await db.creditNote.update({
    where: { id: creditNoteId },
    data: {
      etimsStatus: "QUEUED",
      etimsError:
        configError ??
        (note.invoice.etimsStatus === "ACCEPTED"
          ? null
          : `Waiting for invoice ${note.invoice.number} to be accepted by eTIMS`),
    },
  });
}

export async function transmitCreditNote(
  creditNoteId: string,
  companyId: string,
  opts: { manual?: boolean } = {},
): Promise<TransmitResult> {
  let ctx: EtimsContext | null;
  try {
    ctx = await contextFor(companyId);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await stampError("CreditNote", creditNoteId, companyId, reason);
    return { ok: false, reason };
  }
  if (!ctx) return { ok: false, reason: "eTIMS is not enabled for this company" };

  await reconcileCredentialChange(ctx);

  return withLock(
    "CREDIT_NOTE",
    creditNoteId,
    { ok: false, reason: "Another transmission of this credit note is already in progress" },
    () => sendCreditNote(ctx!, creditNoteId, opts),
  );
}

async function sendCreditNote(
  ctx: EtimsContext,
  creditNoteId: string,
  opts: { manual?: boolean },
): Promise<TransmitResult> {
  const { companyId } = ctx;
  const note = await db.creditNote.findFirst({
    where: { id: creditNoteId, companyId },
    include: { invoice: true, lines: { include: { product: true } } },
  });
  if (!note) return { ok: false, reason: "Credit note not found" };

  const refuse = (reason: string): TransmitResult => ({ ok: false, status: note.etimsStatus, reason });
  const park = async (etimsStatus: string, reason: string): Promise<TransmitResult> => {
    await db.creditNote.update({ where: { id: note.id }, data: { etimsStatus, etimsError: reason } });
    return { ok: false, status: etimsStatus, reason };
  };

  if (note.etimsStatus === "ACCEPTED") return { ok: true, status: "ACCEPTED" };
  if (note.status === "DRAFT") return refuse("A draft credit note is not a tax document yet");
  if (note.etimsStatus === "NOT_APPLICABLE") {
    return refuse("This credit note is not marked for eTIMS filing: its invoice was never filed");
  }
  if (note.status === "CANCELLED" && !note.etimsSaleId) {
    return park("NOT_APPLICABLE", "Cancelled before it was filed; not transmitted");
  }

  if (note.etimsStatus === "SUBMITTED" || note.etimsSaleId) {
    return reconcileSale(ctx, "CreditNote", note);
  }

  if (note.etimsStatus === "REJECTED" && !opts.manual) {
    return refuse("Rejected by eTIMS; a person has to fix it and retry from the transmission log");
  }

  // A credit note references the original sale by its Digitax id. If the
  // invoice was never filed there is nothing to reverse at KRA, and sending
  // one would be a reversal of a sale KRA has no record of.
  if (note.invoice.etimsStatus === "NOT_APPLICABLE") {
    return park("NOT_APPLICABLE", `Invoice ${note.invoice.number} was never filed with eTIMS, so there is nothing to reverse`);
  }
  if (note.invoice.etimsStatus !== "ACCEPTED" || !note.invoice.etimsSaleId) {
    const reason =
      note.invoice.etimsStatus === "REJECTED"
        ? `Invoice ${note.invoice.number} was rejected by eTIMS; fix and retransmit it first`
        : `Waiting for invoice ${note.invoice.number} to be accepted by eTIMS`;
    await db.creditNote.update({ where: { id: note.id }, data: { etimsError: reason } });
    return { ok: false, status: note.etimsStatus, reason };
  }

  const failed = await failedSendAttempts(ctx, "CREDIT_NOTE", note.id, CREDIT_NOTE_ENDPOINT);
  if (failed >= MAX_ATTEMPTS && !opts.manual) {
    return park("REJECTED", giveUpMessage(failed, note.etimsError ?? undefined));
  }

  // The items must still be known to Digitax under this credential — a key
  // change since the sale retires every stored code.
  const products = new Map<string, Awaited<ReturnType<typeof ensureItemRegistered>>>();
  for (const line of note.lines) {
    if (products.has(line.productId)) continue;
    const product = await ensureItemRegistered(ctx, line.productId);
    if (!product.etimsItemCode) {
      const reason = `Item "${product.name}" is not registered with eTIMS: ${product.etimsError ?? "registration pending"}`;
      await record(ctx, "CREDIT_NOTE", note.id, CREDIT_NOTE_ENDPOINT, localFailure(reason, true));
      if (failed + 1 >= MAX_ATTEMPTS) return park("REJECTED", giveUpMessage(failed + 1, reason));
      return park("QUEUED", reason);
    }
    products.set(line.productId, product);
  }

  const last = await latestSubmission(companyId, "CREDIT_NOTE", note.id);
  if (last && last.endpoint === CREDIT_NOTE_ENDPOINT && last.status === "PENDING" && mayHaveLanded(last.httpStatus)) {
    const found = await ctx.adapter.findSaleByTraderNumber(ctx.creds, note.number);
    if (found.ok && found.data?.id) {
      await record(ctx, "CREDIT_NOTE", note.id, "/sales?trader_invoice_number=", found, sentStatus(found.data.status));
      await applySaleResult("CreditNote", note.id, found.data);
      const status = statusFor(found.data.status);
      return { ok: status === "ACCEPTED", status, reason: status === "ACCEPTED" ? undefined : "Found at Digitax; awaiting KRA" };
    }
  }

  const result = await ctx.adapter.submitCreditNote(ctx.creds, {
    // The original sale is identified by sale_id. trader_invoice_number is
    // this document's own reference: Digitax stores a credit note as a sale in
    // its own right, looked up by business and trader invoice number. Sending
    // the invoice's number here gave the sale and every return against it the
    // same key, so the second partial return collided with the first.
    saleId: note.invoice.etimsSaleId,
    traderInvoiceNumber: note.number,
    returnDate: nairobiDate(note.issueDate),
    invoiceDetails: note.reason,
    callbackUrl: callbackUrl(),
    // Base units, matching how the sale was filed. Sending two cartons against
    // a sale KRA recorded as twenty-four bottles would credit two units and
    // leave twenty-two sold on their ledger for ever — the customer's return
    // would be complete on our books and invisible on theirs.
    items: note.lines.map((l) => {
      const units = l.baseQuantity || l.quantity;
      return {
        id: products.get(l.productId)!.etimsItemCode!,
        ...lineAmounts(units, l.lineTotalCents),
        description: l.variantName ? `${l.description} (${l.variantName})` : l.description,
      };
    }),
  });

  return settleSend(ctx, "CreditNote", note, CREDIT_NOTE_ENDPOINT, result, failed);
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

const REPORTABLE_MOVEMENTS = ["PURCHASE", "OPENING", "ADJUSTMENT", "WRITE_OFF"];

/**
 * Reports one movement. Nothing is swallowed: the result says what happened,
 * and the submission log carries the request either way.
 */
export async function reportStockMovement(movementId: string, companyId: string): Promise<TransmitResult> {
  const ctx = await contextFor(companyId);
  if (!ctx) return { ok: false, reason: "eTIMS is not enabled for this company" };

  const movement = await db.stockMovement.findFirst({
    where: { id: movementId, companyId },
    include: { product: true },
  });
  if (!movement) return { ok: false, reason: "Movement not found" };

  const mapped = stockMovementFor(movement.type, movement.quantity);
  if (!mapped) return { ok: true, reason: "Not a movement eTIMS tracks" };
  if (!movement.product.trackStock) return { ok: true, reason: "Product does not track stock" };

  const product = await ensureItemRegistered(ctx, movement.productId);
  if (!product.etimsItemCode) {
    const reason = `Item "${product.name}" is not registered with eTIMS: ${product.etimsError ?? "registration pending"}`;
    await record(ctx, "STOCK", movement.id, "/stock/adjust", localFailure(reason, true));
    return { ok: false, reason };
  }

  const result = await ctx.adapter.adjustStock(ctx.creds, {
    itemId: product.etimsItemCode,
    quantity: Math.abs(movement.quantity),
    action: mapped.action,
    movementType: mapped.movementType,
  });

  await record(ctx, "STOCK", movement.id, "/stock/adjust", result);
  return { ok: result.ok, reason: result.error };
}

// ---------------------------------------------------------------------------
// Runner and reconciliation
// ---------------------------------------------------------------------------

export interface RunSummary {
  /** Documents considered — due, not backed off, not parked. */
  processed: number;
  /** Accepted by KRA in this run. */
  invoices: number;
  creditNotes: number;
  stock: number;
  /** Read back from Digitax (PENDING / SUBMITTED) and still awaiting KRA. */
  awaiting: number;
  failures: number;
  /** Skipped because their backoff has not elapsed. */
  deferred: number;
  errors: Array<{ docType: string; docId: string; companyId: string; reason: string }>;
  durationMs: number;
}

/**
 * Drains what is outstanding, across every company.
 *
 * Credentials are resolved per document, not once per sweep — a single
 * resolution reused across tenants is exactly how one company's invoice would
 * be filed under another's PIN.
 *
 * `limit` bounds the documents *attempted*, not the rows read: the queue is
 * paged through, so fifty invoices waiting on their backoff cannot sit at the
 * front and starve everything behind them.
 */
export async function runPending(limit = 50): Promise<RunSummary> {
  const started = Date.now();
  const now = new Date();
  const summary: RunSummary = {
    processed: 0,
    invoices: 0,
    creditNotes: 0,
    stock: 0,
    awaiting: 0,
    failures: 0,
    deferred: 0,
    errors: [],
    durationMs: 0,
  };
  const note = (docType: string, docId: string, companyId: string, reason: string) => {
    summary.failures++;
    if (summary.errors.length < 50) summary.errors.push({ docType, docId, companyId, reason });
  };
  const tally = (docType: string, doc: { id: string; companyId: string }, r: TransmitResult, bucket: "invoices" | "creditNotes") => {
    summary.processed++;
    if (r.ok) summary[bucket]++;
    else if (r.status === "QUEUED" || r.status === "SUBMITTED") {
      // Digitax has it or will take it again; not a failure of this run.
      if (r.reason?.startsWith("Awaiting") || r.reason?.includes("awaiting KRA") || r.reason?.includes("checked again")) summary.awaiting++;
      else note(docType, doc.id, doc.companyId, r.reason ?? "failed");
    } else note(docType, doc.id, doc.companyId, r.reason ?? "failed");
  };

  // Only companies with the switch on. Everything else is noise in the query.
  const enabledCompany = { company: { etimsConfig: { is: { enabled: true } } } };

  // ── invoices ──────────────────────────────────────────────────────────
  let cursor: string | undefined;
  let attempted = 0;
  while (attempted < limit) {
    const page: Array<{ id: string; companyId: string; etimsSaleId: string | null }> = await db.invoice.findMany({
      where: { etimsStatus: { in: ["QUEUED", "SUBMITTED"] }, ...enabledCompany },
      select: { id: true, companyId: true, etimsSaleId: true },
      orderBy: { id: "asc" },
      take: 100,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    if (page.length === 0) break;
    cursor = page[page.length - 1].id;

    for (const inv of page) {
      if (attempted >= limit) break;
      const last = await latestSubmission(inv.companyId, "SALE", inv.id);
      if (last?.retryAfter && last.retryAfter > now) {
        summary.deferred++;
        continue;
      }
      attempted++;
      const r = await transmitInvoice(inv.id, inv.companyId).catch(
        (e): TransmitResult => ({ ok: false, reason: e instanceof Error ? e.message : String(e) }),
      );
      tally("SALE", inv, r, "invoices");
    }
  }

  // ── credit notes ──────────────────────────────────────────────────────
  // Blocked notes — the invoice not yet accepted — are excluded in the query
  // rather than read and skipped; they cannot crowd out the ones that can go.
  cursor = undefined;
  attempted = 0;
  while (attempted < limit) {
    const page: Array<{ id: string; companyId: string }> = await db.creditNote.findMany({
      where: {
        etimsStatus: { in: ["QUEUED", "SUBMITTED"] },
        OR: [{ etimsSaleId: { not: null } }, { invoice: { etimsStatus: "ACCEPTED", etimsSaleId: { not: null } } }],
        ...enabledCompany,
      },
      select: { id: true, companyId: true },
      orderBy: { id: "asc" },
      take: 100,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    if (page.length === 0) break;
    cursor = page[page.length - 1].id;

    for (const n of page) {
      if (attempted >= limit) break;
      const last = await latestSubmission(n.companyId, "CREDIT_NOTE", n.id);
      if (last?.retryAfter && last.retryAfter > now) {
        summary.deferred++;
        continue;
      }
      attempted++;
      const r = await transmitCreditNote(n.id, n.companyId).catch(
        (e): TransmitResult => ({ ok: false, reason: e instanceof Error ? e.message : String(e) }),
      );
      tally("CREDIT_NOTE", n, r, "creditNotes");
    }
  }

  // ── stock ─────────────────────────────────────────────────────────────
  // Stock is swept rather than hooked into applyMovement, for the same reason
  // invoices are queued after commit: applyMovement runs inside the caller's
  // transaction, and a network call there would hold SQLite's write lock.
  //
  // Only companies with eTIMS switched on are considered, and only movement
  // types eTIMS has not already heard about through a sale or a credit note.
  // Movements already reported, permanently rejected, past the attempt cap or
  // inside their backoff are excluded **in the query**.
  const enabled = await db.etimsConfig.findMany({
    where: { enabled: true },
    select: { companyId: true, activeFrom: true },
  });

  for (const cfg of enabled) {
    const [terminal, capped, deferred] = await Promise.all([
      db.etimsSubmission.groupBy({
        by: ["docId"],
        where: { companyId: cfg.companyId, docType: "STOCK", status: { in: ["ACCEPTED", "REJECTED"] } },
      }),
      db.etimsSubmission.groupBy({
        by: ["docId"],
        where: { companyId: cfg.companyId, docType: "STOCK", status: "PENDING" },
        having: { docId: { _count: { gte: MAX_ATTEMPTS } } },
      }),
      db.etimsSubmission.findMany({
        where: { companyId: cfg.companyId, docType: "STOCK", status: "PENDING", retryAfter: { gt: now } },
        select: { docId: true },
      }),
    ]);
    const excluded = [...new Set([...terminal, ...capped, ...deferred].map((r) => r.docId))];
    summary.deferred += deferred.length;

    const movements = await db.stockMovement.findMany({
      where: {
        companyId: cfg.companyId,
        type: { in: REPORTABLE_MOVEMENTS },
        product: { trackStock: true },
        ...(cfg.activeFrom ? { createdAt: { gte: cfg.activeFrom } } : {}),
        ...(excluded.length > 0 ? { id: { notIn: excluded } } : {}),
      },
      select: { id: true },
      orderBy: { createdAt: "asc" },
      take: limit,
    });

    for (const m of movements) {
      summary.processed++;
      try {
        const r = await reportStockMovement(m.id, cfg.companyId);
        if (r.ok) summary.stock++;
        else note("STOCK", m.id, cfg.companyId, r.reason ?? "failed");
      } catch (e) {
        note("STOCK", m.id, cfg.companyId, e instanceof Error ? e.message : String(e));
      }
    }
  }

  summary.durationMs = Date.now() - started;
  return summary;
}

/**
 * Re-reads one document's status from Digitax.
 *
 * This is what a callback triggers. The callback body itself is never written
 * to a control code: Digitax documents no signature on it, so anyone who learns
 * an invoice number could otherwise stamp a forged code onto a real invoice.
 * The payload is a hint that something changed; this fetches the truth.
 */
export async function reconcileInvoice(invoiceId: string, companyId: string): Promise<TransmitResult> {
  const ctx = await contextFor(companyId);
  if (!ctx) return { ok: false, reason: "eTIMS is not enabled for this company" };

  const invoice = await db.invoice.findFirst({
    where: { id: invoiceId, companyId },
    select: { id: true, number: true, etimsSaleId: true, etimsStatus: true },
  });
  if (!invoice) return { ok: false, reason: "Invoice not found" };
  if (invoice.etimsStatus === "NOT_APPLICABLE") return { ok: false, reason: "Not marked for filing" };
  if (!invoice.etimsSaleId && invoice.etimsStatus !== "SUBMITTED") {
    return { ok: false, reason: "Nothing to reconcile: not yet sent" };
  }

  return withLock("SALE", invoiceId, { ok: false, reason: "Transmission in progress" }, () =>
    reconcileSale(ctx, "Invoice", invoice),
  );
}

export async function reconcileCreditNote(creditNoteId: string, companyId: string): Promise<TransmitResult> {
  const ctx = await contextFor(companyId);
  if (!ctx) return { ok: false, reason: "eTIMS is not enabled for this company" };

  const note = await db.creditNote.findFirst({
    where: { id: creditNoteId, companyId },
    select: { id: true, number: true, etimsSaleId: true, etimsStatus: true },
  });
  if (!note) return { ok: false, reason: "Credit note not found" };
  if (note.etimsStatus === "NOT_APPLICABLE") return { ok: false, reason: "Not marked for filing" };
  if (!note.etimsSaleId && note.etimsStatus !== "SUBMITTED") {
    return { ok: false, reason: "Nothing to reconcile: not yet sent" };
  }

  return withLock("CREDIT_NOTE", creditNoteId, { ok: false, reason: "Transmission in progress" }, () =>
    reconcileSale(ctx, "CreditNote", note),
  );
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
