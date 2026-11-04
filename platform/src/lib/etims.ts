import "server-only";

import crypto from "node:crypto";

/**
 * KRA eTIMS, through Digitax.
 *
 * Same shape as `sms.ts` and `payments.ts`: a console adapter that records
 * without transmitting, and a live adapter behind the same interface.
 *
 * The one rule that separates this from the payment adapters, and the reason
 * it does not reuse `credsFor()`: **there is no environment fallback.** A
 * payment gateway may legitimately fall back to a platform-wide account. A tax
 * filing may not. Filing Company A's sales against whatever PIN happens to be
 * in the server's environment is a false return in someone else's name, and it
 * is the kind of mistake that is only discovered by the revenue authority. A
 * company with no stored key is *not configured*, and transmits nothing.
 *
 * Base URL is the exception: a host is not an identity, so it may come from
 * env as a deployment default.
 */

const DEFAULT_BASE_URL = "https://api.digitax.tech/ke/v2";

export {
  TAX_TYPES,
  ITEM_TYPES,
  ITEM_CLASSES,
  QUANTITY_UNITS,
  PACKAGE_UNITS,
  STOCK_MOVEMENTS,
  KRA_PIN_RE,
  paymentTypeCode,
  taxTypeForRate,
  isTaxTypeCode,
  isItemTypeCode,
  isItemClassCode,
  isQuantityUnit,
  isPackageUnit,
  isValidKraPin,
  nairobiDate,
  toAmount,
  reconcileUnitPrice,
  type TaxTypeCode,
} from "./etims-codes";

import { reconcileUnitPrice, toAmount } from "./etims-codes";

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

export interface EtimsCredentials {
  apiKey: string;
  taxPin: string;
  baseUrl: string;
  branchId?: string;
}

/**
 * A stable fingerprint of the credential that produced a set of Digitax ids.
 *
 * `etimsItemCode`, `etimsCustomerId` and `etimsSaleId` are only meaningful
 * inside the Digitax account that issued them. If a company replaces its key
 * with one for a different business, every stored id silently points at another
 * taxpayer's records — and a sale submitted against them would be filed under
 * the wrong business. Comparing this fingerprint is how that is caught.
 *
 * It is a hash, never the key: it is stored in a plain column.
 */
export function credentialFingerprint(creds: EtimsCredentials): string {
  return crypto
    .createHash("sha256")
    .update(`${creds.taxPin}:${creds.apiKey}`)
    .digest("hex")
    .slice(0, 32);
}

// ---------------------------------------------------------------------------
// Adapter interface
// ---------------------------------------------------------------------------

export interface EtimsResult<T> {
  ok: boolean;
  data?: T;
  /** HTTP status where there was one, for deciding whether to retry. */
  httpStatus?: number;
  error?: string;
  /**
   * A 2xx whose body was not JSON. The request may well have been processed —
   * a proxy or a maintenance page answered instead of the API — so it is a
   * failure that is retried, and the 409 path catches the duplicate if it was.
   */
  malformed?: boolean;
  /** What was actually sent and received, kept for the audit trail. */
  request?: unknown;
  response?: unknown;
}

export interface SaleLine {
  id: string;
  itemName: string;
  itemClassCode: string;
  itemBarCode: string;
  taxTypeCode: string;
  quantity: number;
  unitPrice: number;
  totalAmount: number;
  taxableAmount?: number;
  taxAmount?: number;
  discountAmount?: number;
  isStockable: boolean;
  description?: string;
}

export interface SubmitSaleInput {
  saleDate: string;
  traderInvoiceNumber: string;
  paymentTypeCode: string;
  invoiceStatusCode: string;
  customerTin?: string | null;
  customerName?: string | null;
  invoiceDetails?: string | null;
  callbackUrl?: string | null;
  items: SaleLine[];
}

export interface SaleResult {
  id: string;
  controlCode?: string;
  invoiceNumber?: string;
  serialNumber?: string;
  receiptNumber?: number;
  qrUrl?: string;
  offlineUrl?: string;
  status: string;
}

export interface CreditNoteInput {
  saleId: string;
  traderInvoiceNumber: string;
  returnDate: string;
  invoiceDetails?: string | null;
  callbackUrl?: string | null;
  items: Array<{
    id: string;
    quantity: number;
    unitPrice: number;
    totalAmount: number;
    description?: string;
  }>;
}

