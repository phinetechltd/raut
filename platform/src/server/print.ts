import "server-only";

import QRCode from "qrcode";

import type {
  PrintBranch,
  PrintColumn,
  PrintCompany,
  PrintDoc,
  PrintRow,
  PrintTotal,
} from "@/components/print/print-document";
import { ETIMS_LABEL, humanStatus } from "@/components/print/print-document";
import { db } from "@/lib/db";
import { formatKES, outstandingCents } from "@/lib/money";
import { can, type Permission, type Principal } from "@/lib/rbac";

import { creditedByInvoice } from "./sales";

/**
 * Builders for every printable document.
 *
 * Each takes the principal rather than a company id so the tenant check and
 * the field rep's self-scope live here, next to the query, and the page that
 * renders the result cannot forget either. A builder returns `null` when the
 * record is absent, belongs to another company, or is outside the rep's own
 * data — the three are deliberately indistinguishable, so a print URL cannot
 * be used to probe for another tenant's document numbers.
 */

export const PRINT_TYPES = [
  "invoice",
  "credit-note",
  "receipt",
  "delivery-note",
  "order",
  "purchase-order",
  "grn",
  "statement",
  "route-sheet",
] as const;
export type PrintType = (typeof PRINT_TYPES)[number];

export const PRINT_PERMISSION: Record<PrintType, Permission> = {
  invoice: "invoice:read",
  "credit-note": "creditnote:read",
  receipt: "payment:read",
  "delivery-note": "delivery:read",
  order: "order:read",
  "purchase-order": "purchase:read",
  // There is no grn:read; the GRN is procurement paperwork and reads with it.
  grn: "purchase:read",
  statement: "invoice:read",
  "route-sheet": "route:read",
};

export function isPrintType(v: string): v is PrintType {
  return (PRINT_TYPES as readonly string[]).includes(v);
}

export interface PrintOptions {
  /** `?copy=1` — stamps DUPLICATE. */
  copy?: boolean;
  /** `?format=thermal` — 80 mm layout where the type supports it. */
  thermal?: boolean;
  /** `?prices=1` — delivery notes carry prices only when asked. */
  prices?: boolean;
  /** `?autoprint=1` */
  autoprint?: boolean;
  /** Statement period. */
  from?: Date | null;
  to?: Date | null;
}

// ── helpers ────────────────────────────────────────────────────────────

const money = (cents: number) => formatKES(cents, { decimals: true });

export function fmtDate(d: Date | null | undefined): string {
  if (!d) return "—";
  return d.toLocaleDateString("en-KE", { day: "2-digit", month: "short", year: "numeric" });
}

function fmtDateTime(d: Date | null | undefined): string {
  if (!d) return "—";
  return `${fmtDate(d)} ${d.toLocaleTimeString("en-KE", { hour: "2-digit", minute: "2-digit" })}`;
}

const pct = (bp: number) => `${bp / 100}%`;

async function companyHeader(companyId: string): Promise<PrintCompany> {
  const c = await db.company.findUniqueOrThrow({
    where: { id: companyId },
    select: { name: true, taxPin: true, address: true, phone: true, email: true, logoUrl: true },
  });
  return c;
}

async function branchBlock(branchId: string | null | undefined): Promise<PrintBranch | null> {
  if (!branchId) return null;
  const b = await db.branch.findUnique({
    where: { id: branchId },
    select: { name: true, address: true, phone: true },
  });
  return b ?? null;
}

/**
 * The QR as inline SVG. Rendered on the server rather than fetched from a
 * generator: the document has to print identically with no network, and a
 * QR that fails to load is an invoice that fails an inspection.
 */
async function qrSvg(url: string | null | undefined): Promise<string | null> {
  if (!url) return null;
  return QRCode.toString(url, { type: "svg", margin: 1, width: 132, errorCorrectionLevel: "M" });
}

const customerLines = (c: {
  taxPin?: string | null;
  address?: string | null;
  town?: string | null;
  phone?: string | null;
  email?: string | null;
}) => [
  c.taxPin ? `PIN ${c.taxPin}` : null,
  [c.address, c.town].filter(Boolean).join(", ") || null,
  [c.phone, c.email].filter(Boolean).join(" · ") || null,
];

const LINE_COLUMNS: PrintColumn[] = [
  { key: "n", header: "#", width: "6%", align: "right", numeric: true },
  { key: "item", header: "Item" },
  { key: "qty", header: "Qty", align: "right", numeric: true, width: "9%" },
  { key: "unit", header: "Unit price", align: "right", numeric: true, width: "15%" },
  { key: "vat", header: "VAT", align: "right", numeric: true, width: "8%" },
  { key: "total", header: "Total", align: "right", numeric: true, width: "16%" },
];

interface PricedLine {
  id: string;
  description: string;
  variantName?: string | null;
  quantity: number;
  unitPriceCents: number;
  discountCents?: number;
  taxRateBp: number;
  lineTotalCents: number;
  product?: { sku: string } | null;
}

const itemLabel = (l: { description: string; variantName?: string | null; product?: { sku: string } | null }) => {
  const sku = l.product?.sku ? `${l.product.sku}  ` : "";
  const variant = l.variantName && !l.description.includes(l.variantName) ? ` (${l.variantName})` : "";
  return `${sku}${l.description}${variant}`;
};

