/**
 * Money is stored as integer KES cents throughout. Nothing in this file may
 * return a float that later gets written back to the database — rounding is
 * applied at the point a value becomes a stored amount, never after.
 */

export const CURRENCY = "KES";

export function toCents(amount: number): number {
  return Math.round(amount * 100);
}

export function fromCents(cents: number): number {
  return cents / 100;
}

/** "KES 214,500" — the format used on the proposal's mockups. */
export function formatKES(cents: number, opts?: { decimals?: boolean }): string {
  const value = cents / 100;
  const decimals = opts?.decimals ?? false;
  return `${CURRENCY} ${value.toLocaleString("en-KE", {
    minimumFractionDigits: decimals ? 2 : 0,
    maximumFractionDigits: decimals ? 2 : 0,
  })}`;
}

/** Compact form for dashboard tiles: KES 18.4M, KES 214.5K. */
export function formatKESCompact(cents: number): string {
  const value = cents / 100;
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${CURRENCY} ${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${CURRENCY} ${(value / 1_000).toFixed(1)}K`;
  return `${CURRENCY} ${value.toFixed(0)}`;
}

export interface LineInput {
  quantity: number;
  unitPriceCents: number;
  discountCents?: number;
  taxRateBp?: number;
}

export interface LineTotals {
  grossCents: number;
  discountCents: number;
  netCents: number;
  taxCents: number;
  lineTotalCents: number;
}

/**
 * Line maths for quotations, orders, invoices and POs.
 *
 * Discount applies to the gross line before tax, which is how Kenyan VAT
 * invoices are laid out: VAT is charged on the discounted consideration.
 */
export function computeLine(line: LineInput): LineTotals {
  const grossCents = line.quantity * line.unitPriceCents;
  const discountCents = Math.min(line.discountCents ?? 0, grossCents);
  const netCents = grossCents - discountCents;
  const taxCents = Math.round((netCents * (line.taxRateBp ?? 0)) / 10_000);
  return {
    grossCents,
    discountCents,
    netCents,
    taxCents,
    lineTotalCents: netCents + taxCents,
  };
}

export interface DocumentTotals {
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  totalCents: number;
}

/** Rolls a set of lines into document-level totals. */
export function computeTotals(lines: LineInput[]): DocumentTotals {
  let subtotalCents = 0;
  let discountCents = 0;
  let taxCents = 0;
  let totalCents = 0;

  for (const line of lines) {
    const t = computeLine(line);
    subtotalCents += t.grossCents;
    discountCents += t.discountCents;
    taxCents += t.taxCents;
    totalCents += t.lineTotalCents;
  }

  return { subtotalCents, discountCents, taxCents, totalCents };
}

/** The VAT inside a tax-inclusive amount, rounded the way KRA derives it. */
export function inclusiveTax(totalCents: number, taxRateBp: number): number {
  return Math.round((totalCents * taxRateBp) / (10_000 + taxRateBp));
}

/** A line as stored on an invoice — what the customer was actually charged. */
export interface ChargedLine {
  quantity: number;
  unitPriceCents: number;
  discountCents: number;
  taxRateBp: number;
  lineTotalCents: number;
}

/**
 * Splits a stored invoice line into its charged components.
 *
 * `lineTotalCents` already has the discount taken off and VAT added — it is
 * `computeLine`'s output. Two separate bugs came from subtracting the discount
 * from it a second time: returns credited less than was charged, and discounted
 * sales were filed with KRA on an understated taxable base. Anything that needs
 * the parts of a charged line gets them here, not by re-deriving them.
 */
export function chargedLine(line: ChargedLine): LineTotals {
  const computed = computeLine(line);
  if (computed.lineTotalCents === line.lineTotalCents) return computed;

  // A stored total the formula does not reproduce — written before computeLine
  // was the only engine. What the customer paid wins; VAT is split out of it.
  const taxCents = inclusiveTax(line.lineTotalCents, line.taxRateBp);
  const netCents = line.lineTotalCents - taxCents;
  return {
    grossCents: netCents + computed.discountCents,
    discountCents: computed.discountCents,
    netCents,
    taxCents,
    lineTotalCents: line.lineTotalCents,
  };
}

export interface CreditAmounts {
  totalCents: number;
  taxCents: number;
  netCents: number;
}

/**
 * What to credit when `quantity` units of a sold line come back.
 *
 * Credited at the price actually charged, discount and all — never today's
 * price, which would refund more than was taken after a price rise. A partial
 * return takes its proportional share; the return that completes the line takes
 * exactly what is left. However the line is returned, the credits add up to the
 * cent to what was charged, so a full return leaves nothing on the customer's
 * balance — including a line part-credited by the old formula, whose shortfall
 * the completing return makes good.
 *
 * VAT on a partial return is extracted from its tax-inclusive total, which is
 * how KRA derives it from the filed amounts; the completing return takes the
 * remainder of the line's VAT so the reversal matches what was charged.
 *
 * @param prior the line's earlier, uncancelled credits
 */
export function creditLineAmounts(
  line: ChargedLine,
  prior: ReadonlyArray<{ quantity: number; lineTotalCents: number }>,
  quantity: number,
): CreditAmounts {
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new Error("Credited quantity must be a positive whole number");
  }

  let creditedQuantity = 0;
  let creditedTotal = 0;
  let creditedTax = 0;
  for (const p of prior) {
    creditedQuantity += p.quantity;
    creditedTotal += p.lineTotalCents;
    creditedTax += inclusiveTax(p.lineTotalCents, line.taxRateBp);
  }

  const remaining = line.quantity - creditedQuantity;
  if (quantity > remaining) {
    throw new Error(`Cannot credit ${quantity}: only ${remaining} remain uncredited`);
  }

  const charged = chargedLine(line);
  if (quantity === remaining) {
    const totalCents = charged.lineTotalCents - creditedTotal;
    const taxCents = charged.taxCents - creditedTax;
    return { totalCents, taxCents, netCents: totalCents - taxCents };
  }

  const totalCents = Math.round((charged.lineTotalCents * quantity) / line.quantity);
  const taxCents = inclusiveTax(totalCents, line.taxRateBp);
  return { totalCents, taxCents, netCents: totalCents - taxCents };
}

/**
 * Invoice status derived from what has been paid and when it fell due.
 * Kept in one place so the console, the API and the SMS reminder job cannot
 * disagree about whether an invoice is overdue.
 */
export function deriveInvoiceStatus(params: {
  totalCents: number;
  paidCents: number;
  dueDate: Date | null;
  current: string;
  now?: Date;
}): string {
  const { totalCents, paidCents, dueDate, current } = params;
  if (current === "DRAFT" || current === "CANCELLED") return current;

  if (paidCents >= totalCents && totalCents > 0) return "PAID";

  const now = params.now ?? new Date();
  const overdue = dueDate != null && dueDate < now;

  if (paidCents > 0) return overdue ? "OVERDUE" : "PARTIALLY_PAID";
  return overdue ? "OVERDUE" : "ISSUED";
}

/** Receivables ageing buckets used by the Finance dashboard. */
export type AgeBucket = "CURRENT" | "D1_30" | "D31_60" | "D61_90" | "D90_PLUS";

export function ageBucket(dueDate: Date | null, now = new Date()): AgeBucket {
  if (!dueDate || dueDate >= now) return "CURRENT";
  const days = Math.floor((now.getTime() - dueDate.getTime()) / 86_400_000);
  if (days <= 30) return "D1_30";
  if (days <= 60) return "D31_60";
  if (days <= 90) return "D61_90";
  return "D90_PLUS";
}

export const AGE_BUCKET_LABELS: Record<AgeBucket, string> = {
  CURRENT: "Current",
  D1_30: "1–30 days",
  D31_60: "31–60 days",
  D61_90: "61–90 days",
  D90_PLUS: "90+ days",
};
