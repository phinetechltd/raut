import "server-only";

import { conflict, notFound } from "@/lib/api";
import { db } from "@/lib/db";
import { computeTotals } from "@/lib/money";
import { nextNumber } from "@/lib/numbering";
import { isSelfScoped, type Principal } from "@/lib/rbac";
import { scope } from "@/lib/tenant";

import { createInvoice, createSalesOrder, resolveLines, type DraftLine } from "./sales";

/**
 * QuotationLine has no variant/base columns (a quote is product × quantity at a
 * price), so the shared resolver's richer line is narrowed to what the table
 * holds before it is written.
 */
type ResolvedLine = Awaited<ReturnType<typeof resolveLines>>[number];
function toQuotationLines(lines: ResolvedLine[]) {
  return lines.map((l) => ({
    productId: l.productId,
    description: l.description,
    quantity: l.quantity,
    unitPriceCents: l.unitPriceCents,
    discountCents: l.discountCents,
    taxRateBp: l.taxRateBp,
    lineTotalCents: l.lineTotalCents,
  }));
}

/**
 * Quotations — the front of the sale (proposal §2, "Quotations, orders,
 * invoices"). A quote is priced exactly like an order (same resolveLines, same
 * totals), moves DRAFT → SENT → ACCEPTED/REJECTED/EXPIRED, and converts into an
 * order or straight to an invoice, carrying its lines across unchanged.
 */

const EDITABLE = new Set(["DRAFT"]);
const CONVERTIBLE = new Set(["DRAFT", "SENT", "ACCEPTED"]);

/** Reps see only quotations they raised; everyone else sees the company's. */
function quoteScope(principal: Principal) {
  const where: Record<string, unknown> = scope(principal);
  if (isSelfScoped(principal)) where.createdById = principal.userId;
  return where;
}

export interface QuotationInput {
  customerId: string;
  lines: DraftLine[];
  validUntil?: string | null;
  note?: string | null;
  branchId?: string | null;
  /** Mark SENT on create rather than leaving a DRAFT. */
  send?: boolean;
}

export async function listQuotations(
  principal: Principal,
  opts: { status?: string; q?: string; customerId?: string } = {},
) {
  const where: Record<string, unknown> = quoteScope(principal);
  if (opts.status) where.status = opts.status;
  if (opts.customerId) where.customerId = opts.customerId;
  if (opts.q) where.OR = [{ number: { contains: opts.q } }, { customer: { name: { contains: opts.q } } }];
  return db.quotation.findMany({
    where,
    include: { customer: { select: { id: true, name: true, code: true } } },
    orderBy: { issueDate: "desc" },
    take: 500,
  });
}

export async function getQuotation(principal: Principal, id: string) {
  const quotation = await db.quotation.findFirst({
    where: { id, ...quoteScope(principal) },
    include: { customer: true, lines: true, orders: { select: { id: true, number: true } } },
  });
  if (!quotation) throw notFound("Quotation not found");
  return quotation;
}

export async function createQuotation(principal: Principal, input: QuotationInput) {
  const companyId = principal.companyId!;
  const customer = await db.customer.findFirst({ where: { id: input.customerId, companyId }, select: { id: true } });
  if (!customer) throw notFound("Customer not found");
  if (!input.lines?.length) throw conflict("A quotation needs at least one line");

  return db.$transaction(async (tx) => {
    const lines = await resolveLines(tx, companyId, input.lines);
    const totals = computeTotals(lines);
    const number = await nextNumber(companyId, "QUOTE", tx);
    return tx.quotation.create({
      data: {
        companyId,
        customerId: input.customerId,
        branchId: input.branchId ?? null,
        number,
        status: input.send ? "SENT" : "DRAFT",
        validUntil: input.validUntil ? new Date(input.validUntil) : null,
        note: input.note ?? null,
        createdById: principal.userId,
        subtotalCents: totals.subtotalCents,
        discountCents: totals.discountCents,
        taxCents: totals.taxCents,
        totalCents: totals.totalCents,
        lines: { create: toQuotationLines(lines) },
      },
      include: { lines: true, customer: { select: { id: true, name: true, code: true } } },
    });
  }, { timeout: 15_000 });
}

