import "server-only";

import { db } from "@/lib/db";
import { chargedLine, outstandingCents } from "@/lib/money";
import { basisPoints, type ReportRow } from "@/lib/report-engine";

import { bump, capped, ROW_LIMIT, userNames, within, type ReportContext, type ReportDefinition } from "./types";

const POSTED = { status: { notIn: ["DRAFT", "CANCELLED"] } };

/** One row per group of invoices: the shape of every "sales by X" report. */
async function salesBy(
  ctx: ReportContext,
  group: (inv: {
    branch: { name: string } | null;
    channel: string;
    createdById: string | null;
    customer: { name: string; code: string; territory: { name: string } | null };
  }) => { key: string; label: string; code?: string },
) {
  const invoices = await db.invoice.findMany({
    where: { companyId: ctx.companyId, ...POSTED, ...within(ctx, "issueDate") },
    select: {
      totalCents: true,
      taxCents: true,
      discountCents: true,
      paidCents: true,
      channel: true,
      createdById: true,
      branch: { select: { name: true } },
      customer: { select: { name: true, code: true, territory: { select: { name: true } } } },
    },
    take: ROW_LIMIT,
  });
  const { rows: kept, truncated } = capped(invoices);

  const rows = new Map<string, { label: string; code: string; invoices: number; netCents: number; vatCents: number; totalCents: number; paidCents: number; discountCents: number }>();
  for (const inv of kept) {
    const g = group(inv);
    const row = rows.get(g.key) ?? {
      label: g.label,
      code: g.code ?? "",
      invoices: 0,
      netCents: 0,
      vatCents: 0,
      totalCents: 0,
      paidCents: 0,
      discountCents: 0,
    };
    row.invoices += 1;
    row.netCents += inv.totalCents - inv.taxCents;
    row.vatCents += inv.taxCents;
    row.totalCents += inv.totalCents;
    row.paidCents += inv.paidCents;
    row.discountCents += inv.discountCents;
    rows.set(g.key, row);
  }
  return { rows: [...rows.values()], truncated };
}

const salesGroupColumns = (label: string): ReportDefinition["columns"] => [
  { key: "label", label },
  { key: "invoices", label: "Invoices", kind: "int", total: true },
  { key: "netCents", label: "Sales excl. VAT", kind: "money", total: true },
  { key: "vatCents", label: "VAT", kind: "money", total: true, hideBelow: "md" },
  { key: "totalCents", label: "Total", kind: "money", total: true },
  { key: "discountCents", label: "Discounts", kind: "money", total: true, hideBelow: "lg" },
  { key: "paidCents", label: "Collected", kind: "money", total: true, hideBelow: "md" },
];

const SALES = ["report:operational", "invoice:read"] as const;