function pricedRows(lines: PricedLine[]): PrintRow[] {
  return lines.map((l, i) => ({
    key: l.id,
    cells: {
      n: i + 1,
      item: itemLabel(l) + (l.discountCents ? `  (less ${money(l.discountCents)})` : ""),
      qty: l.quantity,
      unit: money(l.unitPriceCents),
      vat: pct(l.taxRateBp),
      total: money(l.lineTotalCents),
    },
    thermal: {
      label: itemLabel(l),
      left: `${l.quantity} x ${money(l.unitPriceCents)}`,
      right: money(l.lineTotalCents),
    },
  }));
}

/** The self-scope a field rep carries on each document type. */
function selfScope(principal: Principal, field: string): Record<string, string> {
  return principal.role === "FIELD_REP" ? { [field]: principal.userId } : {};
}

function companyOf(principal: Principal): string | null {
  return principal.companyId;
}

// ── invoice ────────────────────────────────────────────────────────────

export async function buildInvoiceDoc(
  principal: Principal,
  id: string,
  opts: PrintOptions,
): Promise<PrintDoc | null> {
  const companyId = companyOf(principal);
  if (!companyId) return null;

  const invoice = await db.invoice.findFirst({
    where: { id, companyId, ...selfScope(principal, "createdById") },
    include: {
      customer: true,
      order: { select: { number: true } },
      lines: { include: { product: { select: { sku: true } } } },
      creditNotes: { where: { status: { not: "CANCELLED" } }, select: { totalCents: true } },
    },
  });
  if (!invoice) return null;

  const [company, branch, qr] = await Promise.all([
    companyHeader(companyId),
    branchBlock(invoice.branchId),
    invoice.etimsStatus === "ACCEPTED" ? qrSvg(invoice.etimsQrUrl) : Promise.resolve(null),
  ]);

  const credited = invoice.creditNotes.reduce((n, c) => n + c.totalCents, 0);
  const balance = outstandingCents({ ...invoice, creditedCents: credited });
  const accepted = invoice.etimsStatus === "ACCEPTED" && Boolean(invoice.etimsControlCode);

  const totals: PrintTotal[] = [
    { label: "Subtotal", value: money(invoice.subtotalCents) },
    ...(invoice.discountCents > 0 ? [{ label: "Discount", value: money(-invoice.discountCents) }] : []),
    { label: "VAT", value: money(invoice.taxCents) },
    { label: "Total", value: money(invoice.totalCents), strong: true },
    ...(credited > 0 ? [{ label: "Credited", value: money(-credited), muted: true }] : []),
    { label: "Paid", value: money(invoice.paidCents) },
    { label: "Balance", value: money(balance), strong: true },
  ];

  return {
    title: accepted ? "TAX INVOICE" : opts.thermal ? "SALES RECEIPT" : "INVOICE",
    number: invoice.number,
    status: humanStatus(invoice.status),
    meta: [
      { label: "Date", value: fmtDate(invoice.issueDate) },
      { label: "Due", value: invoice.dueDate ? fmtDate(invoice.dueDate) : "On receipt" },
      ...(invoice.order ? [{ label: "Order", value: invoice.order.number }] : []),
      { label: "KRA", value: ETIMS_LABEL[invoice.etimsStatus] ?? invoice.etimsStatus },
    ],
    company,
    branch,
    parties: [
      {
        label: "Billed to",
        name: invoice.customer.name,
        lines: customerLines(invoice.customer),
      },
    ],
    columns: LINE_COLUMNS,
    rows: pricedRows(invoice.lines),
    totals,
    etims: {
      kind: "invoice",
      status: invoice.etimsStatus,
      controlCode: invoice.etimsControlCode,
      invoiceNumber: invoice.etimsInvoiceNumber,
      serialNumber: invoice.etimsSerialNumber,
      qrSvg: qr,
      qrUrl: invoice.etimsQrUrl,
    },
    signatures: opts.thermal ? [] : [{ label: "Received by" }, { label: `For ${company.name}` }],
    notes: invoice.note,
    copy: Boolean(opts.copy),
    thermal: Boolean(opts.thermal),
    autoprint: Boolean(opts.autoprint),
  };
}

// ── credit note ────────────────────────────────────────────────────────