export interface RegisterItemInput {
  itemClassCode: string;
  itemTypeCode: string;
  itemName: string;
  originNationCode: string;
  packageUnitCode: string;
  quantityUnitCode: string;
  taxTypeCode: string;
  defaultUnitPrice: number;
  itemBarCode?: string;
  callbackUrl?: string | null;
}

export interface EtimsAdapter {
  readonly name: string;
  info(c: EtimsCredentials): Promise<EtimsResult<Record<string, unknown>>>;
  registerItem(
    c: EtimsCredentials,
    input: RegisterItemInput,
  ): Promise<EtimsResult<{ id: string; etimsItemCode?: string; status: string }>>;
  registerCustomer(
    c: EtimsCredentials,
    input: { name: string; taxPin: string; email?: string | null; phone?: string | null },
  ): Promise<EtimsResult<{ id: string }>>;
  submitSale(c: EtimsCredentials, input: SubmitSaleInput): Promise<EtimsResult<SaleResult>>;
  submitCreditNote(
    c: EtimsCredentials,
    input: CreditNoteInput,
  ): Promise<EtimsResult<SaleResult>>;
  adjustStock(
    c: EtimsCredentials,
    input: { itemId: string; quantity: number; action: "ADD" | "DEDUCT"; movementType: string },
  ): Promise<EtimsResult<{ stockQuantity: number }>>;
  fetchSale(c: EtimsCredentials, saleId: string): Promise<EtimsResult<SaleResult>>;
  /**
   * Looks a sale up by the number *we* gave it.
   *
   * Used before re-sending a document whose last attempt may have reached
   * Digitax — a timeout proves nothing either way. `data: null` means Digitax
   * has no such sale. Failure means the question could not be answered, and
   * the caller falls back to sending and letting the 409 path catch a duplicate.
   */
  findSaleByTraderNumber(
    c: EtimsCredentials,
    traderInvoiceNumber: string,
  ): Promise<EtimsResult<SaleResult | null>>;
}

// ---------------------------------------------------------------------------
// Retry classification
// ---------------------------------------------------------------------------

/**
 * Whether a failure is worth trying again.
 *
 * Getting this wrong in either direction costs something real: retrying a 400
 * hammers KRA with a document it will never accept, and *not* retrying a
 * timeout silently drops a filing obligation. A 409 is neither — Digitax
 * already has the document, so the answer is to go and read its status rather
 * than send it a second time.
 */
export function isRetryable(httpStatus?: number): boolean {
  if (httpStatus === undefined) return true; // network failure or timeout
  if (httpStatus === 429) return true;
  if (httpStatus >= 500) return true;
  return false;
}

export function isAlreadySubmitted(httpStatus?: number): boolean {
  return httpStatus === 409;
}

/** The whole result, not just the status: a malformed 2xx is retried too. */
export function shouldRetry(result: EtimsResult<unknown>): boolean {
  if (result.ok) return false;
  if (result.malformed) return true;
  if (isAlreadySubmitted(result.httpStatus)) return false;
  return isRetryable(result.httpStatus);
}

/**
 * How long to wait before attempt `attempt` (1-based) is tried again.
 *
 * Exponential from 30 s, capped at an hour. `ETIMS_BACKOFF_BASE_MS` exists so a
 * test harness can drain a queue without waiting; production leaves it unset.
 */
export function backoffMs(attempt: number): number {
  const base = Number(process.env.ETIMS_BACKOFF_BASE_MS ?? 30_000);
  if (!Number.isFinite(base) || base <= 0) return 0;
  return Math.min(60 * 60_000, base * 2 ** Math.min(Math.max(attempt, 1) - 1, 7));
}

/** Retryable failures before a document is parked as REJECTED for a human. */
export const MAX_ATTEMPTS = 8;

/**
 * Digitax status onto ours.
 *
 * SUBMITTED is the one that must not be treated as either success or a retry:
 * Digitax's own documentation says eTIMS synced but the final data never came
 * back, and the resolution is to contact support. Retrying would risk a
 * duplicate filing. PENDING means Digitax has the document and KRA has not
 * answered yet — it stays QUEUED, and is *read* later, never re-sent.
 */
