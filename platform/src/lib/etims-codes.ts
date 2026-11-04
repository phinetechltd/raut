/**
 * eTIMS code tables.
 *
 * Split out of `etims.ts` deliberately: that module is `server-only` because it
 * makes authenticated calls on a company's behalf, but these tables are just
 * KRA's published enumerations and the settings form has to render them. A
 * client component importing the server module would pull the whole adapter —
 * and its credential handling — toward the browser bundle.
 */

// ---------------------------------------------------------------------------
// Codes
// ---------------------------------------------------------------------------

/** eTIMS taxation types and the rate each stands for. */
export const TAX_TYPES = {
  A: { label: "Exempt", rateBp: 0 },
  B: { label: "VAT 16%", rateBp: 1600 },
  C: { label: "Zero rated", rateBp: 0 },
  D: { label: "Non-VAT", rateBp: 0 },
  E: { label: "VAT 8%", rateBp: 800 },
} as const;

export type TaxTypeCode = keyof typeof TAX_TYPES;

export const ITEM_TYPES = {
  "1": "Raw material",
  "2": "Finished product",
  "3": "Service (not stocked)",
} as const;

/**
 * Generic item classifications.
 *
 * These are legitimate — 99000000 is the VAT Act catch-all — and they let a
 * company start filing today rather than after someone has classified nine
 * hundred SKUs. They are a starting point, not an answer: the console flags
 * products still sitting on one.
 *
 * The zero-rated codes split by destination, which is the distinction Digitax
 * had to publish a clarification about: 99012000 is **exports only** (D2);
 * domestic zero-rated supplies are D1.
 */
export const ITEM_CLASSES = {
  "99000000": "General (VAT Act)",
  "99010000": "Goods",
  "99020000": "Services",
  "99012000": "Zero-rated goods — exports (D2)",
  "99022000": "Zero-rated service (D1)",
  "99032000": "Zero-rated goods or services (D1)",
  "99042000": "Zero-rated government undertaking (D1)",
} as const;

/** A useful subset of the 57 quantity units, covering what a distributor sells. */
export const QUANTITY_UNITS = {
  U: "Pieces / item",
  KG: "Kilogramme",
  L: "Litre",
  M: "Metre",
  M2: "Square metre",
  M3: "Cubic metre",
  BG: "Bag",
  BA: "Barrel",
  TNE: "Tonne",
} as const;

/** A useful subset of the 66 packaging units. */
export const PACKAGE_UNITS = {
  NT: "Net / unpackaged",
  CT: "Carton",
  BG: "Bag",
  CA: "Can",
  DR: "Drum",
  BA: "Barrel",
  VL: "Bulk liquid",
  VR: "Bulk granular",
} as const;

/** Payment type codes, mapped from the method recorded against a payment. */
export function paymentTypeCode(method: string | null | undefined): string {
  switch (method) {
    case "CASH":
      return "01";
    case "BANK":
      return "04";
    case "CHEQUE":
      return "04";
    case "MPESA":
    case "MPESA_STK":
    case "KCB_BUNI":
      return "06";
    case "PAYSTACK":
      return "05";
    case "CREDIT_NOTE":
      return "02";
    // An invoice with nothing received against it is sold on credit, which is
    // what 02 means. Defaulting to cash would misreport every credit sale.
    default:
      return "02";
  }
}

/** Stock movement codes. Incoming 01–06, outgoing 11–16. */
export const STOCK_MOVEMENTS = {
  IMPORT: "01",
  PURCHASE: "02",
  RETURN_IN: "03",
  TRANSFER_IN: "04",
  PROCESSING_IN: "05",
  ADJUSTMENT_IN: "06",
  SALE: "11",
  RETURN_OUT: "12",
  TRANSFER_OUT: "13",
  PROCESSING_OUT: "14",
  DISCARD: "15",
  ADJUSTMENT_OUT: "16",
} as const;

/**
 * Maps a Raut tax rate onto the eTIMS taxation type.
 *
 * A rate of zero is ambiguous: KRA distinguishes a **zero-rated** supply (C,
 * VAT at 0%, input tax reclaimable) from an **exempt** one (A, outside VAT
 * altogether), and the two land on different lines of the return. The rate
 * alone cannot tell them apart, so a product may carry an explicit
 * `etimsTaxTypeCode` which wins over the rate whenever it is a known code.
 * Without one, zero falls to C — the common case for a distributor's
 * zero-rated staples — and the settings console flags the choice.
 *
 * The same function serves item registration and every sale line, so a product
 * cannot be registered under one type and sold under another.
 */