export async function buildCreditNoteDoc(
  principal: Principal,
  id: string,
  opts: PrintOptions,
): Promise<PrintDoc | null> {
  const companyId = companyOf(principal);
  if (!companyId) return null;

  const note = await db.creditNote.findFirst({
    where: { id, companyId },
    include: {
      customer: true,
      invoice: { select: { number: true, issueDate: true } },
      lines: { include: { product: { select: { sku: true } } } },
    },
  });
  if (!note) return null;

  const [company, qr] = await Promise.all([
    companyHeader(companyId),
    note.etimsStatus === "ACCEPTED" ? qrSvg(note.etimsQrUrl) : Promise.resolve(null),
  ]);
  const accepted = note.etimsStatus === "ACCEPTED" && Boolean(note.etimsControlCode);

  return {
    title: accepted ? "CREDIT NOTE" : "RETURN NOTE",
    subtitle: `Against invoice ${note.invoice.number}`,
    number: note.number,
    status: humanStatus(note.status),
    meta: [
      { label: "Date", value: fmtDate(note.issueDate) },
      { label: "Invoice date", value: fmtDate(note.invoice.issueDate) },
      { label: "Goods restocked", value: note.restock ? "Yes" : "No" },
      { label: "KRA", value: ETIMS_LABEL[note.etimsStatus] ?? note.etimsStatus },
    ],
    company,
    branch: null,
    parties: [{ label: "Credited to", name: note.customer.name, lines: customerLines(note.customer) }],
    columns: LINE_COLUMNS,
    rows: pricedRows(
      note.lines.map((l) => ({
        ...l,
        discountCents: 0,
      })),
    ),
    totals: [
      { label: "Subtotal", value: money(note.subtotalCents) },
      { label: "VAT", value: money(note.taxCents) },
      { label: "Credited", value: money(note.totalCents), strong: true },
    ],
    etims: {
      kind: "credit-note",
      status: note.etimsStatus,
      controlCode: note.etimsControlCode,
      invoiceNumber: note.etimsInvoiceNumber,
      serialNumber: note.etimsSerialNumber,
      qrSvg: qr,
      qrUrl: note.etimsQrUrl,
    },
    signatures: opts.thermal ? [] : [{ label: "Goods returned by" }, { label: `Received for ${company.name}` }],
    notes: `Reason: ${note.reason}`,
    copy: Boolean(opts.copy),
    thermal: Boolean(opts.thermal),
    autoprint: Boolean(opts.autoprint),
  };
}

// ── receipt (payment) ──────────────────────────────────────────────────

export async function buildReceiptDoc(
  principal: Principal,
  id: string,
  opts: PrintOptions,
): Promise<PrintDoc | null> {
  const companyId = companyOf(principal);
  if (!companyId) return null;

  const payment = await db.payment.findFirst({
    where: { id, companyId, ...selfScope(principal, "createdById") },
    include: {
      customer: true,
      allocations: {
        include: {
          invoice: {
            select: { id: true, number: true, issueDate: true, totalCents: true, paidCents: true, status: true },
          },
        },
      },
    },
  });
  if (!payment) return null;

  const [company, credited] = await Promise.all([
    companyHeader(companyId),
    creditedByInvoice(db, payment.allocations.map((a) => a.invoiceId)),
  ]);

  const allocated = payment.allocations.reduce((n, a) => n + a.amountCents, 0);
  const onAccount = payment.amountCents - allocated;

  const rows: PrintRow[] = payment.allocations.map((a, i) => {
    const owing = outstandingCents({ ...a.invoice, creditedCents: credited.get(a.invoiceId) ?? 0 });
    return {
      key: a.id,
      cells: {
        n: i + 1,
        invoice: a.invoice.number,
        date: fmtDate(a.invoice.issueDate),
        total: money(a.invoice.totalCents),
        paid: money(a.amountCents),
        owing: money(owing),
      },
      thermal: { label: `Invoice ${a.invoice.number}`, left: `owing ${money(owing)}`, right: money(a.amountCents) },
    };
  });

  return {
    title: "PAYMENT RECEIPT",
    number: payment.number,
    meta: [
      { label: "Date", value: fmtDateTime(payment.paidAt) },
      { label: "Method", value: humanStatus(payment.method) },
      ...(payment.reference ? [{ label: "Reference", value: payment.reference }] : []),
    ],
    company,
    branch: null,
    parties: [{ label: "Received from", name: payment.customer.name, lines: customerLines(payment.customer) }],
    columns: [
      { key: "n", header: "#", width: "6%", align: "right", numeric: true },
      { key: "invoice", header: "Invoice" },
      { key: "date", header: "Issued", width: "16%" },
      { key: "total", header: "Invoice total", align: "right", numeric: true, width: "18%" },
      { key: "paid", header: "This receipt", align: "right", numeric: true, width: "18%" },
      { key: "owing", header: "Still owing", align: "right", numeric: true, width: "18%" },
    ],
    rows,
    totals: [
      { label: "Amount received", value: money(payment.amountCents), strong: true },
      { label: "Applied to invoices", value: money(allocated) },
      ...(onAccount > 0 ? [{ label: "Left on account", value: money(onAccount) }] : []),
      { label: "Account balance now", value: money(payment.customer.balanceCents), strong: true },
    ],
    footnote:
      rows.length === 0
        ? "Not applied to a specific invoice; held on the customer's account."
        : "Still owing is the balance on each invoice after this receipt and any credit notes.",
    signatures: opts.thermal ? [] : [{ label: `Received for ${company.name}` }],
    notes: payment.note,
    copy: Boolean(opts.copy),
    thermal: Boolean(opts.thermal),
    autoprint: Boolean(opts.autoprint),
  };
}

// ── delivery note ──────────────────────────────────────────────────────