export function statusFor(digitax: string | undefined | null): string {
  switch ((digitax ?? "").toUpperCase()) {
    case "COMPLETED":
    case "COMPLETE":
    case "SUCCESS":
    case "ACCEPTED":
      return "ACCEPTED";
    case "FAILED":
    case "REJECTED":
    case "ERROR":
      return "REJECTED";
    case "SUBMITTED":
      return "SUBMITTED";
    default:
      return "QUEUED";
  }
}

// ---------------------------------------------------------------------------
// Wire bodies
// ---------------------------------------------------------------------------

/**
 * The JSON Digitax actually receives.
 *
 * Shared by both adapters so the audit trail is the same shape whichever one
 * ran. Recording the console adapter's own argument object instead would leave
 * a log in camelCase that never crossed a wire — and the whole point of keeping
 * the request verbatim is that someone can compare it against what KRA says it
 * got.
 *
 * Every amount is a number with at most two decimals (unit price excepted —
 * see `reconcileUnitPrice`), and never a float that happens to come out of a
 * division: `0.1 + 0.2` is not a figure to put on a tax document.
 */
export function saleBody(input: SubmitSaleInput): Record<string, unknown> {
  return {
    sale_date: input.saleDate,
    trader_invoice_number: input.traderInvoiceNumber,
    payment_type_code: input.paymentTypeCode,
    invoice_status_code: input.invoiceStatusCode,
    ...(input.customerTin ? { customer_tin: input.customerTin } : {}),
    ...(input.customerName ? { customer_name: input.customerName } : {}),
    ...(input.invoiceDetails ? { invoice_details: input.invoiceDetails } : {}),
    ...(input.callbackUrl ? { callback_url: input.callbackUrl } : {}),
    items: input.items.map((i) => ({
      id: i.id,
      item_name: i.itemName,
      item_class_code: i.itemClassCode,
      item_bar_code: i.itemBarCode,
      item_tax_type_code: i.taxTypeCode,
      quantity: i.quantity,
      unit_price: i.unitPrice,
      total_amount: round2(i.totalAmount),
      ...(i.taxableAmount === undefined ? {} : { taxable_amount: round2(i.taxableAmount) }),
      ...(i.taxAmount === undefined ? {} : { tax_amount: round2(i.taxAmount) }),
      ...(i.discountAmount ? { discount_amount: round2(i.discountAmount) } : {}),
      ...(i.description ? { item_description: i.description } : {}),
      is_stockable: i.isStockable,
    })),
  };
}

export function creditNoteBody(input: CreditNoteInput): Record<string, unknown> {
  return {
    sale_id: input.saleId,
    trader_invoice_number: input.traderInvoiceNumber,
    return_date: input.returnDate,
    ...(input.invoiceDetails ? { invoice_details: input.invoiceDetails } : {}),
    ...(input.callbackUrl ? { callback_url: input.callbackUrl } : {}),
    items: input.items.map((i) => ({
      id: i.id,
      quantity: i.quantity,
      unit_price: i.unitPrice,
      total_amount: round2(i.totalAmount),
      ...(i.description ? { item_description: i.description } : {}),
    })),
  };
}