export async function updateQuotation(
  principal: Principal,
  id: string,
  input: { lines?: DraftLine[]; validUntil?: string | null; note?: string | null },
) {
  const companyId = principal.companyId!;
  const existing = await db.quotation.findFirst({ where: { id, ...quoteScope(principal) }, select: { id: true, status: true } });
  if (!existing) throw notFound("Quotation not found");
  if (!EDITABLE.has(existing.status)) throw conflict("Only a draft quotation can be edited");

  return db.$transaction(async (tx) => {
    const data: Record<string, unknown> = {};
    if (input.validUntil !== undefined) data.validUntil = input.validUntil ? new Date(input.validUntil) : null;
    if (input.note !== undefined) data.note = input.note;

    if (input.lines) {
      if (!input.lines.length) throw conflict("A quotation needs at least one line");
      const lines = await resolveLines(tx, companyId, input.lines);
      const totals = computeTotals(lines);
      data.subtotalCents = totals.subtotalCents;
      data.discountCents = totals.discountCents;
      data.taxCents = totals.taxCents;
      data.totalCents = totals.totalCents;
      await tx.quotationLine.deleteMany({ where: { quotationId: id } });
      data.lines = { create: toQuotationLines(lines) };
    }

    return tx.quotation.update({
      where: { id },
      data,
      include: { lines: true, customer: { select: { id: true, name: true, code: true } } },
    });
  }, { timeout: 15_000 });
}

const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  DRAFT: ["SENT", "REJECTED"],
  SENT: ["ACCEPTED", "REJECTED", "EXPIRED"],
  ACCEPTED: ["REJECTED"],
  REJECTED: ["SENT"],
  EXPIRED: ["SENT"],
};

export async function setQuotationStatus(principal: Principal, id: string, status: string) {
  const existing = await db.quotation.findFirst({ where: { id, ...quoteScope(principal) }, select: { id: true, status: true } });
  if (!existing) throw notFound("Quotation not found");
  if (existing.status === "CONVERTED") throw conflict("A converted quotation can no longer change status");
  const allowed = ALLOWED_TRANSITIONS[existing.status] ?? [];
  if (!allowed.includes(status)) throw conflict(`Cannot move a ${existing.status.toLowerCase()} quotation to ${status.toLowerCase()}`);
  return db.quotation.update({ where: { id }, data: { status } });
}

/**
 * Turns a quotation into an order (default) or straight into an invoice,
 * carrying its lines across at the quoted prices, then marks it CONVERTED.
 */
export async function convertQuotation(
  principal: Principal,
  id: string,
  opts: { toInvoice?: boolean } = {},
) {
  const companyId = principal.companyId!;
  const quotation = await db.quotation.findFirst({
    where: { id, ...quoteScope(principal) },
    include: { lines: true },
  });
  if (!quotation) throw notFound("Quotation not found");
  if (quotation.status === "CONVERTED") throw conflict("This quotation has already been converted");
  if (!CONVERTIBLE.has(quotation.status)) throw conflict(`A ${quotation.status.toLowerCase()} quotation cannot be converted`);

  // Rebuild draft lines from the quoted lines so the quoted price is honoured.
  const lines: DraftLine[] = quotation.lines.map((l) => ({
    productId: l.productId,
    quantity: l.quantity,
    unitPriceCents: l.unitPriceCents,
    discountCents: l.discountCents,
    description: l.description ?? undefined,
  }));

  if (opts.toInvoice) {
    const invoice = await createInvoice({
      companyId,
      customerId: quotation.customerId,
      branchId: quotation.branchId,
      lines,
      channel: "CONSOLE",
      note: `From quotation ${quotation.number}`,
      createdById: principal.userId,
      issue: true,
    });
    await db.quotation.update({ where: { id }, data: { status: "CONVERTED" } });
    return { kind: "invoice" as const, id: invoice.id, number: invoice.number };
  }

  const order = await createSalesOrder({
    companyId,
    customerId: quotation.customerId,
    branchId: quotation.branchId,
    lines,
    channel: "CONSOLE",
    note: `From quotation ${quotation.number}`,
    createdById: principal.userId,
    quotationId: quotation.id,
    confirm: true,
  });
  await db.quotation.update({ where: { id }, data: { status: "CONVERTED" } });
  return { kind: "order" as const, id: order.id, number: order.number };
}