export async function buildDeliveryNoteDoc(
  principal: Principal,
  id: string,
  opts: PrintOptions,
): Promise<PrintDoc | null> {
  const companyId = companyOf(principal);
  if (!companyId) return null;

  const note = await db.deliveryNote.findFirst({
    where: {
      id,
      companyId,
      ...(principal.role === "FIELD_REP"
        ? { OR: [{ createdById: principal.userId }, { deliveredById: principal.userId }] }
        : {}),
    },
    include: {
      customer: true,
      invoice: { select: { number: true, issueDate: true } },
      order: { select: { number: true, orderDate: true } },
      location: { select: { name: true } },
      deliveredBy: { select: { name: true, phone: true } },
      vehicle: { select: { plate: true, make: true, model: true } },
      route: { select: { name: true } },
      lines: { include: { product: { select: { sku: true } } } },
    },
  });
  if (!note) return null;

  const [company, branch] = await Promise.all([companyHeader(companyId), branchBlock(note.branchId)]);

  // Prices live on the source lines, not the note. Looked up only when asked
  // for, so the default document a driver carries shows no money at all.
  const price = new Map<string, { unitPriceCents: number; taxRateBp: number }>();
  if (opts.prices) {
    const invoiceLineIds = note.lines.map((l) => l.invoiceLineId).filter((v): v is string => Boolean(v));
    const orderLineIds = note.lines.map((l) => l.orderLineId).filter((v): v is string => Boolean(v));
    const [il, ol] = await Promise.all([
      invoiceLineIds.length
        ? db.invoiceLine.findMany({ where: { id: { in: invoiceLineIds } }, select: { id: true, unitPriceCents: true, taxRateBp: true } })
        : [],
      orderLineIds.length
        ? db.salesOrderLine.findMany({ where: { id: { in: orderLineIds } }, select: { id: true, unitPriceCents: true, taxRateBp: true } })
        : [],
    ]);
    for (const l of [...il, ...ol]) price.set(l.id, l);
  }

  const anyReturned = note.lines.some((l) => l.returnedQty > 0) || note.status === "RETURNED";
  const columns: PrintColumn[] = [
    { key: "n", header: "#", width: "6%", align: "right", numeric: true },
    { key: "item", header: "Item" },
    { key: "ordered", header: "Ordered", align: "right", numeric: true, width: "10%" },
    { key: "delivered", header: "Delivered", align: "right", numeric: true, width: "10%" },
    ...(anyReturned ? [{ key: "returned", header: "Returned", align: "right" as const, numeric: true, width: "10%" }] : []),
    ...(opts.prices
      ? [
          { key: "unit", header: "Unit price", align: "right" as const, numeric: true, width: "14%" },
          { key: "value", header: "Value excl. VAT", align: "right" as const, numeric: true, width: "16%" },
        ]
      : []),
  ];

  let goodsValue = 0;
  const rows: PrintRow[] = note.lines.map((l, i) => {
    const p = price.get(l.invoiceLineId ?? l.orderLineId ?? "");
    const value = p ? (l.deliveredQty - l.returnedQty) * p.unitPriceCents : 0;
    goodsValue += value;
    return {
      key: l.id,
      cells: {
        n: i + 1,
        item: itemLabel(l) + (l.note ? `  — ${l.note}` : ""),
        ordered: l.orderedQty,
        delivered: l.deliveredQty,
        returned: l.returnedQty,
        unit: p ? money(p.unitPriceCents) : "—",
        value: p ? money(value) : "—",
      },
    };
  });

  const source = note.invoice
    ? `Invoice ${note.invoice.number}`
    : note.order
      ? `Order ${note.order.number}`
      : null;

  return {
    title: "DELIVERY NOTE",
    subtitle: source,
    number: note.number,
    status: humanStatus(note.status),
    meta: [
      { label: "Issued", value: fmtDate(note.issueDate) },
      ...(note.deliveredAt ? [{ label: "Delivered", value: fmtDateTime(note.deliveredAt) }] : []),
      ...(note.vehicle ? [{ label: "Vehicle", value: note.vehicle.plate }] : []),
      ...(note.route ? [{ label: "Route", value: note.route.name }] : []),
      ...(note.location ? [{ label: "From", value: note.location.name }] : []),
    ],
    company,
    branch,
    parties: [
      {
        label: "Deliver to",
        name: note.customer.name,
        lines: [
          note.deliveryAddress ?? [note.customer.address, note.customer.town].filter(Boolean).join(", "),
          note.customer.phone,
          note.customer.taxPin ? `PIN ${note.customer.taxPin}` : null,
        ],
      },
      ...(note.deliveredBy
        ? [
            {
              label: "Delivered by",
              name: note.deliveredBy.name,
              lines: [
                note.deliveredBy.phone,
                note.vehicle ? [note.vehicle.plate, note.vehicle.make, note.vehicle.model].filter(Boolean).join(" ") : null,
              ],
            },
          ]
        : []),
    ],
    columns,
    rows,
    totals: opts.prices ? [{ label: "Goods value excl. VAT", value: money(goodsValue), strong: true }] : [],
    footnote: opts.prices
      ? "Values are for reference; the amount owed is on the invoice. A delivery note is not a tax invoice."
      : "A delivery note records what was handed over. It is not a tax invoice and shows no prices.",
    signatures: [
      {
        label: "Received by",
        value: note.receivedByName,
        detail: [note.receivedByPhone, note.deliveredAt ? fmtDateTime(note.deliveredAt) : null].filter(Boolean).join(" · ") || null,
        image: note.receivedBySignature?.startsWith("data:") ? note.receivedBySignature : null,
      },
      { label: "Delivered by", value: note.deliveredBy?.name ?? null },
      { label: `For ${company.name}` },
    ],
    notes: note.notes,
    copy: Boolean(opts.copy),
    autoprint: Boolean(opts.autoprint),
  };
}