export const salesReports: ReportDefinition[] = [
  {
    key: "sales-register",
    title: "Sales register",
    description: "Every invoice issued in the period with its customer, value and payment state.",
    group: "sales",
    module: "SALES_POS",
    permissions: [...SALES],
    usesPeriod: true,
    columns: [
      { key: "date", label: "Date", kind: "date" },
      { key: "number", label: "Invoice", kind: "mono", hrefKey: "printHref" },
      { key: "customer", label: "Customer" },
      { key: "channel", label: "Channel", kind: "status", hideBelow: "lg" },
      { key: "netCents", label: "Excl. VAT", kind: "money", total: true, hideBelow: "md" },
      { key: "vatCents", label: "VAT", kind: "money", total: true, hideBelow: "md" },
      { key: "totalCents", label: "Total", kind: "money", total: true },
      { key: "balanceCents", label: "Outstanding", kind: "money", total: true },
      { key: "status", label: "Status", kind: "status" },
    ],
    filters: [
      { key: "status", allLabel: "All statuses" },
      { key: "channel", allLabel: "All channels" },
    ],
    defaultSort: { key: "date", dir: "desc" },
    async run(ctx) {
      const invoices = await db.invoice.findMany({
        where: { companyId: ctx.companyId, ...POSTED, ...within(ctx, "issueDate") },
        select: {
          id: true,
          number: true,
          issueDate: true,
          channel: true,
          status: true,
          totalCents: true,
          taxCents: true,
          paidCents: true,
          customer: { select: { name: true } },
          creditNotes: { where: { status: { not: "CANCELLED" } }, select: { totalCents: true } },
        },
        take: ROW_LIMIT,
      });
      const { rows: kept, truncated } = capped(invoices);
      return {
        truncated,
        rows: kept.map((i) => ({
          date: i.issueDate,
          number: i.number,
          printHref: `/print/invoice/${i.id}`,
          customer: i.customer.name,
          channel: i.channel,
          netCents: i.totalCents - i.taxCents,
          vatCents: i.taxCents,
          totalCents: i.totalCents,
          balanceCents: outstandingCents({
            ...i,
            creditedCents: i.creditNotes.reduce((n, c) => n + c.totalCents, 0),
          }),
          status: i.status,
        })),
      };
    },
  },
  {
    key: "sales-by-product",
    title: "Sales by product",
    description: "Units and value sold per product, net of discounts and before VAT.",
    group: "sales",
    module: "SALES_POS",
    permissions: [...SALES],
    usesPeriod: true,
    columns: [
      { key: "sku", label: "SKU", kind: "mono" },
      { key: "product", label: "Product" },
      { key: "category", label: "Category", hideBelow: "lg" },
      { key: "quantity", label: "Units", kind: "int", total: true },
      { key: "discountCents", label: "Discounts", kind: "money", total: true, hideBelow: "md" },
      { key: "netCents", label: "Sales excl. VAT", kind: "money", total: true },
      { key: "vatCents", label: "VAT", kind: "money", total: true, hideBelow: "md" },
    ],
    filters: [{ key: "category", allLabel: "All categories" }],
    defaultSort: { key: "netCents", dir: "desc" },
    async run(ctx) {
      const lines = await db.invoiceLine.findMany({
        where: { invoice: { companyId: ctx.companyId, ...POSTED, ...within(ctx, "issueDate") } },
        select: {
          quantity: true,
          unitPriceCents: true,
          discountCents: true,
          taxRateBp: true,
          lineTotalCents: true,
          productId: true,
          product: { select: { sku: true, name: true, category: { select: { name: true } } } },
        },
        take: ROW_LIMIT,
      });
      const { rows: kept, truncated } = capped(lines);
      const rows = new Map<string, ReportRow & { quantity: number; netCents: number; vatCents: number; discountCents: number }>();
      for (const line of kept) {
        const parts = chargedLine(line);
        const row = rows.get(line.productId) ?? {
          sku: line.product.sku,
          product: line.product.name,
          category: line.product.category?.name ?? "",
          quantity: 0,
          netCents: 0,
          vatCents: 0,
          discountCents: 0,
        };
        row.quantity += line.quantity;
        row.netCents += parts.netCents;
        row.vatCents += parts.taxCents;
        row.discountCents += parts.discountCents;
        rows.set(line.productId, row);
      }
      return { rows: [...rows.values()], truncated };
    },
  },
  {
    key: "product-margin",
    title: "Product margin",
    description: "What each product earned after the actual cost of the units that left stock.",
    group: "sales",
    module: "SALES_POS",
    permissions: ["report:financial", "invoice:read"],
    usesPeriod: true,
    columns: [
      { key: "sku", label: "SKU", kind: "mono" },
      { key: "product", label: "Product" },
      { key: "quantity", label: "Units", kind: "int", total: true },
      { key: "netCents", label: "Sales excl. VAT", kind: "money", total: true },
      { key: "costCents", label: "Cost of sales", kind: "money", total: true },
      { key: "marginCents", label: "Margin", kind: "money", total: true },
      { key: "marginBp", label: "Margin %", kind: "pct" },
    ],
    defaultSort: { key: "marginCents", dir: "desc" },
    async run(ctx) {
      const [lines, movements] = await Promise.all([
        db.invoiceLine.findMany({
          where: { invoice: { companyId: ctx.companyId, ...POSTED, ...within(ctx, "issueDate") } },
          select: {
            quantity: true,
            unitPriceCents: true,
            discountCents: true,
            taxRateBp: true,
            lineTotalCents: true,
            productId: true,
            product: { select: { sku: true, name: true } },
          },
          take: ROW_LIMIT,
        }),
        // The movement carries the cost actually relieved, unlike the product's
        // current cost price, which may have changed since.
        db.stockMovement.findMany({
          where: { companyId: ctx.companyId, type: { in: ["SALE", "RETURN"] }, ...within(ctx, "createdAt") },
          select: { productId: true, quantity: true, unitCostCents: true },
        }),
      ]);
      const { rows: kept, truncated } = capped(lines);
      const cost = new Map<string, number>();
      for (const m of movements) bump(cost, m.productId, -m.quantity * m.unitCostCents);

      const rows = new Map<string, { sku: string; product: string; quantity: number; netCents: number }>();
      for (const line of kept) {
        const row = rows.get(line.productId) ?? { sku: line.product.sku, product: line.product.name, quantity: 0, netCents: 0 };
        row.quantity += line.quantity;
        row.netCents += chargedLine(line).netCents;
        rows.set(line.productId, row);
      }
      return {
        truncated,
        rows: [...rows.entries()].map(([productId, row]) => {
          const costCents = cost.get(productId) ?? 0;
          const marginCents = row.netCents - costCents;
          return { ...row, costCents, marginCents, marginBp: basisPoints(marginCents, row.netCents) };
        }),
      };
    },
  },
  {
    key: "sales-by-customer",
    title: "Sales by customer",
    description: "Who bought the most in the period, and how much of it has been collected.",
    group: "sales",
    module: "SALES_POS",
    permissions: [...SALES],
    usesPeriod: true,
    columns: salesGroupColumns("Customer"),
    defaultSort: { key: "netCents", dir: "desc" },
    run: (ctx) => salesBy(ctx, (i) => ({ key: i.customer.code, label: i.customer.name })),
  },
  {
    key: "sales-by-salesperson",
    title: "Sales by salesperson",
    description: "Invoiced value per person who raised the invoice.",
    group: "sales",
    module: "SALES_POS",
    permissions: [...SALES],
    usesPeriod: true,
    columns: salesGroupColumns("Salesperson"),
    defaultSort: { key: "netCents", dir: "desc" },
    async run(ctx) {
      const names = await userNames(ctx.companyId);
      return salesBy(ctx, (i) => ({
        key: i.createdById ?? "none",
        label: i.createdById ? names.get(i.createdById) ?? "Former user" : "Unattributed",
      }));
    },
  },
  {
    key: "sales-by-branch",
    title: "Sales by branch",
    description: "Invoiced value per branch.",
    group: "sales",
    module: "SALES_POS",
    permissions: [...SALES],
    usesPeriod: true,
    columns: salesGroupColumns("Branch"),
    defaultSort: { key: "netCents", dir: "desc" },
    run: (ctx) => salesBy(ctx, (i) => ({ key: i.branch?.name ?? "none", label: i.branch?.name ?? "No branch" })),
  },
  {
    key: "sales-by-territory",
    title: "Sales by territory",
    description: "Invoiced value per customer territory.",
    group: "sales",
    module: "SALES_POS",
    permissions: [...SALES],
    usesPeriod: true,
    columns: salesGroupColumns("Territory"),
    defaultSort: { key: "netCents", dir: "desc" },
    run: (ctx) =>
      salesBy(ctx, (i) => ({
        key: i.customer.territory?.name ?? "none",
        label: i.customer.territory?.name ?? "No territory",
      })),
  },
  {
    key: "sales-by-channel",
    title: "Sales by channel",
    description: "Where sales were captured: console, point of sale or field app.",
    group: "sales",
    module: "SALES_POS",
    permissions: [...SALES],
    usesPeriod: true,
    columns: salesGroupColumns("Channel"),
    defaultSort: { key: "netCents", dir: "desc" },
    run: (ctx) => salesBy(ctx, (i) => ({ key: i.channel, label: i.channel.replaceAll("_", " ").toLowerCase() })),
  },
  {
    key: "credit-note-register",
    title: "Returns and credit notes",
    description: "Every credit note, its reason and the invoice it corrects.",
    group: "sales",
    module: "SALES_POS",
    permissions: ["report:operational", "creditnote:read"],
    usesPeriod: true,
    columns: [
      { key: "date", label: "Date", kind: "date" },
      { key: "number", label: "Credit note", kind: "mono", hrefKey: "printHref" },
      { key: "invoice", label: "Invoice", kind: "mono", hideBelow: "md" },
      { key: "customer", label: "Customer" },
      { key: "reason", label: "Reason", hideBelow: "lg" },
      { key: "netCents", label: "Excl. VAT", kind: "money", total: true, hideBelow: "md" },
      { key: "vatCents", label: "VAT", kind: "money", total: true, hideBelow: "md" },
      { key: "totalCents", label: "Total", kind: "money", total: true },
      { key: "restocked", label: "Restocked", hideBelow: "lg" },
      { key: "status", label: "Status", kind: "status" },
    ],
    filters: [{ key: "status", allLabel: "All statuses" }],
    defaultSort: { key: "date", dir: "desc" },
    async run(ctx) {
      const notes = await db.creditNote.findMany({
        where: { companyId: ctx.companyId, status: { not: "DRAFT" }, ...within(ctx, "issueDate") },
        select: {
          id: true,
          number: true,
          issueDate: true,
          reason: true,
          status: true,
          totalCents: true,
          taxCents: true,
          restock: true,
          invoice: { select: { number: true } },
          customer: { select: { name: true } },
        },
        take: ROW_LIMIT,
      });
      const { rows: kept, truncated } = capped(notes);
      return {
        truncated,
        rows: kept.map((n) => ({
          date: n.issueDate,
          number: n.number,
          printHref: `/print/credit-note/${n.id}`,
          invoice: n.invoice.number,
          customer: n.customer.name,
          reason: n.reason,
          netCents: n.totalCents - n.taxCents,
          vatCents: n.taxCents,
          totalCents: n.totalCents,
          restocked: n.restock ? "Yes" : "No",
          status: n.status,
        })),
      };
    },
  },
  {
    key: "order-register",
    title: "Sales orders",
    description: "Orders taken in the period, from the console and the field, and where they stand.",
    group: "sales",
    module: "SALES_POS",
    permissions: ["report:operational", "order:read"],
    usesPeriod: true,
    columns: [
      { key: "date", label: "Date", kind: "date" },
      { key: "number", label: "Order", kind: "mono", hrefKey: "printHref" },
      { key: "customer", label: "Customer" },
      { key: "channel", label: "Channel", kind: "status", hideBelow: "md" },
      { key: "totalCents", label: "Total", kind: "money", total: true },
      { key: "invoiced", label: "Invoiced", hideBelow: "md" },
      { key: "status", label: "Status", kind: "status" },
    ],
    filters: [{ key: "status", allLabel: "All statuses" }, { key: "channel", allLabel: "All channels" }],
    defaultSort: { key: "date", dir: "desc" },
    async run(ctx) {
      const orders = await db.salesOrder.findMany({
        where: { companyId: ctx.companyId, ...within(ctx, "orderDate") },
        select: {
          id: true,
          number: true,
          orderDate: true,
          channel: true,
          status: true,
          totalCents: true,
          customer: { select: { name: true } },
          _count: { select: { invoices: true } },
        },
        take: ROW_LIMIT,
      });
      const { rows: kept, truncated } = capped(orders);
      return {
        truncated,
        rows: kept.map((o) => ({
          date: o.orderDate,
          number: o.number,
          printHref: `/print/order/${o.id}`,
          customer: o.customer.name,
          channel: o.channel,
          totalCents: o.totalCents,
          invoiced: o._count.invoices > 0 ? "Yes" : "No",
          status: o.status,
        })),
      };
    },
  },
  {
    key: "quotation-conversion",
    title: "Quotation conversion",
    description: "Quotations issued in the period and how many became orders.",
    group: "sales",
    module: "SALES_POS",
    permissions: ["report:operational", "quotation:read"],
    usesPeriod: true,
    columns: [
      { key: "date", label: "Date", kind: "date" },
      { key: "number", label: "Quotation", kind: "mono" },
      { key: "customer", label: "Customer" },
      { key: "validUntil", label: "Valid until", kind: "date", hideBelow: "md" },
      { key: "totalCents", label: "Value", kind: "money", total: true },
      { key: "converted", label: "Became an order" },
      { key: "status", label: "Status", kind: "status" },
    ],
    filters: [{ key: "status", allLabel: "All statuses" }, { key: "converted", allLabel: "Converted or not" }],
    defaultSort: { key: "date", dir: "desc" },
    async run(ctx) {
      const quotes = await db.quotation.findMany({
        where: { companyId: ctx.companyId, ...within(ctx, "issueDate") },
        select: {
          number: true,
          issueDate: true,
          validUntil: true,
          status: true,
          totalCents: true,
          customer: { select: { name: true } },
          _count: { select: { orders: true } },
        },
        take: ROW_LIMIT,
      });
      const { rows: kept, truncated } = capped(quotes);
      const converted = kept.filter((q) => q._count.orders > 0);
      return {
        truncated,
        rows: kept.map((q) => ({
          date: q.issueDate,
          number: q.number,
          customer: q.customer.name,
          validUntil: q.validUntil,
          totalCents: q.totalCents,
          converted: q._count.orders > 0 ? "Yes" : "No",
          status: q.status,
        })),
        summary: [
          { label: "Quotations", value: kept.length, kind: "int" },
          { label: "Converted", value: converted.length, kind: "int", tone: "success" },
          { label: "Conversion rate", value: basisPoints(converted.length, kept.length) ?? 0, kind: "pct" },
        ],
      };
    },
  },
  {
    key: "delivery-note-register",
    title: "Delivery notes",
    description: "What was sent out, who received it and what is still on the road.",
    group: "sales",
    module: "SALES_POS",
    permissions: ["report:operational", "delivery:read"],
    usesPeriod: true,
    columns: [
      { key: "date", label: "Issued", kind: "date" },
      { key: "number", label: "Delivery note", kind: "mono", hrefKey: "printHref" },
      { key: "customer", label: "Customer" },
      { key: "vehicle", label: "Vehicle", kind: "mono", hideBelow: "md" },
      { key: "deliveredAt", label: "Delivered", kind: "datetime", hideBelow: "md" },
      { key: "receivedBy", label: "Received by", hideBelow: "lg" },
      { key: "status", label: "Status", kind: "status" },
    ],
    filters: [{ key: "status", allLabel: "All statuses" }],
    defaultSort: { key: "date", dir: "desc" },
    async run(ctx) {
      const notes = await db.deliveryNote.findMany({
        where: { companyId: ctx.companyId, ...within(ctx, "issueDate") },
        select: {
          id: true,
          number: true,
          issueDate: true,
          deliveredAt: true,
          receivedByName: true,
          status: true,
          customer: { select: { name: true } },
          vehicle: { select: { plate: true } },
        },
        take: ROW_LIMIT,
      });
      const { rows: kept, truncated } = capped(notes);
      return {
        truncated,
        rows: kept.map((n) => ({
          date: n.issueDate,
          number: n.number,
          printHref: `/print/delivery-note/${n.id}`,
          customer: n.customer.name,
          vehicle: n.vehicle?.plate ?? "",
          deliveredAt: n.deliveredAt,
          receivedBy: n.receivedByName ?? "",
          status: n.status,
        })),
      };
    },
  },
];

