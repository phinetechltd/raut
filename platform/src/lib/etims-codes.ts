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

/** Maps a Raut tax rate onto the eTIMS taxation type. */
export function taxTypeForRate(rateBp: number): TaxTypeCode {
  if (rateBp >= 1600) return "B";
  if (rateBp >= 800) return "E";
  return "C";
}