// ── order (proforma) ───────────────────────────────────────────────────

export async function buildOrderDoc(
  principal: Principal,
  id: string,
  opts: PrintOptions,
): Promise<PrintDoc | null> {
  const companyId = companyOf(principal);
  if (!companyId) return null;

  const order = await db.salesOrder.findFirst({
    where: { id, companyId, ...selfScope(principal, "createdById") },
    include: {
      customer: true,
      lines: { include: { product: { select: { sku: true } } } },
    },
  });
  if (!order) return null;

  const [company, branch] = await Promise.all([companyHeader(companyId), branchBlock(order.branchId)]);

  return {
    title: "PROFORMA INVOICE",
    subtitle: `Sales order ${order.number}`,
    number: order.number,
    status: humanStatus(order.status),
    meta: [
      { label: "Order date", value: fmtDate(order.orderDate) },
      { label: "Delivery", value: order.deliveryDate ? fmtDate(order.deliveryDate) : "To be agreed" },
      { label: "Channel", value: humanStatus(order.channel) },
    ],
    company,
    branch,
    parties: [{ label: "Bill to", name: order.customer.name, lines: customerLines(order.customer) }],
    columns: LINE_COLUMNS,
    rows: pricedRows(order.lines),
    totals: [
      { label: "Subtotal", value: money(order.subtotalCents) },
      ...(order.discountCents > 0 ? [{ label: "Discount", value: money(-order.discountCents) }] : []),
      { label: "VAT", value: money(order.taxCents) },
      { label: "Total", value: money(order.totalCents), strong: true },
    ],
    footnote:
      "Proforma: not a tax invoice and not a demand for payment. A tax invoice is issued when the goods are supplied.",
    signatures: [{ label: "Accepted by (customer)" }, { label: `For ${company.name}` }],
    notes: order.note,
    copy: Boolean(opts.copy),
    autoprint: Boolean(opts.autoprint),
  };
}

// ── purchase order ─────────────────────────────────────────────────────

export async function buildPurchaseOrderDoc(
  principal: Principal,
  id: string,
  opts: PrintOptions,
): Promise<PrintDoc | null> {
  const companyId = companyOf(principal);
  if (!companyId) return null;

  const po = await db.purchaseOrder.findFirst({
    where: { id, companyId },
    include: {
      supplier: true,
      branch: { select: { name: true, address: true, phone: true } },
      lines: { include: { product: { select: { sku: true } } } },
    },
  });
  if (!po) return null;

  const company = await companyHeader(companyId);
  const anyReceived = po.lines.some((l) => l.received > 0);

  return {
    title: "PURCHASE ORDER",
    number: po.number,
    status: humanStatus(po.status),
    meta: [
      { label: "Order date", value: fmtDate(po.orderDate) },
      { label: "Expected", value: po.expectedAt ? fmtDate(po.expectedAt) : "—" },
      { label: "Terms", value: `${po.supplier.paymentTermsDays} days` },
    ],
    company,
    branch: po.branch,
    parties: [
      {
        label: "Supplier",
        name: po.supplier.name,
        lines: [
          po.supplier.contactName,
          po.supplier.taxPin ? `PIN ${po.supplier.taxPin}` : null,
          po.supplier.address,
          [po.supplier.phone, po.supplier.email].filter(Boolean).join(" · ") || null,
        ],
      },
      {
        label: "Deliver to",
        name: po.branch?.name ?? company.name,
        lines: [po.branch?.address ?? company.address, po.branch?.phone ?? company.phone],
      },
    ],
    columns: [
      { key: "n", header: "#", width: "6%", align: "right", numeric: true },
      { key: "item", header: "Item" },
      { key: "qty", header: "Qty", align: "right", numeric: true, width: "9%" },
      ...(anyReceived ? [{ key: "received", header: "Received", align: "right" as const, numeric: true, width: "9%" }] : []),
      { key: "unit", header: "Unit cost", align: "right", numeric: true, width: "15%" },
      { key: "vat", header: "VAT", align: "right", numeric: true, width: "8%" },
      { key: "total", header: "Total", align: "right", numeric: true, width: "16%" },
    ],
    rows: po.lines.map((l, i) => ({
      key: l.id,
      cells: {
        n: i + 1,
        item: itemLabel(l),
        qty: l.quantity,
        received: l.received,
        unit: money(l.unitCostCents),
        vat: pct(l.taxRateBp),
        total: money(l.lineTotalCents),
      },
    })),
    totals: [
      { label: "Subtotal", value: money(po.subtotalCents) },
      { label: "VAT", value: money(po.taxCents) },
      { label: "Total", value: money(po.totalCents), strong: true },
    ],
    footnote: "Please quote this number on the delivery note and the invoice.",
    signatures: [{ label: `Authorised for ${company.name}` }, { label: "Supplier acknowledgement" }],
    notes: po.note,
    copy: Boolean(opts.copy),
    autoprint: Boolean(opts.autoprint),
  };
}