export function taxTypeForRate(rateBp: number, override?: string | null): TaxTypeCode {
  if (override && isTaxTypeCode(override)) return override;
  if (rateBp >= 1600) return "B";
  if (rateBp >= 800) return "E";
  return "C";
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function isTaxTypeCode(code: unknown): code is TaxTypeCode {
  return typeof code === "string" && Object.hasOwn(TAX_TYPES, code);
}

export function isItemTypeCode(code: unknown): code is keyof typeof ITEM_TYPES {
  return typeof code === "string" && Object.hasOwn(ITEM_TYPES, code);
}

/**
 * An item classification code.
 *
 * The table above is a starting set, not KRA's whole list, which runs to
 * thousands of UNSPSC-style codes. A company that has classified its stock
 * properly must be able to store those, so any eight-digit code is accepted on
 * a product; the *defaults* in settings are restricted to the table, because
 * they are picked from it.
 */
export function isItemClassCode(code: unknown, opts?: { tableOnly?: boolean }): boolean {
  if (typeof code !== "string") return false;
  if (Object.hasOwn(ITEM_CLASSES, code)) return true;
  return !opts?.tableOnly && /^\d{8}$/.test(code);
}

export function isQuantityUnit(code: unknown): code is keyof typeof QUANTITY_UNITS {
  return typeof code === "string" && Object.hasOwn(QUANTITY_UNITS, code);
}

export function isPackageUnit(code: unknown): code is keyof typeof PACKAGE_UNITS {
  return typeof code === "string" && Object.hasOwn(PACKAGE_UNITS, code);
}

/**
 * A KRA PIN: A or P, nine digits, a check letter. `P051234567X`.
 *
 * Checked wherever a PIN is about to be put on a tax document — the stored
 * Digitax TIN, the company's own PIN, a customer's PIN — because a malformed
 * one is refused by KRA with a message that does not say which PIN it meant.
 */
export const KRA_PIN_RE = /^[AP]\d{9}[A-Z]$/;

export function isValidKraPin(pin: unknown): pin is string {
  return typeof pin === "string" && KRA_PIN_RE.test(pin.trim());
}

// ---------------------------------------------------------------------------
// Dates and amounts on the wire
// ---------------------------------------------------------------------------

/**
 * The calendar date in Nairobi, as `YYYY-MM-DD`.
 *
 * `issueDate` is stored as an instant. A sale rung up at 01:00 on the 2nd in
 * Nairobi is 22:00 on the 1st in UTC, and `toISOString().slice(0, 10)` filed it
 * on the wrong day — a date KRA compares against the day the invoice was
 * issued. East Africa Time is a fixed UTC+3 with no daylight saving, so the
 * offset is applied directly rather than through a locale formatter.
 */
export function nairobiDate(instant: Date): string {
  return new Date(instant.getTime() + 3 * 60 * 60_000).toISOString().slice(0, 10);
}

/** Cents to a two-decimal amount, as a number: 12345 → 123.45. */
export function toAmount(cents: number): number {
  return Math.round(cents) / 100;
}

/**
 * A unit price that multiplies back to the line total.
 *
 * The line total is authoritative; eTIMS checks `quantity × unit_price` against
 * `total_amount` and rejects a line that does not add up. Dividing the total
 * by the quantity and rounding to two places does not always survive the
 * round trip — 3 units for KES 1.00 is 0.33 each, which is 0.99 — so the price
 * is given as many decimals as it needs, up to six, for the product to round
 * back to the total to the cent. `reconciles` is false in the rare case even
 * that is not enough; the caller then relies on the explicit taxable and tax
 * amounts it sends alongside.
 */
export function reconcileUnitPrice(
  quantity: number,
  totalCents: number,
): { unitPrice: number; reconciles: boolean } {
  if (quantity <= 0) return { unitPrice: 0, reconciles: totalCents === 0 };
  const total = toAmount(totalCents);
  for (let decimals = 2; decimals <= 6; decimals++) {
    const factor = 10 ** decimals;
    const unitPrice = Math.round((total / quantity) * factor) / factor;
    if (Math.round(unitPrice * quantity * 100) === Math.round(totalCents)) {
      return { unitPrice, reconciles: true };
    }
  }
  return { unitPrice: Math.round((total / quantity) * 100) / 100, reconciles: false };
}

