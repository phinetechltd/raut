import "server-only";

import { db } from "@/lib/db";
import { chargedLine } from "@/lib/money";
import type { Permission } from "@/lib/rbac";
import { VAT_CLASS_LABELS, vatClass, type ReportRow, type VatClass } from "@/lib/report-engine";
import { profitAndLoss, vatSummary } from "@/server/reports";

import { capped, ROW_LIMIT, within, type ReportContext, type ReportDefinition } from "./types";

const FINANCIAL: Permission[] = ["report:financial"];

/**
 * Sales and credit notes in a period, by what actually reached the ledger.
 *
 * Selecting by journal entry and not by invoice status matters here: a fully
 * credited invoice is marked CANCELLED, but it and its credit note are both real
 * and both belong on the return. Filtering it out would keep the credit note and
 * lose the sale, understating output VAT.
 */
async function postedSalesDocuments(ctx: ReportContext) {
  const entries = await db.journalEntry.findMany({
    where: {
      companyId: ctx.companyId,
      refType: { in: ["Invoice", "CreditNote"] },
      sourceKind: { in: ["REVENUE", "CREDIT_NOTE"] },
      ...within(ctx, "date"),
    },
    select: { refId: true, sourceKind: true },
    take: ROW_LIMIT,
  });
  const { rows: kept, truncated } = capped(entries);
  const invoiceIds = kept.filter((e) => e.sourceKind === "REVENUE").map((e) => e.refId);
  const creditIds = kept.filter((e) => e.sourceKind === "CREDIT_NOTE").map((e) => e.refId);

  const product = { select: { etimsTaxTypeCode: true } };
  const [invoices, credits] = await Promise.all([
    db.invoice.findMany({
      where: { id: { in: invoiceIds }, companyId: ctx.companyId },
      select: {
        id: true,
        number: true,
        issueDate: true,
        totalCents: true,
        taxCents: true,
        etimsStatus: true,
        etimsInvoiceNumber: true,
        customer: { select: { name: true, taxPin: true } },
        lines: {
          select: {
            quantity: true,
            unitPriceCents: true,
            discountCents: true,
            taxRateBp: true,
            lineTotalCents: true,
            product,
          },
        },
      },
    }),
    db.creditNote.findMany({
      where: { id: { in: creditIds }, companyId: ctx.companyId },
      select: {
        id: true,
        number: true,
        issueDate: true,
        totalCents: true,
        taxCents: true,
        etimsStatus: true,
        etimsInvoiceNumber: true,
        invoice: { select: { number: true } },
        customer: { select: { name: true, taxPin: true } },
        lines: {
          select: { quantity: true, unitPriceCents: true, taxRateBp: true, lineTotalCents: true, product },
        },
      },
    }),
  ]);
  return { invoices, credits, truncated };
}

type ClassTotals = Record<VatClass, { net: number; vat: number }>;

const emptyClasses = (): ClassTotals => ({
  STANDARD: { net: 0, vat: 0 },
  REDUCED: { net: 0, vat: 0 },
  ZERO: { net: 0, vat: 0 },
  EXEMPT: { net: 0, vat: 0 },
});

function addLine(
  totals: ClassTotals,
  line: {
    quantity: number;
    unitPriceCents: number;
    discountCents?: number;
    taxRateBp: number;
    lineTotalCents: number;
    product: { etimsTaxTypeCode: string | null };
  },
): void {
  const parts = chargedLine({ ...line, discountCents: line.discountCents ?? 0 });
  const bucket = totals[vatClass(line.taxRateBp, line.product.etimsTaxTypeCode)];
  bucket.net += parts.netCents;
  bucket.vat += parts.taxCents;
}