// ── goods received note ────────────────────────────────────────────────

export async function buildGrnDoc(
  principal: Principal,
  id: string,
  opts: PrintOptions,
): Promise<PrintDoc | null> {
  const companyId = companyOf(principal);
  if (!companyId) return null;

  const grn = await db.goodsReceipt.findFirst({
    where: { id, companyId },
    include: {
      supplier: true,
      po: { select: { number: true } },
      location: { select: { name: true } },
      lines: { include: { product: { select: { sku: true, name: true } } } },
    },
  });
  if (!grn) return null;

  const company = await companyHeader(companyId);
  const value = grn.lines.reduce((n, l) => n + l.quantity * l.unitCostCents, 0);

  return {
    title: "GOODS RECEIVED NOTE",
    subtitle: grn.po ? `Against ${grn.po.number}` : null,
    number: grn.number,
    status: humanStatus(grn.status),
    meta: [
      { label: "Received", value: fmtDate(grn.receivedAt) },
      { label: "Into", value: grn.location.name },
    ],
    company,
    branch: null,
    parties: [
      {
        label: "Supplier",
        name: grn.supplier.name,
        lines: [
          grn.supplier.contactName,
          grn.supplier.taxPin ? `PIN ${grn.supplier.taxPin}` : null,
          [grn.supplier.phone, grn.supplier.email].filter(Boolean).join(" · ") || null,
        ],
      },
    ],
    columns: [
      { key: "n", header: "#", width: "6%", align: "right", numeric: true },
      { key: "item", header: "Item" },
      { key: "qty", header: "Qty received", align: "right", numeric: true, width: "14%" },
      { key: "unit", header: "Unit cost", align: "right", numeric: true, width: "16%" },
      { key: "value", header: "Value", align: "right", numeric: true, width: "16%" },
    ],
    rows: grn.lines.map((l, i) => ({
      key: l.id,
      cells: {
        n: i + 1,
        item: `${l.product.sku}  ${l.product.name}`,
        qty: l.quantity,
        unit: money(l.unitCostCents),
        value: money(l.quantity * l.unitCostCents),
      },
    })),
    totals: [{ label: "Goods value", value: money(value), strong: true }],
    footnote:
      grn.status === "POSTED"
        ? "Posted: stock and the product cost basis have been updated from this receipt."
        : "Draft: stock moves when this receipt is posted.",
    signatures: [{ label: "Received by" }, { label: "Checked by" }, { label: "Supplier / driver" }],
    notes: grn.note,
    copy: Boolean(opts.copy),
    autoprint: Boolean(opts.autoprint),
  };
}

// ── statement of account ───────────────────────────────────────────────

const dayStart = (d: Date) => {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
};
const dayEnd = (d: Date) => new Date(dayStart(d).getTime() + 86_400_000 - 1);

/**
 * Every document on the customer's account in the period with a running
 * balance, opening from everything before it. The balance moves on exactly
 * the documents `recomputeCustomerBalance` sums — non-draft invoices in,
 * payments and uncancelled credit notes out — so the closing figure is the
 * customer's balance as the console shows it when the period ends today.
 */