const CUSTOMER = ["report:operational", "customer:read"] as const;

export const customerReports: ReportDefinition[] = [
  {
    key: "customer-list",
    title: "Customer list",
    description: "The whole book with type, territory, rep, credit terms and balance.",
    group: "customers",
    module: "CRM",
    permissions: [...CUSTOMER],
    usesPeriod: false,
    columns: [
      { key: "code", label: "Code", kind: "mono" },
      { key: "name", label: "Customer" },
      { key: "type", label: "Type", kind: "status", hideBelow: "md" },
      { key: "segment", label: "Segment", hideBelow: "lg" },
      { key: "territory", label: "Territory", hideBelow: "lg" },
      { key: "rep", label: "Rep", hideBelow: "lg" },
      { key: "phone", label: "Phone", hideBelow: "md" },
      { key: "pin", label: "KRA PIN", kind: "mono", hideBelow: "lg" },
      { key: "limitCents", label: "Credit limit", kind: "money", hideBelow: "md" },
      { key: "balanceCents", label: "Balance", kind: "money", total: true },
      { key: "status", label: "Status", kind: "status" },
    ],
    filters: [
      { key: "status", allLabel: "All statuses" },
      { key: "type", allLabel: "All types" },
      { key: "territory", allLabel: "All territories" },
    ],
    defaultSort: { key: "name", dir: "asc" },
    async run(ctx) {
      const customers = await db.customer.findMany({
        where: { companyId: ctx.companyId },
        select: {
          code: true,
          name: true,
          type: true,
          segment: true,
          phone: true,
          taxPin: true,
          creditLimitCents: true,
          balanceCents: true,
          status: true,
          territory: { select: { name: true } },
          assignedRep: { select: { name: true } },
        },
        take: ROW_LIMIT,
      });
      const { rows: kept, truncated } = capped(customers);
      return {
        truncated,
        rows: kept.map((c) => ({
          code: c.code,
          name: c.name,
          type: c.type,
          segment: c.segment,
          territory: c.territory?.name ?? "",
          rep: c.assignedRep?.name ?? "",
          phone: c.phone ?? "",
          pin: c.taxPin ?? "",
          limitCents: c.creditLimitCents,
          balanceCents: c.balanceCents,
          status: c.status,
        })),
      };
    },
  },
  {
    key: "new-customers",
    title: "New customers",
    description: "Customers added in the period and whether they have bought yet.",
    group: "customers",
    module: "CRM",
    permissions: [...CUSTOMER],
    usesPeriod: true,
    columns: [
      { key: "date", label: "Added", kind: "date" },
      { key: "code", label: "Code", kind: "mono", hideBelow: "md" },
      { key: "name", label: "Customer" },
      { key: "territory", label: "Territory", hideBelow: "md" },
      { key: "rep", label: "Rep", hideBelow: "md" },
      { key: "invoices", label: "Invoices", kind: "int", total: true },
    ],
    defaultSort: { key: "date", dir: "desc" },
    async run(ctx) {
      const customers = await db.customer.findMany({
        where: { companyId: ctx.companyId, ...within(ctx, "createdAt") },
        select: {
          code: true,
          name: true,
          createdAt: true,
          territory: { select: { name: true } },
          assignedRep: { select: { name: true } },
          _count: { select: { invoices: { where: POSTED } } },
        },
        take: ROW_LIMIT,
      });
      const { rows: kept, truncated } = capped(customers);
      return {
        truncated,
        rows: kept.map((c) => ({
          date: c.createdAt,
          code: c.code,
          name: c.name,
          territory: c.territory?.name ?? "",
          rep: c.assignedRep?.name ?? "",
          invoices: c._count.invoices,
        })),
      };
    },
  },
  {
    key: "dormant-customers",
    title: "Dormant customers",
    description: "Active customers with no invoice in the last 60 days, longest silent first.",
    group: "customers",
    module: "CRM",
    permissions: [...CUSTOMER],
    usesPeriod: false,
    columns: [
      { key: "code", label: "Code", kind: "mono", hideBelow: "md" },
      { key: "name", label: "Customer" },
      { key: "rep", label: "Rep", hideBelow: "md" },
      { key: "phone", label: "Phone", hideBelow: "md" },
      { key: "lastInvoice", label: "Last invoice", kind: "date" },
      { key: "days", label: "Days silent", kind: "int" },
      { key: "balanceCents", label: "Balance", kind: "money", total: true },
    ],
    defaultSort: { key: "days", dir: "desc" },
    async run(ctx) {
      const customers = await db.customer.findMany({
        where: { companyId: ctx.companyId, status: "ACTIVE" },
        select: {
          code: true,
          name: true,
          phone: true,
          balanceCents: true,
          createdAt: true,
          assignedRep: { select: { name: true } },
          invoices: { where: POSTED, select: { issueDate: true }, orderBy: { issueDate: "desc" }, take: 1 },
        },
        take: ROW_LIMIT,
      });
      const { rows: kept, truncated } = capped(customers);
      const rows: ReportRow[] = [];
      for (const c of kept) {
        const last = c.invoices[0]?.issueDate ?? null;
        const since = last ?? c.createdAt;
        const days = Math.floor((ctx.now.getTime() - since.getTime()) / 86_400_000);
        if (days < 60) continue;
        rows.push({
          code: c.code,
          name: c.name,
          rep: c.assignedRep?.name ?? "",
          phone: c.phone ?? "",
          lastInvoice: last,
          days,
          balanceCents: c.balanceCents,
        });
      }
      return { rows, truncated };
    },
  },
  {
    key: "credit-limit-breaches",
    title: "Credit limit exposure",
    description: "Customers at or above their credit limit, and how far over they are.",
    group: "customers",
    module: "CRM",
    permissions: [...CUSTOMER],
    usesPeriod: false,
    columns: [
      { key: "code", label: "Code", kind: "mono", hideBelow: "md" },
      { key: "name", label: "Customer" },
      { key: "rep", label: "Rep", hideBelow: "md" },
      { key: "limitCents", label: "Credit limit", kind: "money", total: true },
      { key: "balanceCents", label: "Balance", kind: "money", total: true },
      { key: "overCents", label: "Over by", kind: "money", total: true },
      { key: "usedBp", label: "Used", kind: "pct" },
    ],
    defaultSort: { key: "overCents", dir: "desc" },
    async run(ctx) {
      const customers = await db.customer.findMany({
        where: { companyId: ctx.companyId, creditLimitCents: { gt: 0 } },
        select: {
          code: true,
          name: true,
          creditLimitCents: true,
          balanceCents: true,
          assignedRep: { select: { name: true } },
        },
      });
      return {
        rows: customers
          .filter((c) => c.balanceCents >= c.creditLimitCents)
          .map((c) => ({
            code: c.code,
            name: c.name,
            rep: c.assignedRep?.name ?? "",
            limitCents: c.creditLimitCents,
            balanceCents: c.balanceCents,
            overCents: c.balanceCents - c.creditLimitCents,
            usedBp: basisPoints(c.balanceCents, c.creditLimitCents),
          })),
      };
    },
  },
];