export function itemBody(input: RegisterItemInput): Record<string, unknown> {
  return {
    item_class_code: input.itemClassCode,
    item_type_code: input.itemTypeCode,
    item_name: input.itemName,
    origin_nation_code: input.originNationCode,
    package_unit_code: input.packageUnitCode,
    quantity_unit_code: input.quantityUnitCode,
    tax_type_code: input.taxTypeCode,
    default_unit_price: round2(input.defaultUnitPrice),
    ...(input.itemBarCode ? { item_bar_code: input.itemBarCode } : {}),
    ...(input.callbackUrl ? { callback_url: input.callbackUrl } : {}),
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Builds a sale or credit line's amounts from cents.
 *
 * One place, so a sale and the credit note that reverses it agree to the cent
 * on what a unit cost. `quantity` is in base units.
 */
export function lineAmounts(
  quantity: number,
  totalCents: number,
  netCents?: number,
  taxCents?: number,
): { quantity: number; unitPrice: number; totalAmount: number; taxableAmount?: number; taxAmount?: number } {
  const { unitPrice } = reconcileUnitPrice(quantity, totalCents);
  return {
    quantity,
    unitPrice,
    totalAmount: toAmount(totalCents),
    ...(netCents === undefined ? {} : { taxableAmount: toAmount(netCents) }),
    ...(taxCents === undefined ? {} : { taxAmount: toAmount(taxCents) }),
  };
}

// ---------------------------------------------------------------------------
// Console adapter
// ---------------------------------------------------------------------------

/**
 * Records without transmitting.
 *
 * This exists so the whole flow — registration, submission, control code on a
 * printed invoice, credit note — can be exercised and demonstrated before
 * anyone has a Digitax account.
 *
 * It is a development adapter and **never a fallback**. `adapterFor` below
 * chooses it only when a company is explicitly in SANDBOX with no key. A LIVE
 * company whose credentials fail to resolve gets an error and a queued
 * submission, because a mock that reports success while a company believes it
 * is filing with KRA is the worst thing this module could do.
 */
export const consoleAdapter: EtimsAdapter = {
  name: "console",

  async info() {
    return {
      ok: true,
      data: {
        tax_pin: "P000000000X",
        branch_office_name: "Console (not transmitted)",
        is_head_office: true,
      },
    };
  },

  async registerItem(_c, input) {
    return {
      ok: true,
      data: {
        id: `console-item-${crypto.randomUUID()}`,
        etimsItemCode: `CONSOLE-${input.itemName.slice(0, 6).toUpperCase()}`,
        status: "COMPLETE",
      },
      request: itemBody(input),
    };
  },

  async registerCustomer(_c, input) {
    return {
      ok: true,
      data: { id: `console-cust-${crypto.randomUUID()}` },
      request: { customer_name: input.name, customer_tin: input.taxPin },
    };
  },

  async submitSale(_c, input) {
    return {
      ok: true,
      data: fakeSale(input.traderInvoiceNumber),
      request: saleBody(input),
    };
  },

  async submitCreditNote(_c, input) {
    // Keyed on the sale id, not the invoice number: two returns against one
    // invoice must not produce the same control code.
    return {
      ok: true,
      data: fakeSale(`${input.saleId}:${input.traderInvoiceNumber}:${input.returnDate}`),
      request: creditNoteBody(input),
    };
  },

  async adjustStock(_c, input) {
    return {
      ok: true,
      data: { stockQuantity: 0 },
      request: {
        item_id: input.itemId,
        quantity: input.quantity,
        action: input.action,
        movement_type: input.movementType,
      },
    };
  },

  async fetchSale(_c, saleId) {
    return { ok: true, data: fakeSale(saleId) };
  },

  async findSaleByTraderNumber() {
    // The console never holds anything, so there is never a duplicate to find.
    return { ok: true, data: null };
  },
};

function fakeSale(ref: string): SaleResult {
  // Deterministic from the reference, so re-reading a console submission gives
  // the same control code rather than a new one each time.
  const digest = crypto.createHash("sha1").update(ref).digest("hex").toUpperCase();
  return {
    id: `console-sale-${digest.slice(0, 12)}`,
    controlCode: digest.slice(0, 16),
    invoiceNumber: String(parseInt(digest.slice(0, 6), 16) % 100000),
    serialNumber: `CONSOLE${digest.slice(0, 8)}`,
    receiptNumber: parseInt(digest.slice(6, 10), 16) % 10000,
    qrUrl: `https://etims.kra.go.ke/common/link/etims/receipt/indexEtimsReceptData?{CONSOLE+00+${digest.slice(0, 16)}}`,
    offlineUrl: null as unknown as string,
    status: "COMPLETED",
  };
}

// ---------------------------------------------------------------------------
// Digitax adapter
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 20_000;

/** `ETIMS_TIMEOUT_MS`, read per call so a test can shorten it. */
export function timeoutMs(): number {
  const n = Number(process.env.ETIMS_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
}

export interface CallOptions {
  /**
   * Sent as `Idempotency-Key`. Digitax keys a sale on its trader invoice
   * number already, so this is belt and braces: harmless if ignored, and a
   * second line of defence against a double filing if honoured.
   */
  idempotencyKey?: string;
}

/**
 * Pulls a human-readable message out of whatever error shape came back.
 *
 * Digitax has been seen to answer with `message`, `detail`, `error`, and an
 * `errors` field that is sometimes an array of strings, sometimes a map of
 * field → messages. The audit trail keeps the raw body; this is for the
 * column an operator reads first.
 */
export function errorMessage(json: Record<string, unknown>, text: string, status: number): string {
  const parts: string[] = [];
  for (const key of ["message", "detail", "error"]) {
    const v = json[key];
    if (typeof v === "string" && v.trim()) parts.push(v.trim());
    else if (v && typeof v === "object" && typeof (v as { message?: unknown }).message === "string") {
      parts.push(String((v as { message: string }).message));
    }
  }
  const errors = json.errors;
  if (Array.isArray(errors)) {
    for (const e of errors) {
      if (typeof e === "string") parts.push(e);
      else if (e && typeof e === "object") {
        const m = (e as { message?: unknown; msg?: unknown }).message ?? (e as { msg?: unknown }).msg;
        const field = (e as { field?: unknown; loc?: unknown }).field ?? (e as { loc?: unknown }).loc;
        if (typeof m === "string") parts.push(field ? `${Array.isArray(field) ? field.join(".") : field}: ${m}` : m);
      }
    }
  } else if (errors && typeof errors === "object") {
    for (const [field, v] of Object.entries(errors as Record<string, unknown>)) {
      const msgs = Array.isArray(v) ? v : [v];
      for (const m of msgs) if (typeof m === "string") parts.push(`${field}: ${m}`);
    }
  }
  if (parts.length > 0) return [...new Set(parts)].join("; ").slice(0, 500);
  if (text.trim()) return text.trim().slice(0, 500);
  return `HTTP ${status}`;
}

/**
 * One request.
 *
 * The client is built per call from the credentials passed in — there is no
 * module-level client and nothing is memoised across companies. In Phase 1 a
 * shared OAuth token cache keyed on the provider name would have served one
 * tenant's token to another; the same mistake here would file one company's
 * sales under another company's PIN.
 *
 * Exported for the unit tests, which stub `fetch` and exercise it directly.
 */
export async function call<T>(
  creds: EtimsCredentials,
  method: string,
  path: string,
  body: unknown,
  map: (json: Record<string, unknown>) => T,
  opts: CallOptions = {},
): Promise<EtimsResult<T>> {
  const url = `${creds.baseUrl.replace(/\/$/, "")}${path}`;
  const controller = new AbortController();
  const limit = timeoutMs();
  const timer = setTimeout(() => controller.abort(), limit);

  try {
    const res = await fetch(url, {
      method,
      headers: {
        "X-API-Key": creds.apiKey,
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(opts.idempotencyKey && method !== "GET" ? { "Idempotency-Key": opts.idempotencyKey } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
    });

    const text = await res.text();
    let json: Record<string, unknown> | null = null;
    try {
      const parsed: unknown = text ? JSON.parse(text) : {};
      if (parsed !== null && typeof parsed === "object") json = parsed as Record<string, unknown>;
    } catch {
      json = null;
    }

    if (!res.ok) {
      return {
        ok: false,
        httpStatus: res.status,
        error: errorMessage(json ?? {}, text, res.status),
        request: body,
        response: json ?? { raw: text.slice(0, 2000) },
      };
    }

    if (json === null) {
      // A 2xx that is not JSON is not an empty sale. Something between us and
      // the API answered — treat it as "unknown whether it landed" and retry;
      // a duplicate is caught by the 409 path.
      return {
        ok: false,
        httpStatus: res.status,
        malformed: true,
        error: `HTTP ${res.status} with a non-JSON body: ${text.trim().slice(0, 200) || "(empty)"}`,
        request: body,
        response: { raw: text.slice(0, 2000) },
      };
    }

    return { ok: true, httpStatus: res.status, data: map(json), request: body, response: json };
  } catch (error) {
    // No status: a timeout or a DNS/socket failure. Retryable by definition.
    const aborted = error instanceof Error && error.name === "AbortError";
    return {
      ok: false,
      error: aborted
        ? `Timed out after ${limit} ms waiting for Digitax`
        : error instanceof Error
          ? error.message
          : String(error),
      request: body,
    };
  } finally {
    clearTimeout(timer);
  }
}

const asSale = (j: Record<string, unknown>): SaleResult => ({
  id: String(j.id ?? ""),
  controlCode: (j.receipt_signature as string) ?? undefined,
  invoiceNumber: j.invoice_number === undefined || j.invoice_number === null ? undefined : String(j.invoice_number),
  serialNumber: (j.serial_number as string) ?? undefined,
  receiptNumber: typeof j.receipt_number === "number" ? j.receipt_number : undefined,
  qrUrl: (j.etims_url as string) ?? undefined,
  offlineUrl: (j.offline_url as string) ?? undefined,
  status: String(j.status ?? "PENDING"),
});

/**
 * A list response, whatever envelope it arrived in: a bare array, `data`,
 * `results` or `items`.
 */
function firstOfList(j: Record<string, unknown>): Record<string, unknown> | null {
  const candidates: unknown[] = [j, j.data, j.results, j.items];
  for (const c of candidates) {
    if (Array.isArray(c)) {
      const first = c[0];
      return first && typeof first === "object" ? (first as Record<string, unknown>) : null;
    }
  }
  // A single object with an id is itself the answer.
  return typeof j.id === "string" && j.id ? j : null;
}

export const digitaxAdapter: EtimsAdapter = {
  name: "digitax",

  info: (c) => call(c, "GET", "/etims-info", undefined, (j) => j),

  registerItem: (c, input) =>
    call(c, "POST", "/items", itemBody(input), (j) => ({
      id: String(j.id ?? ""),
      etimsItemCode: (j.etims_item_code as string) ?? undefined,
      status: String(j.status ?? "PENDING"),
    })),

  registerCustomer: (c, input) =>
    call(
      c,
      "POST",
      "/customers",
      {
        customer_name: input.name,
        customer_tin: input.taxPin,
        ...(input.email ? { email: input.email } : {}),
        ...(input.phone ? { phone: input.phone } : {}),
      },
      (j) => ({ id: String(j.id ?? "") }),
    ),

  submitSale: (c, input) =>
    call(c, "POST", "/sales-with-items", saleBody(input), asSale, {
      idempotencyKey: input.traderInvoiceNumber,
    }),

  submitCreditNote: (c, input) =>
    call(c, "POST", "/credit-notes", creditNoteBody(input), asSale, {
      idempotencyKey: input.traderInvoiceNumber,
    }),

  adjustStock: (c, input) =>
    call(
      c,
      "PUT",
      "/stock/adjust",
      {
        item_id: input.itemId,
        quantity: input.quantity,
        action: input.action,
        movement_type: input.movementType,
      },
      (j) => ({ stockQuantity: Number(j.stock_quantity ?? 0) }),
    ),

  fetchSale: (c, saleId) =>
    call(c, "GET", `/sales/${encodeURIComponent(saleId)}`, undefined, asSale),

  async findSaleByTraderNumber(c, traderInvoiceNumber) {
    const r = await call(
      c,
      "GET",
      `/sales?trader_invoice_number=${encodeURIComponent(traderInvoiceNumber)}`,
      undefined,
      (j) => {
        const row = firstOfList(j);
        if (!row) return null;
        // A list endpoint may match loosely; only our exact number counts.
        const n = row.trader_invoice_number;
        if (typeof n === "string" && n !== traderInvoiceNumber) return null;
        return asSale(row);
      },
    );
    // "No such sale" is a definite answer, not a failure.
    if (!r.ok && r.httpStatus === 404) return { ok: true, data: null, httpStatus: 404, response: r.response };
    return r;
  },
};

/**
 * Base URL, from the company's own setting or the deployment default.
 *
 * A SANDBOX company with no URL of its own uses `DIGITAX_SANDBOX_BASE_URL` when
 * the deployment sets one. It falls back to the production URL only when that
 * is unset — a sandbox that cannot reach anything would hide every
 * integration problem until the switch to live, which is the one moment they
 * must not appear. The console adapter, not a URL, is what makes a keyless
 * sandbox safe.
 */
export function baseUrlFor(stored?: string | null, environment?: string | null): string {
  if (stored) return stored;
  if (environment === "SANDBOX" && process.env.DIGITAX_SANDBOX_BASE_URL) {
    return process.env.DIGITAX_SANDBOX_BASE_URL;
  }
  return process.env.DIGITAX_BASE_URL || DEFAULT_BASE_URL;
}

/**
 * Picks the adapter.
 *
 * SANDBOX without a key falls to console so the flow can be demonstrated. LIVE
 * without a key is an error, never console — see the note at the top of this
 * file.
 */
export function adapterFor(
  environment: string,
  hasCredentials: boolean,
): EtimsAdapter | null {
  if (hasCredentials) return digitaxAdapter;
  if (environment === "SANDBOX") return consoleAdapter;
  return null;
}