export async function buildStatementDoc(
  principal: Principal,
  customerId: string,
  opts: PrintOptions,
): Promise<PrintDoc | null> {
  const companyId = companyOf(principal);
  if (!companyId) return null;

  const customer = await db.customer.findFirst({
    where: { id: customerId, companyId, ...selfScope(principal, "assignedRepId") },
  });
  if (!customer) return null;

  const to = dayEnd(opts.to ?? new Date());
  const from = dayStart(opts.from ?? new Date(to.getTime() - 89 * 86_400_000));

  const [company, invoices, payments, credits, openInvoices] = await Promise.all([
    companyHeader(companyId),
    db.invoice.findMany({
      where: { customerId, companyId, status: { not: "DRAFT" }, issueDate: { lte: to } },
      select: { id: true, number: true, issueDate: true, totalCents: true, dueDate: true },
      orderBy: { issueDate: "asc" },
    }),
    db.payment.findMany({
      where: { customerId, companyId, paidAt: { lte: to } },
      select: { id: true, number: true, paidAt: true, amountCents: true, method: true, reference: true },
      orderBy: { paidAt: "asc" },
    }),
    db.creditNote.findMany({
      where: { customerId, companyId, status: { not: "CANCELLED" }, issueDate: { lte: to } },
      select: { id: true, number: true, issueDate: true, totalCents: true, invoice: { select: { number: true } } },
      orderBy: { issueDate: "asc" },
    }),
    db.invoice.findMany({
      where: { customerId, companyId, status: { in: ["ISSUED", "PARTIALLY_PAID", "OVERDUE"] } },
      select: { id: true, number: true, issueDate: true, dueDate: true, totalCents: true, paidCents: true },
      orderBy: [{ dueDate: "asc" }, { issueDate: "asc" }],
    }),
  ]);

  type Entry = { at: Date; key: string; doc: string; detail: string; debit: number; credit: number };
  const entries: Entry[] = [
    ...invoices.map((i) => ({
      at: i.issueDate,
      key: `inv-${i.id}`,
      doc: `Invoice ${i.number}`,
      detail: i.dueDate ? `Due ${fmtDate(i.dueDate)}` : "Due on receipt",
      debit: i.totalCents,
      credit: 0,
    })),
    ...payments.map((p) => ({
      at: p.paidAt,
      key: `pay-${p.id}`,
      doc: `Payment ${p.number}`,
      detail: [humanStatus(p.method), p.reference].filter(Boolean).join(" · "),
      debit: 0,
      credit: p.amountCents,
    })),
    ...credits.map((c) => ({
      at: c.issueDate,
      key: `crn-${c.id}`,
      doc: `Credit note ${c.number}`,
      detail: `Against ${c.invoice.number}`,
      debit: 0,
      credit: c.totalCents,
    })),
  ].sort((a, b) => a.at.getTime() - b.at.getTime());

  let balance = 0;
  const before = entries.filter((e) => e.at < from);
  for (const e of before) balance += e.debit - e.credit;
  const opening = balance;

  const inPeriod = entries.filter((e) => e.at >= from);
  const rows: PrintRow[] = [
    {
      key: "opening",
      muted: true,
      cells: { date: fmtDate(from), doc: "Opening balance", detail: "Brought forward", debit: "", credit: "", balance: money(opening) },
    },
  ];
  let invoiced = 0;
  let paid = 0;
  let credited = 0;
  for (const e of inPeriod) {
    balance += e.debit - e.credit;
    invoiced += e.debit;
    if (e.key.startsWith("pay-")) paid += e.credit;
    else credited += e.credit;
    rows.push({
      key: e.key,
      cells: {
        date: fmtDate(e.at),
        doc: e.doc,
        detail: e.detail,
        debit: e.debit ? money(e.debit) : "",
        credit: e.credit ? money(e.credit) : "",
        balance: money(balance),
      },
    });
  }
  rows.push({
    key: "closing",
    strong: true,
    cells: { date: fmtDate(to), doc: "Closing balance", detail: "", debit: "", credit: "", balance: money(balance) },
  });

  const creditedOpen = await creditedByInvoice(db, openInvoices.map((i) => i.id));
  const open = openInvoices
    .map((i) => ({ i, owing: outstandingCents({ ...i, creditedCents: creditedOpen.get(i.id) ?? 0 }) }))
    .filter(({ owing }) => owing > 0);
  const openRows: PrintRow[] = open.map(({ i, owing }) => ({
    key: i.id,
    cells: {
      invoice: i.number,
      issued: fmtDate(i.issueDate),
      due: i.dueDate ? fmtDate(i.dueDate) : "On receipt",
      total: money(i.totalCents),
      paid: money(i.paidCents),
      credited: money(creditedOpen.get(i.id) ?? 0),
      owing: money(owing),
    },
  }));
  const totalOwing = open.reduce((n, { owing }) => n + owing, 0);

  return {
    title: "STATEMENT OF ACCOUNT",
    number: customer.code,
    meta: [
      { label: "Period", value: `${fmtDate(from)} – ${fmtDate(to)}` },
      { label: "Printed", value: fmtDate(new Date()) },
      { label: "Terms", value: customer.paymentTermsDays > 0 ? `${customer.paymentTermsDays} days` : "Cash" },
    ],
    company,
    branch: null,
    parties: [{ label: "Customer", name: customer.name, lines: customerLines(customer) }],
    columns: [
      { key: "date", header: "Date", width: "13%" },
      { key: "doc", header: "Document", width: "22%" },
      { key: "detail", header: "Details" },
      { key: "debit", header: "Debit", align: "right", numeric: true, width: "15%" },
      { key: "credit", header: "Credit", align: "right", numeric: true, width: "15%" },
      { key: "balance", header: "Balance", align: "right", numeric: true, width: "15%" },
    ],
    rows,
    totals: [
      { label: "Opening balance", value: money(opening) },
      { label: "Invoiced in period", value: money(invoiced) },
      { label: "Paid in period", value: money(-paid) },
      ...(credited > 0 ? [{ label: "Credited in period", value: money(-credited) }] : []),
      { label: "Closing balance", value: money(balance), strong: true },
    ],
    footnote:
      "A positive balance is owed to us; a negative balance is credit held on your account. Please quote invoice numbers when paying.",
    sections: [
      {
        title: "Unpaid invoices",
        description: "What is still owing on each open invoice today, after payments and credit notes.",
        columns: [
          { key: "invoice", header: "Invoice" },
          { key: "issued", header: "Issued", width: "14%" },
          { key: "due", header: "Due", width: "14%" },
          { key: "total", header: "Total", align: "right", numeric: true, width: "15%" },
          { key: "paid", header: "Paid", align: "right", numeric: true, width: "14%" },
          { key: "credited", header: "Credited", align: "right", numeric: true, width: "14%" },
          { key: "owing", header: "Owing", align: "right", numeric: true, width: "15%" },
        ],
        rows: openRows,
        totals: [{ label: "Total owing", value: money(totalOwing), strong: true }],
        empty: "No unpaid invoices",
      },
    ],
    signatures: [{ label: `Prepared for ${company.name}` }],
    copy: Boolean(opts.copy),
    autoprint: Boolean(opts.autoprint),
  };
}

