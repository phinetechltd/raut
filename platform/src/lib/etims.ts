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
  paymentTypeCode,
  taxTypeForRate,
  type TaxTypeCode,
} from "./etims-codes";

import { taxTypeForRate } from "./etims-codes";

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
      total_amount: i.totalAmount,
      ...(i.taxableAmount === undefined ? {} : { taxable_amount: i.taxableAmount }),
      ...(i.taxAmount === undefined ? {} : { tax_amount: i.taxAmount }),
      ...(i.discountAmount ? { discount_amount: i.discountAmount } : {}),
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
      total_amount: i.totalAmount,
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
    default_unit_price: input.defaultUnitPrice,
    ...(input.itemBarCode ? { item_bar_code: input.itemBarCode } : {}),
    ...(input.callbackUrl ? { callback_url: input.callbackUrl } : {}),
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

const TIMEOUT_MS = 20_000;

/**
 * One request.
 *
 * The client is built per call from the credentials passed in — there is no
 * module-level client and nothing is memoised across companies. In Phase 1 a
 * shared OAuth token cache keyed on the provider name would have served one
 * tenant's token to another; the same mistake here would file one company's
 * sales under another company's PIN.
 */
async function call<T>(
  creds: EtimsCredentials,
  method: string,
  path: string,
  body: unknown,
  map: (json: Record<string, unknown>) => T,
): Promise<EtimsResult<T>> {
  const url = `${creds.baseUrl.replace(/\/$/, "")}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method,
      headers: {
        "X-API-Key": creds.apiKey,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
    });

    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      // A non-JSON body is itself the diagnostic; keep it as the error.
    }

    if (!res.ok) {
      return {
        ok: false,
        httpStatus: res.status,
        error:
          (typeof json.message === "string" ? json.message : null) ??
          text.slice(0, 500) ??
          `HTTP ${res.status}`,
        request: body,
        response: json,
      };
    }

    return { ok: true, httpStatus: res.status, data: map(json), request: body, response: json };
  } catch (error) {
    // No status: a timeout or a DNS/socket failure. Retryable by definition.
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      request: body,
    };
  } finally {
    clearTimeout(timer);
  }
}

const asSale = (j: Record<string, unknown>): SaleResult => ({
  id: String(j.id ?? ""),
  controlCode: (j.receipt_signature as string) ?? undefined,
  invoiceNumber: j.invoice_number === undefined ? undefined : String(j.invoice_number),
  serialNumber: (j.serial_number as string) ?? undefined,
  receiptNumber: typeof j.receipt_number === "number" ? j.receipt_number : undefined,
  qrUrl: (j.etims_url as string) ?? undefined,
  offlineUrl: (j.offline_url as string) ?? undefined,
  status: String(j.status ?? "PENDING"),
});

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
    call(c, "POST", "/sales-with-items", saleBody(input), asSale),

  submitCreditNote: (c, input) =>
    call(c, "POST", "/credit-notes", creditNoteBody(input), asSale),

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

  fetchSale: (c, saleId) => call(c, "GET", `/sales/${saleId}`, undefined, asSale),
};

/** Base URL, from the company's own setting or the deployment default. */
export function baseUrlFor(stored?: string | null): string {
  return stored || process.env.DIGITAX_BASE_URL || DEFAULT_BASE_URL;
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