export const taxReports: ReportDefinition[] = [
  {
    key: "vat-return",
    title: "VAT return workings",
    description: "Output and input VAT for the month, by rate, ready to transfer to the KRA VAT3 return.",
    group: "tax",
    module: "FINANCE",
    permissions: FINANCIAL,
    usesPeriod: true,
    defaultRange: "last-month",
    columns: [
      { key: "section", label: "Section" },
      { key: "line", label: "Item" },
      { key: "taxableCents", label: "Value excl. VAT", kind: "money" },
      { key: "vatCents", label: "VAT", kind: "money" },
    ],
    async run(ctx) {
      const period = { from: ctx.from ?? new Date(0), to: ctx.to ?? ctx.now };
      const { invoices, credits, truncated } = await postedSalesDocuments(ctx);

      const sales = emptyClasses();
      for (const inv of invoices) for (const line of inv.lines) addLine(sales, line);
      const returns = emptyClasses();
      for (const note of credits) for (const line of note.lines) addLine(returns, line);

      const bills = await db.supplierInvoice.findMany({
        where: { companyId: ctx.companyId, status: { not: "VOID" }, ...within(ctx, "issueDate") },
        select: { totalCents: true, taxCents: true },
      });
      const taxedBills = bills.filter((b) => b.taxCents > 0);
      const untaxedBills = bills.filter((b) => b.taxCents === 0);
      const billNet = (list: typeof bills) => list.reduce((n, b) => n + b.totalCents - b.taxCents, 0);
      const billVat = taxedBills.reduce((n, b) => n + b.taxCents, 0);

      const rows: ReportRow[] = [];
      for (const key of Object.keys(sales) as VatClass[]) {
        rows.push({ section: "Sales", line: VAT_CLASS_LABELS[key], taxableCents: sales[key].net, vatCents: sales[key].vat });
      }
      for (const key of Object.keys(returns) as VatClass[]) {
        if (returns[key].net === 0 && returns[key].vat === 0) continue;
        rows.push({
          section: "Less credit notes",
          line: VAT_CLASS_LABELS[key],
          taxableCents: -returns[key].net,
          vatCents: -returns[key].vat,
        });
      }
      rows.push(
        { section: "Purchases", line: "Bills with input VAT", taxableCents: billNet(taxedBills), vatCents: billVat },
        { section: "Purchases", line: "Bills without VAT", taxableCents: billNet(untaxedBills), vatCents: 0 },
      );

      const sum = (t: ClassTotals, field: "net" | "vat") =>
        Object.values(t).reduce((n, b) => n + b[field], 0);
      const output = sum(sales, "vat") - sum(returns, "vat");
      const ledger = await vatSummary(ctx.companyId, period);
      const payable = output - billVat;
      const outputAgrees = output === ledger.outputCents;
      const inputAgrees = billVat === ledger.inputCents;

      const notes: { tone: "info" | "warning" | "danger"; text: string }[] = [
        {
          tone: "info",
          text: "These are workings to prepare the return from. The return itself is filed by you on iTax.",
        },
      ];
      if (!outputAgrees || !inputAgrees) {
        notes.push({
          tone: "danger",
          text: `These figures differ from the ledger (output ${(ledger.outputCents / 100).toFixed(2)}, input ${(ledger.inputCents / 100).toFixed(2)}). Resolve this before filing.`,
        });
      }
      if (bills.length === 0) {
        notes.push({
          tone: "warning",
          text: "No supplier bills are entered for this period, so no input VAT is being claimed. Enter bills under Finance → Supplier bills before filing.",
        });
      }

      return {
        rows,
        truncated,
        summary: [
          { label: "Output VAT", value: output, kind: "money" },
          { label: "Input VAT", value: billVat, kind: "money" },
          {
            label: payable < 0 ? "VAT refundable" : "VAT payable",
            value: Math.abs(payable),
            kind: "money",
            tone: payable < 0 ? "success" : "warning",
          },
          {
            label: "Check against the ledger",
            value: outputAgrees && inputAgrees ? "Agrees" : "Differs",
            tone: outputAgrees && inputAgrees ? "success" : "danger",
          },
        ],
        notes,
      };
    },
  },
  {
    key: "vat-sales-register",
    title: "VAT sales register",
    description: "Every sale and credit note with the buyer's KRA PIN, the VAT3 sales schedule in spreadsheet form.",
    group: "tax",
    module: "FINANCE",
    permissions: FINANCIAL,
    usesPeriod: true,
    defaultRange: "last-month",
    columns: [
      { key: "date", label: "Date", kind: "date" },
      { key: "document", label: "Document", kind: "mono" },
      { key: "kind", label: "Type", kind: "status", hideBelow: "md" },
      { key: "customer", label: "Customer" },
      { key: "pin", label: "KRA PIN", kind: "mono" },
      { key: "standardCents", label: "16% value", kind: "money", total: true },
      { key: "otherCents", label: "8%, zero, exempt", kind: "money", total: true, hideBelow: "lg" },
      { key: "vatCents", label: "VAT", kind: "money", total: true },
      { key: "totalCents", label: "Total", kind: "money", total: true },
      { key: "etims", label: "eTIMS", kind: "status", hideBelow: "lg" },
      { key: "cuNumber", label: "CU invoice no.", kind: "mono", hideBelow: "lg" },
    ],
    filters: [
      { key: "kind", allLabel: "Sales and credit notes" },
      { key: "etims", allLabel: "Any eTIMS status" },
    ],
    defaultSort: { key: "date", dir: "asc" },
    async run(ctx) {
      const { invoices, credits, truncated } = await postedSalesDocuments(ctx);
      const toRow = (
        doc: (typeof invoices)[number] | (typeof credits)[number],
        kind: "SALE" | "CREDIT_NOTE",
      ) => {
        const totals = emptyClasses();
        for (const line of doc.lines) addLine(totals, line);
        const sign = kind === "SALE" ? 1 : -1;
        const other = totals.REDUCED.net + totals.ZERO.net + totals.EXEMPT.net;
        return {
          date: doc.issueDate,
          document: doc.number,
          kind,
          customer: doc.customer.name,
          pin: doc.customer.taxPin ?? "",
          standardCents: sign * totals.STANDARD.net,
          otherCents: sign * other,
          vatCents: sign * doc.taxCents,
          totalCents: sign * doc.totalCents,
          etims: doc.etimsStatus,
          cuNumber: doc.etimsInvoiceNumber ?? "",
        };
      };
      const rows = [...invoices.map((i) => toRow(i, "SALE")), ...credits.map((c) => toRow(c, "CREDIT_NOTE"))];
      const missingPin = rows.filter((r) => !r.pin && r.kind === "SALE").length;
      return {
        rows,
        truncated,
        summary: [
          { label: "Documents", value: rows.length, kind: "int" },
          {
            label: "Sales with no buyer PIN",
            value: missingPin,
            kind: "int",
            tone: missingPin > 0 ? "warning" : "success",
          },
        ],
      };
    },
  },
  {
    key: "vat-purchases-register",
    title: "VAT purchases register",
    description: "Every supplier bill with the supplier's KRA PIN and invoice number, the VAT3 purchases schedule.",
    group: "tax",
    module: "FINANCE",
    permissions: FINANCIAL,
    usesPeriod: true,
    defaultRange: "last-month",
    columns: [
      { key: "date", label: "Bill date", kind: "date" },
      { key: "supplierRef", label: "Supplier invoice", kind: "mono" },
      { key: "number", label: "Our ref", kind: "mono", hideBelow: "md" },
      { key: "supplier", label: "Supplier" },
      { key: "pin", label: "KRA PIN", kind: "mono" },
      { key: "taxableCents", label: "Value excl. VAT", kind: "money", total: true },
      { key: "vatCents", label: "Input VAT", kind: "money", total: true },
      { key: "totalCents", label: "Total", kind: "money", total: true },
    ],
    defaultSort: { key: "date", dir: "asc" },
    async run(ctx) {
      const bills = await db.supplierInvoice.findMany({
        where: { companyId: ctx.companyId, status: { not: "VOID" }, ...within(ctx, "issueDate") },
        select: {
          number: true,
          supplierRef: true,
          issueDate: true,
          totalCents: true,
          taxCents: true,
          supplier: { select: { name: true, taxPin: true } },
        },
        take: ROW_LIMIT,
      });
      const { rows: kept, truncated } = capped(bills);
      const rows = kept.map((b) => ({
        date: b.issueDate,
        supplierRef: b.supplierRef ?? "",
        number: b.number,
        supplier: b.supplier.name,
        pin: b.supplier.taxPin ?? "",
        taxableCents: b.totalCents - b.taxCents,
        vatCents: b.taxCents,
        totalCents: b.totalCents,
      }));
      const noPin = rows.filter((r) => !r.pin && r.vatCents > 0).length;
      return {
        rows,
        truncated,
        summary: [
          { label: "Bills", value: rows.length, kind: "int" },
          {
            label: "VAT bills with no supplier PIN",
            value: noPin,
            kind: "int",
            tone: noPin > 0 ? "danger" : "success",
            hint: noPin > 0 ? "KRA can disallow input VAT without a supplier PIN" : undefined,
          },
        ],
      };
    },
  },
  {
    key: "etims-filing",
    title: "eTIMS filing status",
    description: "Which invoices and credit notes KRA has accepted, which are waiting and which were rejected.",
    group: "tax",
    module: "ETIMS",
    permissions: ["report:operational", "etims:read"],
    usesPeriod: true,
    columns: [
      { key: "date", label: "Date", kind: "date" },
      { key: "document", label: "Document", kind: "mono" },
      { key: "kind", label: "Type", kind: "status", hideBelow: "md" },
      { key: "customer", label: "Customer" },
      { key: "totalCents", label: "Total", kind: "money", total: true },
      { key: "status", label: "eTIMS status", kind: "status" },
      { key: "cuNumber", label: "CU invoice no.", kind: "mono", hideBelow: "md" },
      { key: "submittedAt", label: "Filed", kind: "datetime", hideBelow: "lg" },
      { key: "error", label: "Problem", hideBelow: "lg" },
    ],
    filters: [
      { key: "status", allLabel: "All statuses" },
      { key: "kind", allLabel: "Sales and credit notes" },
    ],
    defaultSort: { key: "date", dir: "desc" },
    async run(ctx) {
      const select = {
        number: true,
        issueDate: true,
        totalCents: true,
        etimsStatus: true,
        etimsInvoiceNumber: true,
        etimsSubmittedAt: true,
        etimsError: true,
        customer: { select: { name: true } },
      } as const;
      const [invoices, credits] = await Promise.all([
        db.invoice.findMany({
          where: { companyId: ctx.companyId, status: { not: "DRAFT" }, ...within(ctx, "issueDate") },
          select: select,
          take: ROW_LIMIT,
        }),
        db.creditNote.findMany({
          where: { companyId: ctx.companyId, status: { not: "DRAFT" }, ...within(ctx, "issueDate") },
          select: select,
          take: ROW_LIMIT,
        }),
      ]);
      const toRow = (d: (typeof invoices)[number], kind: string) => ({
        date: d.issueDate,
        document: d.number,
        kind,
        customer: d.customer.name,
        totalCents: d.totalCents,
        status: d.etimsStatus,
        cuNumber: d.etimsInvoiceNumber ?? "",
        submittedAt: d.etimsSubmittedAt,
        error: d.etimsError ?? "",
      });
      const { rows, truncated } = capped([
        ...invoices.map((i) => toRow(i, "SALE")),
        ...credits.map((c) => toRow(c, "CREDIT_NOTE")),
      ]);
      const count = (status: string) => rows.filter((r) => r.status === status).length;
      const rejected = count("REJECTED");
      const waiting = count("QUEUED") + count("SUBMITTED");
      return {
        rows,
        truncated,
        summary: [
          { label: "Accepted by KRA", value: count("ACCEPTED"), kind: "int", tone: "success" },
          { label: "Waiting", value: waiting, kind: "int", tone: waiting > 0 ? "warning" : "neutral" },
          { label: "Rejected", value: rejected, kind: "int", tone: rejected > 0 ? "danger" : "neutral" },
          { label: "Not filed", value: count("NOT_APPLICABLE"), kind: "int" },
        ],
      };
    },
  },
  {
    key: "buyers-without-pin",
    title: "Customers without a KRA PIN",
    description: "Customers invoiced in the period with no PIN on file, largest first, for follow-up.",
    group: "tax",
    module: "FINANCE",
    permissions: FINANCIAL,
    usesPeriod: true,
    defaultRange: "ytd",
    columns: [
      { key: "code", label: "Code", kind: "mono" },
      { key: "customer", label: "Customer" },
      { key: "type", label: "Type", kind: "status", hideBelow: "md" },
      { key: "phone", label: "Phone", hideBelow: "md" },
      { key: "invoices", label: "Invoices", kind: "int", total: true },
      { key: "totalCents", label: "Invoiced", kind: "money", total: true },
    ],
    filters: [{ key: "type", allLabel: "All customer types" }],
    defaultSort: { key: "totalCents", dir: "desc" },
    async run(ctx) {
      const invoices = await db.invoice.findMany({
        where: {
          companyId: ctx.companyId,
          status: { notIn: ["DRAFT", "CANCELLED"] },
          customer: { OR: [{ taxPin: null }, { taxPin: "" }] },
          ...within(ctx, "issueDate"),
        },
        select: {
          totalCents: true,
          customer: { select: { id: true, code: true, name: true, type: true, phone: true } },
        },
      });
      const byCustomer = new Map<string, ReportRow & { invoices: number; totalCents: number }>();
      for (const inv of invoices) {
        const row = byCustomer.get(inv.customer.id) ?? {
          code: inv.customer.code,
          customer: inv.customer.name,
          type: inv.customer.type,
          phone: inv.customer.phone ?? "",
          invoices: 0,
          totalCents: 0,
        };
        row.invoices += 1;
        row.totalCents += inv.totalCents;
        byCustomer.set(inv.customer.id, row);
      }
      return { rows: [...byCustomer.values()] };
    },
  },
  {
    key: "tax-estimates",
    title: "Income tax and turnover tax estimate",
    description: "A planning estimate from the books: corporation tax on profit and turnover tax on sales.",
    group: "tax",
    module: "FINANCE",
    permissions: FINANCIAL,
    usesPeriod: true,
    defaultRange: "ytd",
    columns: [
      { key: "tax", label: "Tax" },
      { key: "basis", label: "Calculated on" },
      { key: "baseCents", label: "Amount", kind: "money" },
      { key: "rateBp", label: "Rate", kind: "pct" },
      { key: "taxCents", label: "Estimated tax", kind: "money" },
    ],
    async run(ctx) {
      const pl = await profitAndLoss(ctx.companyId, { from: ctx.from ?? new Date(0), to: ctx.to ?? ctx.now });
      const CORPORATION_TAX_BP = 3000;
      const TURNOVER_TAX_BP = 300;
      const profit = Math.max(0, pl.netProfit);
      const rows = [
        {
          tax: "Corporation tax",
          basis: "Accounting profit, before tax adjustments",
          baseCents: profit,
          rateBp: CORPORATION_TAX_BP,
          taxCents: Math.round((profit * CORPORATION_TAX_BP) / 10_000),
        },
        {
          tax: "Turnover tax",
          basis: "Sales, excluding VAT",
          baseCents: pl.revenueTotal,
          rateBp: TURNOVER_TAX_BP,
          taxCents: Math.round((pl.revenueTotal * TURNOVER_TAX_BP) / 10_000),
        },
      ];
      return {
        rows,
        notes: [
          {
            tone: "warning",
            text: "An estimate for planning, not a computation to file. A business pays one or the other depending on its registration, profit needs tax adjustments such as capital allowances and disallowed costs, and the rates shown should be confirmed with your tax adviser.",
          },
        ],
      };
    },
  },
];