// ── route sheet ────────────────────────────────────────────────────────

export async function buildRouteSheetDoc(
  principal: Principal,
  id: string,
  opts: PrintOptions,
): Promise<PrintDoc | null> {
  const companyId = companyOf(principal);
  if (!companyId) return null;

  const route = await db.route.findFirst({
    where: { id, companyId, ...selfScope(principal, "repId") },
    include: {
      rep: { select: { name: true, phone: true } },
      territory: { select: { name: true } },
      vehicle: { select: { plate: true, make: true, model: true, odometerKm: true } },
      stops: {
        include: {
          customer: { select: { name: true, code: true, address: true, town: true, phone: true, balanceCents: true } },
        },
        orderBy: { sequence: "asc" },
      },
    },
  });
  if (!route) return null;

  const company = await companyHeader(companyId);
  const km = (m: number | null | undefined) => (m == null ? "—" : `${(m / 1000).toFixed(1)} km`);
  const odo = (v: number | null | undefined) => (v == null ? "__________ km" : `${v.toLocaleString("en-KE")} km`);

  return {
    title: "ROUTE SHEET",
    subtitle: route.territory?.name ?? null,
    number: route.name,
    status: humanStatus(route.status),
    meta: [
      { label: "Date", value: fmtDate(route.routeDate) },
      { label: "Rep", value: route.rep.name },
      { label: "Vehicle", value: route.vehicle ? [route.vehicle.plate, route.vehicle.make, route.vehicle.model].filter(Boolean).join(" ") : "—" },
      { label: "Odometer out", value: odo(route.odometerStartKm) },
      { label: "Odometer in", value: odo(route.odometerEndKm) },
      { label: "Planned", value: `${route.stops.length} stops · ${km(route.totalDistanceM)} · ~${route.estimatedMin} min` },
    ],
    company,
    branch: null,
    parties: [
      { label: "Rep", name: route.rep.name, lines: [route.rep.phone] },
      ...(route.vehicle
        ? [{ label: "Vehicle", name: route.vehicle.plate, lines: [[route.vehicle.make, route.vehicle.model].filter(Boolean).join(" ") || null] }]
        : []),
    ],
    columns: [
      { key: "n", header: "#", width: "5%", align: "right", numeric: true },
      { key: "customer", header: "Customer" },
      { key: "where", header: "Address / phone", width: "22%" },
      { key: "owing", header: "Balance", align: "right", numeric: true, width: "12%" },
      { key: "delivered", header: "Delivered", width: "12%" },
      { key: "collected", header: "Collected (KES)", width: "13%" },
      { key: "signature", header: "Signature", width: "14%" },
    ],
    rows: route.stops.map((s) => ({
      key: s.id,
      cells: {
        n: s.sequence,
        customer: `${s.customer.name}  (${s.customer.code})${s.status !== "PENDING" ? `  · ${humanStatus(s.status)}` : ""}`,
        where: [[s.customer.address, s.customer.town].filter(Boolean).join(", "), s.customer.phone].filter(Boolean).join(" · ") || "—",
        owing: money(s.customer.balanceCents),
        delivered: " ",
        collected: " ",
        signature: " ",
      },
    })),
    footnote:
      "Fill in what was delivered and collected at each stop and have the customer sign. Hand this sheet in with the cash at the end of the day.",
    signatures: [{ label: "Rep", value: route.rep.name }, { label: "Cash received by" }, { label: "Supervisor" }],
    copy: Boolean(opts.copy),
    autoprint: Boolean(opts.autoprint),
  };
}

// ── dispatcher ─────────────────────────────────────────────────────────

/**
 * Resolves a print URL to its document, or null when the type is unknown, the
 * principal may not read that kind of document, or the record is not theirs.
 */
export async function buildPrintDoc(
  principal: Principal,
  type: string,
  id: string,
  opts: PrintOptions,
): Promise<PrintDoc | null> {
  if (!isPrintType(type)) return null;
  if (!can(principal, PRINT_PERMISSION[type])) return null;

  switch (type) {
    case "invoice":
      return buildInvoiceDoc(principal, id, opts);
    case "credit-note":
      return buildCreditNoteDoc(principal, id, opts);
    case "receipt":
      return buildReceiptDoc(principal, id, opts);
    case "delivery-note":
      return buildDeliveryNoteDoc(principal, id, opts);
    case "order":
      return buildOrderDoc(principal, id, opts);
    case "purchase-order":
      return buildPurchaseOrderDoc(principal, id, opts);
    case "grn":
      return buildGrnDoc(principal, id, opts);
    case "statement":
      return buildStatementDoc(principal, id, opts);
    case "route-sheet":
      return buildRouteSheetDoc(principal, id, opts);
  }
}
