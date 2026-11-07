import "server-only";

import { db } from "@/lib/db";
import { basisPoints, type ReportRow } from "@/lib/report-engine";
import { tripSummary } from "@/lib/tracking";

import { bump, capped, ROW_LIMIT, selfRepId, userNames, within, type ReportDefinition } from "./types";

const STOCK = ["report:operational", "stock:read"] as const;

const locationSelect = {
  key: "location",
  allLabel: "All locations",
  load: async (companyId: string) =>
    (
      await db.stockLocation.findMany({
        where: { companyId },
        select: { id: true, name: true },
        orderBy: { name: "asc" },
      })
    ).map((l) => ({ value: l.id, label: l.name })),
};

export const inventoryReports: ReportDefinition[] = [
  {
    key: "stock-on-hand",
    title: "Stock on hand",
    description: "Quantity and value of every product at every location, at current cost.",
    group: "inventory",
    module: "INVENTORY",
    permissions: ["report:financial", "stock:read"],
    usesPeriod: false,
    columns: [
      { key: "sku", label: "SKU", kind: "mono" },
      { key: "product", label: "Product" },
      { key: "category", label: "Category", hideBelow: "lg" },
      { key: "location", label: "Location" },
      { key: "quantity", label: "On hand", kind: "int", total: true },
      { key: "reserved", label: "Reserved", kind: "int", total: true, hideBelow: "md" },
      { key: "unitCostCents", label: "Unit cost", kind: "money", hideBelow: "md" },
      { key: "valueCents", label: "Value", kind: "money", total: true },
    ],
    filters: [{ key: "location", allLabel: "All locations" }, { key: "category", allLabel: "All categories" }],
    defaultSort: { key: "product", dir: "asc" },
    async run(ctx) {
      const items = await db.stockItem.findMany({
        where: { companyId: ctx.companyId, quantity: { not: 0 }, product: { trackStock: true } },
        select: {
          quantity: true,
          reserved: true,
          location: { select: { name: true } },
          product: { select: { sku: true, name: true, costPriceCents: true, category: { select: { name: true } } } },
        },
        take: ROW_LIMIT,
      });
      const { rows: kept, truncated } = capped(items);
      return {
        truncated,
        rows: kept.map((i) => ({
          sku: i.product.sku,
          product: i.product.name,
          category: i.product.category?.name ?? "",
          location: i.location.name,
          quantity: i.quantity,
          reserved: i.reserved,
          unitCostCents: i.product.costPriceCents,
          valueCents: i.quantity * i.product.costPriceCents,
        })),
      };
    },
  },
  {
    key: "reorder-list",
    title: "Low stock and reorder list",
    description: "Products at or below their reorder level across all locations, and how many to buy.",
    group: "inventory",
    module: "INVENTORY",
    permissions: [...STOCK],
    usesPeriod: false,
    columns: [
      { key: "sku", label: "SKU", kind: "mono" },
      { key: "product", label: "Product" },
      { key: "category", label: "Category", hideBelow: "md" },
      { key: "onHand", label: "On hand", kind: "int" },
      { key: "reorderLevel", label: "Reorder level", kind: "int" },
      { key: "shortfall", label: "Shortfall", kind: "int", total: true },
    ],
    filters: [{ key: "category", allLabel: "All categories" }],
    defaultSort: { key: "shortfall", dir: "desc" },
    async run(ctx) {
      const products = await db.product.findMany({
        where: { companyId: ctx.companyId, active: true, trackStock: true, reorderLevel: { gt: 0 } },
        select: {
          id: true,
          sku: true,
          name: true,
          reorderLevel: true,
          category: { select: { name: true } },
        },
      });
      const grouped = await db.stockItem.groupBy({
        by: ["productId"],
        where: { companyId: ctx.companyId },
        _sum: { quantity: true },
      });
      const onHand = new Map(grouped.map((g) => [g.productId, g._sum.quantity ?? 0]));
      const rows: ReportRow[] = [];
      for (const p of products) {
        const quantity = onHand.get(p.id) ?? 0;
        if (quantity > p.reorderLevel) continue;
        rows.push({
          sku: p.sku,
          product: p.name,
          category: p.category?.name ?? "",
          onHand: quantity,
          reorderLevel: p.reorderLevel,
          shortfall: p.reorderLevel - quantity,
        });
      }
      return { rows };
    },
  },
  {
    key: "stock-movements",
    title: "Stock movements",
    description: "Every unit in and out: sales, purchases, transfers, adjustments and write-offs.",
    group: "inventory",
    module: "INVENTORY",
    permissions: [...STOCK],
    usesPeriod: true,
    columns: [
      { key: "date", label: "When", kind: "datetime" },
      { key: "sku", label: "SKU", kind: "mono", hideBelow: "md" },
      { key: "product", label: "Product" },
      { key: "location", label: "Location", hideBelow: "md" },
      { key: "type", label: "Type", kind: "status" },
      { key: "quantity", label: "Quantity", kind: "int" },
      { key: "balanceAfter", label: "Balance after", kind: "int", hideBelow: "md" },
      { key: "user", label: "By", hideBelow: "lg" },
      { key: "note", label: "Note", hideBelow: "lg" },
    ],
    filters: [{ key: "type", allLabel: "All movement types" }],
    selects: [locationSelect],
    defaultSort: { key: "date", dir: "desc" },
    async run(ctx) {
      const [names, movements] = await Promise.all([
        userNames(ctx.companyId),
        db.stockMovement.findMany({
          where: {
            companyId: ctx.companyId,
            ...within(ctx, "createdAt"),
            ...(ctx.params.s_location ? { locationId: ctx.params.s_location } : {}),
          },
          select: {
            type: true,
            quantity: true,
            balanceAfter: true,
            note: true,
            createdAt: true,
            createdById: true,
            product: { select: { sku: true, name: true } },
            location: { select: { name: true } },
          },
          orderBy: { createdAt: "desc" },
          take: ROW_LIMIT,
        }),
      ]);
      const { rows: kept, truncated } = capped(movements);
      return {
        truncated,
        rows: kept.map((m) => ({
          date: m.createdAt,
          sku: m.product.sku,
          product: m.product.name,
          location: m.location.name,
          type: m.type,
          quantity: m.quantity,
          balanceAfter: m.balanceAfter,
          user: m.createdById ? names.get(m.createdById) ?? "" : "",
          note: m.note ?? "",
        })),
      };
    },
  },
  {
    key: "stock-adjustments",
    title: "Stock adjustments and write-offs",
    description: "Stock counted up or down and written off, with its value and who did it.",
    group: "inventory",
    module: "INVENTORY",
    permissions: ["report:financial", "stock:read"],
    usesPeriod: true,
    columns: [
      { key: "date", label: "When", kind: "datetime" },
      { key: "product", label: "Product" },
      { key: "location", label: "Location", hideBelow: "md" },
      { key: "type", label: "Type", kind: "status" },
      { key: "quantity", label: "Quantity", kind: "int", total: true },
      { key: "valueCents", label: "Value", kind: "money", total: true },
      { key: "user", label: "By", hideBelow: "md" },
      { key: "note", label: "Reason", hideBelow: "lg" },
    ],
    filters: [{ key: "type", allLabel: "All types" }],
    defaultSort: { key: "date", dir: "desc" },
    async run(ctx) {
      const [names, movements] = await Promise.all([
        userNames(ctx.companyId),
        db.stockMovement.findMany({
          where: { companyId: ctx.companyId, type: { in: ["ADJUSTMENT", "WRITE_OFF"] }, ...within(ctx, "createdAt") },
          select: {
            type: true,
            quantity: true,
            unitCostCents: true,
            note: true,
            createdAt: true,
            createdById: true,
            product: { select: { name: true } },
            location: { select: { name: true } },
          },
          take: ROW_LIMIT,
        }),
      ]);
      const { rows: kept, truncated } = capped(movements);
      return {
        truncated,
        rows: kept.map((m) => ({
          date: m.createdAt,
          product: m.product.name,
          location: m.location.name,
          type: m.type,
          quantity: m.quantity,
          valueCents: m.quantity * m.unitCostCents,
          user: m.createdById ? names.get(m.createdById) ?? "" : "",
          note: m.note ?? "",
        })),
      };
    },
  },
  {
    key: "slow-moving-stock",
    title: "Slow-moving stock",
    description: "Stock on hand with no sale in the last 90 days, and the money tied up in it.",
    group: "inventory",
    module: "INVENTORY",
    permissions: ["report:financial", "stock:read"],
    usesPeriod: false,
    columns: [
      { key: "sku", label: "SKU", kind: "mono" },
      { key: "product", label: "Product" },
      { key: "onHand", label: "On hand", kind: "int", total: true },
      { key: "lastSale", label: "Last sale", kind: "date" },
      { key: "valueCents", label: "Value tied up", kind: "money", total: true },
    ],
    defaultSort: { key: "valueCents", dir: "desc" },
    async run(ctx) {
      const cutoff = new Date(ctx.now.getTime() - 90 * 86_400_000);
      const [items, lastSales] = await Promise.all([
        db.stockItem.groupBy({
          by: ["productId"],
          where: { companyId: ctx.companyId, quantity: { gt: 0 } },
          _sum: { quantity: true },
        }),
        db.stockMovement.groupBy({
          by: ["productId"],
          where: { companyId: ctx.companyId, type: "SALE" },
          _max: { createdAt: true },
        }),
      ]);
      const lastSale = new Map(lastSales.map((s) => [s.productId, s._max.createdAt]));
      const products = await db.product.findMany({
        where: { companyId: ctx.companyId, id: { in: items.map((i) => i.productId) }, trackStock: true },
        select: { id: true, sku: true, name: true, costPriceCents: true },
      });
      const quantity = new Map(items.map((i) => [i.productId, i._sum.quantity ?? 0]));
      const rows: ReportRow[] = [];
      for (const p of products) {
        const sold = lastSale.get(p.id) ?? null;
        if (sold && sold >= cutoff) continue;
        const onHand = quantity.get(p.id) ?? 0;
        rows.push({ sku: p.sku, product: p.name, onHand, lastSale: sold, valueCents: onHand * p.costPriceCents });
      }
      return { rows };
    },
  },
  {
    key: "transfer-register",
    title: "Stock transfers",
    description: "Stock moved between locations and what is still in transit.",
    group: "inventory",
    module: "INVENTORY",
    permissions: [...STOCK],
    usesPeriod: true,
    columns: [
      { key: "date", label: "Created", kind: "date" },
      { key: "number", label: "Transfer", kind: "mono" },
      { key: "from", label: "From" },
      { key: "to", label: "To" },
      { key: "lines", label: "Lines", kind: "int", hideBelow: "md" },
      { key: "dispatchedAt", label: "Dispatched", kind: "date", hideBelow: "md" },
      { key: "receivedAt", label: "Received", kind: "date", hideBelow: "md" },
      { key: "status", label: "Status", kind: "status" },
    ],
    filters: [{ key: "status", allLabel: "All statuses" }],
    defaultSort: { key: "date", dir: "desc" },
    async run(ctx) {
      const transfers = await db.stockTransfer.findMany({
        where: { companyId: ctx.companyId, ...within(ctx, "createdAt") },
        select: {
          number: true,
          createdAt: true,
          dispatchedAt: true,
          receivedAt: true,
          status: true,
          fromLocation: { select: { name: true } },
          toLocation: { select: { name: true } },
          _count: { select: { lines: true } },
        },
        take: ROW_LIMIT,
      });
      const { rows: kept, truncated } = capped(transfers);
      return {
        truncated,
        rows: kept.map((t) => ({
          date: t.createdAt,
          number: t.number,
          from: t.fromLocation.name,
          to: t.toLocation.name,
          lines: t._count.lines,
          dispatchedAt: t.dispatchedAt,
          receivedAt: t.receivedAt,
          status: t.status,
        })),
      };
    },
  },
];

const PURCHASING = ["report:operational", "purchase:read"] as const;

export const procurementReports: ReportDefinition[] = [
  {
    key: "purchase-order-register",
    title: "Purchase orders",
    description: "Orders placed in the period with what has arrived against each.",
    group: "procurement",
    module: "PROCUREMENT",
    permissions: [...PURCHASING],
    usesPeriod: true,
    columns: [
      { key: "date", label: "Date", kind: "date" },
      { key: "number", label: "Order", kind: "mono", hrefKey: "printHref" },
      { key: "supplier", label: "Supplier" },
      { key: "expectedAt", label: "Expected", kind: "date", hideBelow: "md" },
      { key: "ordered", label: "Units ordered", kind: "int", total: true, hideBelow: "md" },
      { key: "received", label: "Units received", kind: "int", total: true, hideBelow: "md" },
      { key: "totalCents", label: "Total", kind: "money", total: true },
      { key: "status", label: "Status", kind: "status" },
    ],
    filters: [{ key: "status", allLabel: "All statuses" }],
    defaultSort: { key: "date", dir: "desc" },
    async run(ctx) {
      const orders = await db.purchaseOrder.findMany({
        where: { companyId: ctx.companyId, ...within(ctx, "orderDate") },
        select: {
          id: true,
          number: true,
          orderDate: true,
          expectedAt: true,
          totalCents: true,
          status: true,
          supplier: { select: { name: true } },
          lines: { select: { quantity: true, received: true } },
        },
        take: ROW_LIMIT,
      });
      const { rows: kept, truncated } = capped(orders);
      return {
        truncated,
        rows: kept.map((o) => ({
          date: o.orderDate,
          number: o.number,
          printHref: `/print/purchase-order/${o.id}`,
          supplier: o.supplier.name,
          expectedAt: o.expectedAt,
          ordered: o.lines.reduce((n, l) => n + l.quantity, 0),
          received: o.lines.reduce((n, l) => n + l.received, 0),
          totalCents: o.totalCents,
          status: o.status,
        })),
      };
    },
  },
  {
    key: "outstanding-purchases",
    title: "Outstanding purchase lines",
    description: "Lines ordered but not fully received, and how late they are.",
    group: "procurement",
    module: "PROCUREMENT",
    permissions: [...PURCHASING],
    usesPeriod: false,
    columns: [
      { key: "order", label: "Order", kind: "mono" },
      { key: "supplier", label: "Supplier" },
      { key: "product", label: "Product" },
      { key: "ordered", label: "Ordered", kind: "int", hideBelow: "md" },
      { key: "received", label: "Received", kind: "int", hideBelow: "md" },
      { key: "outstanding", label: "Outstanding", kind: "int", total: true },
      { key: "expectedAt", label: "Expected", kind: "date" },
      { key: "daysLate", label: "Days late", kind: "int" },
    ],
    defaultSort: { key: "daysLate", dir: "desc" },
    async run(ctx) {
      const lines = await db.purchaseOrderLine.findMany({
        where: { po: { companyId: ctx.companyId, status: { notIn: ["DRAFT", "CANCELLED", "RECEIVED", "CLOSED"] } } },
        select: {
          description: true,
          quantity: true,
          received: true,
          po: { select: { number: true, expectedAt: true, supplier: { select: { name: true } } } },
        },
        take: ROW_LIMIT,
      });
      const { rows: kept, truncated } = capped(lines);
      const rows: ReportRow[] = [];
      for (const line of kept) {
        const outstanding = line.quantity - line.received;
        if (outstanding <= 0) continue;
        const expected = line.po.expectedAt;
        rows.push({
          order: line.po.number,
          supplier: line.po.supplier.name,
          product: line.description,
          ordered: line.quantity,
          received: line.received,
          outstanding,
          expectedAt: expected,
          daysLate: expected && expected < ctx.now ? Math.floor((ctx.now.getTime() - expected.getTime()) / 86_400_000) : 0,
        });
      }
      return { rows, truncated };
    },
  },
  {
    key: "goods-received-register",
    title: "Goods received",
    description: "Every goods receipt with its value, and whether a supplier bill has followed.",
    group: "procurement",
    module: "PROCUREMENT",
    permissions: [...PURCHASING],
    usesPeriod: true,
    columns: [
      { key: "date", label: "Received", kind: "date" },
      { key: "number", label: "GRN", kind: "mono", hrefKey: "printHref" },
      { key: "supplier", label: "Supplier" },
      { key: "order", label: "Order", kind: "mono", hideBelow: "md" },
      { key: "location", label: "Location", hideBelow: "md" },
      { key: "units", label: "Units", kind: "int", total: true },
      { key: "valueCents", label: "Value", kind: "money", total: true },
      { key: "status", label: "Status", kind: "status" },
    ],
    filters: [{ key: "status", allLabel: "All statuses" }, { key: "location", allLabel: "All locations" }],
    defaultSort: { key: "date", dir: "desc" },
    async run(ctx) {
      const receipts = await db.goodsReceipt.findMany({
        where: { companyId: ctx.companyId, ...within(ctx, "receivedAt") },
        select: {
          id: true,
          number: true,
          receivedAt: true,
          status: true,
          supplier: { select: { name: true } },
          po: { select: { number: true } },
          location: { select: { name: true } },
          lines: { select: { quantity: true, unitCostCents: true } },
        },
        take: ROW_LIMIT,
      });
      const { rows: kept, truncated } = capped(receipts);
      return {
        truncated,
        rows: kept.map((g) => ({
          date: g.receivedAt,
          number: g.number,
          printHref: `/print/grn/${g.id}`,
          supplier: g.supplier.name,
          order: g.po?.number ?? "",
          location: g.location.name,
          units: g.lines.reduce((n, l) => n + l.quantity, 0),
          valueCents: g.lines.reduce((n, l) => n + l.quantity * l.unitCostCents, 0),
          status: g.status,
        })),
      };
    },
  },
  {
    key: "supplier-spend",
    title: "Supplier spend",
    description: "Billed, paid and still owed per supplier for the period.",
    group: "procurement",
    module: "PROCUREMENT",
    permissions: ["report:financial", "purchase:read"],
    usesPeriod: true,
    defaultRange: "ytd",
    columns: [
      { key: "code", label: "Code", kind: "mono", hideBelow: "md" },
      { key: "supplier", label: "Supplier" },
      { key: "bills", label: "Bills", kind: "int", total: true },
      { key: "netCents", label: "Excl. VAT", kind: "money", total: true, hideBelow: "md" },
      { key: "vatCents", label: "Input VAT", kind: "money", total: true, hideBelow: "md" },
      { key: "totalCents", label: "Billed", kind: "money", total: true },
      { key: "paidCents", label: "Paid", kind: "money", total: true },
      { key: "owedCents", label: "Still owed", kind: "money", total: true },
    ],
    defaultSort: { key: "totalCents", dir: "desc" },
    async run(ctx) {
      const bills = await db.supplierInvoice.findMany({
        where: { companyId: ctx.companyId, status: { not: "VOID" }, ...within(ctx, "issueDate") },
        select: {
          totalCents: true,
          taxCents: true,
          paidCents: true,
          supplier: { select: { id: true, code: true, name: true } },
        },
        take: ROW_LIMIT,
      });
      const { rows: kept, truncated } = capped(bills);
      const rows = new Map<string, { code: string; supplier: string; bills: number; netCents: number; vatCents: number; totalCents: number; paidCents: number; owedCents: number }>();
      for (const bill of kept) {
        const row = rows.get(bill.supplier.id) ?? {
          code: bill.supplier.code,
          supplier: bill.supplier.name,
          bills: 0,
          netCents: 0,
          vatCents: 0,
          totalCents: 0,
          paidCents: 0,
          owedCents: 0,
        };
        row.bills += 1;
        row.netCents += bill.totalCents - bill.taxCents;
        row.vatCents += bill.taxCents;
        row.totalCents += bill.totalCents;
        row.paidCents += bill.paidCents;
        row.owedCents += bill.totalCents - bill.paidCents;
        rows.set(bill.supplier.id, row);
      }
      return { rows: [...rows.values()], truncated };
    },
  },
  {
    key: "supplier-payments",
    title: "Supplier payments",
    description: "Money paid to suppliers, from which account and against which bill.",
    group: "procurement",
    module: "PROCUREMENT",
    permissions: ["report:financial", "purchase:read"],
    usesPeriod: true,
    columns: [
      { key: "date", label: "Paid", kind: "date" },
      { key: "number", label: "Payment", kind: "mono" },
      { key: "supplier", label: "Supplier" },
      { key: "bill", label: "Bill", kind: "mono", hideBelow: "md" },
      { key: "account", label: "From", kind: "status", hideBelow: "md" },
      { key: "reference", label: "Reference", kind: "mono", hideBelow: "lg" },
      { key: "amountCents", label: "Amount", kind: "money", total: true },
    ],
    filters: [{ key: "account", allLabel: "Bank and cash" }],
    defaultSort: { key: "date", dir: "desc" },
    async run(ctx) {
      const payments = await db.supplierPayment.findMany({
        where: { companyId: ctx.companyId, ...within(ctx, "paidAt") },
        select: {
          number: true,
          paidAt: true,
          account: true,
          reference: true,
          amountCents: true,
          supplier: { select: { name: true } },
          bill: { select: { number: true } },
        },
        take: ROW_LIMIT,
      });
      const { rows: kept, truncated } = capped(payments);
      return {
        truncated,
        rows: kept.map((p) => ({
          date: p.paidAt,
          number: p.number,
          supplier: p.supplier.name,
          bill: p.bill.number,
          account: p.account,
          reference: p.reference ?? "",
          amountCents: p.amountCents,
        })),
      };
    },
  },
];

export const financeReports: ReportDefinition[] = [
  {
    key: "payments-register",
    title: "Payments received",
    description: "Every customer payment with its method, reference and who took it.",
    group: "finance",
    module: "FINANCE",
    permissions: ["report:operational", "payment:read"],
    usesPeriod: true,
    columns: [
      { key: "date", label: "Paid", kind: "date" },
      { key: "number", label: "Receipt", kind: "mono", hrefKey: "printHref" },
      { key: "customer", label: "Customer" },
      { key: "method", label: "Method", kind: "status" },
      { key: "reference", label: "Reference", kind: "mono", hideBelow: "md" },
      { key: "user", label: "Taken by", hideBelow: "lg" },
      { key: "amountCents", label: "Amount", kind: "money", total: true },
    ],
    filters: [{ key: "method", allLabel: "All methods" }],
    defaultSort: { key: "date", dir: "desc" },
    async run(ctx) {
      const [names, payments] = await Promise.all([
        userNames(ctx.companyId),
        db.payment.findMany({
          where: { companyId: ctx.companyId, ...within(ctx, "paidAt") },
          select: {
            id: true,
            number: true,
            paidAt: true,
            method: true,
            reference: true,
            amountCents: true,
            createdById: true,
            customer: { select: { name: true } },
          },
          take: ROW_LIMIT,
        }),
      ]);
      const { rows: kept, truncated } = capped(payments);
      return {
        truncated,
        rows: kept.map((p) => ({
          date: p.paidAt,
          number: p.number,
          printHref: `/print/receipt/${p.id}`,
          customer: p.customer.name,
          method: p.method,
          reference: p.reference ?? "",
          user: p.createdById ? names.get(p.createdById) ?? "" : "",
          amountCents: p.amountCents,
        })),
      };
    },
  },
  {
    key: "payments-by-method",
    title: "Collections by method",
    description: "Cash, M-Pesa, Paystack and bank collections side by side.",
    group: "finance",
    module: "FINANCE",
    permissions: ["report:operational", "payment:read"],
    usesPeriod: true,
    columns: [
      { key: "method", label: "Method", kind: "status" },
      { key: "payments", label: "Payments", kind: "int", total: true },
      { key: "amountCents", label: "Amount", kind: "money", total: true },
      { key: "shareBp", label: "Share", kind: "pct" },
    ],
    defaultSort: { key: "amountCents", dir: "desc" },
    async run(ctx) {
      const grouped = await db.payment.groupBy({
        by: ["method"],
        where: { companyId: ctx.companyId, ...within(ctx, "paidAt") },
        _sum: { amountCents: true },
        _count: true,
      });
      const total = grouped.reduce((n, g) => n + (g._sum.amountCents ?? 0), 0);
      return {
        rows: grouped.map((g) => ({
          method: g.method,
          payments: g._count,
          amountCents: g._sum.amountCents ?? 0,
          shareBp: basisPoints(g._sum.amountCents ?? 0, total),
        })),
      };
    },
  },
  {
    key: "gateway-collections",
    title: "Gateway reconciliation",
    description: "Every M-Pesa, Paystack and KCB attempt, whether it settled and the receipt it produced.",
    group: "finance",
    module: "FINANCE",
    permissions: ["report:financial", "payment:read"],
    usesPeriod: true,
    columns: [
      { key: "date", label: "Started", kind: "datetime" },
      { key: "provider", label: "Provider", kind: "status" },
      { key: "customer", label: "Customer" },
      { key: "receipt", label: "Provider receipt", kind: "mono", hideBelow: "md" },
      { key: "amountCents", label: "Amount", kind: "money" },
      { key: "settledCents", label: "Settled", kind: "money", total: true },
      { key: "status", label: "Status", kind: "status" },
      { key: "failure", label: "Failure", hideBelow: "lg" },
    ],
    filters: [{ key: "provider", allLabel: "All providers" }, { key: "status", allLabel: "All statuses" }],
    defaultSort: { key: "date", dir: "desc" },
    async run(ctx) {
      const intents = await db.paymentIntent.findMany({
        where: { companyId: ctx.companyId, ...within(ctx, "createdAt") },
        select: {
          createdAt: true,
          provider: true,
          amountCents: true,
          receiptRef: true,
          status: true,
          failureReason: true,
          paymentId: true,
          customer: { select: { name: true } },
        },
        take: ROW_LIMIT,
      });
      const { rows: kept, truncated } = capped(intents);
      const stuck = kept.filter((i) => ["PENDING", "SETTLING", "PROCESSING"].includes(i.status)).length;
      return {
        truncated,
        rows: kept.map((i) => ({
          date: i.createdAt,
          provider: i.provider,
          customer: i.customer.name,
          receipt: i.receiptRef ?? "",
          amountCents: i.amountCents,
          settledCents: i.paymentId ? i.amountCents : 0,
          status: i.status,
          failure: i.failureReason ?? "",
        })),
        summary: [
          { label: "Attempts", value: kept.length, kind: "int" },
          { label: "Settled", value: kept.filter((i) => i.paymentId).length, kind: "int", tone: "success" },
          { label: "Still in progress", value: stuck, kind: "int", tone: stuck > 0 ? "warning" : "neutral" },
        ],
      };
    },
  },
  {
    key: "expense-register",
    title: "Expense register",
    description: "Every expense claim with its category, claimant and approval state.",
    group: "finance",
    module: "FINANCE",
    permissions: ["report:operational", "expense:read"],
    usesPeriod: true,
    columns: [
      { key: "date", label: "Incurred", kind: "date" },
      { key: "number", label: "Expense", kind: "mono" },
      { key: "description", label: "Description" },
      { key: "category", label: "Category", hideBelow: "md" },
      { key: "claimant", label: "Claimant", hideBelow: "md" },
      { key: "method", label: "Paid by", kind: "status", hideBelow: "lg" },
      { key: "amountCents", label: "Amount", kind: "money", total: true },
      { key: "status", label: "Status", kind: "status" },
    ],
    filters: [{ key: "status", allLabel: "All statuses" }, { key: "category", allLabel: "All categories" }],
    defaultSort: { key: "date", dir: "desc" },
    async run(ctx) {
      const self = selfRepId(ctx);
      const expenses = await db.expense.findMany({
        where: { companyId: ctx.companyId, ...within(ctx, "incurredAt"), ...(self ? { userId: self } : {}) },
        select: {
          number: true,
          description: true,
          incurredAt: true,
          amountCents: true,
          paymentMethod: true,
          status: true,
          category: { select: { name: true } },
          user: { select: { name: true } },
        },
        take: ROW_LIMIT,
      });
      const { rows: kept, truncated } = capped(expenses);
      return {
        truncated,
        rows: kept.map((e) => ({
          date: e.incurredAt,
          number: e.number,
          description: e.description,
          category: e.category?.name ?? "Uncategorised",
          claimant: e.user?.name ?? "",
          method: e.paymentMethod,
          amountCents: e.amountCents,
          status: e.status,
        })),
      };
    },
  },
  {
    key: "expense-by-category",
    title: "Expenses by category",
    description: "Approved spending per category, and each category's share.",
    group: "finance",
    module: "FINANCE",
    permissions: ["report:operational", "expense:read"],
    usesPeriod: true,
    columns: [
      { key: "category", label: "Category" },
      { key: "claims", label: "Claims", kind: "int", total: true },
      { key: "amountCents", label: "Amount", kind: "money", total: true },
      { key: "shareBp", label: "Share", kind: "pct" },
    ],
    defaultSort: { key: "amountCents", dir: "desc" },
    async run(ctx) {
      const expenses = await db.expense.findMany({
        where: { companyId: ctx.companyId, status: { in: ["APPROVED", "PAID"] }, ...within(ctx, "incurredAt") },
        select: { amountCents: true, category: { select: { name: true } } },
        take: ROW_LIMIT,
      });
      const { rows: kept, truncated } = capped(expenses);
      const amount = new Map<string, number>();
      const claims = new Map<string, number>();
      for (const e of kept) {
        const name = e.category?.name ?? "Uncategorised";
        bump(amount, name, e.amountCents);
        bump(claims, name, 1);
      }
      const total = [...amount.values()].reduce((n, v) => n + v, 0);
      return {
        truncated,
        rows: [...amount.entries()].map(([category, amountCents]) => ({
          category,
          claims: claims.get(category) ?? 0,
          amountCents,
          shareBp: basisPoints(amountCents, total),
        })),
      };
    },
  },
];

export const fieldReports: ReportDefinition[] = [
  {
    key: "visit-log",
    title: "Visit log",
    description: "Every customer visit with check-in, time on site, outcome and geofence result.",
    group: "field",
    module: "FIELD_SALES",
    permissions: ["visit:read"],
    usesPeriod: true,
    columns: [
      { key: "date", label: "Scheduled", kind: "datetime" },
      { key: "rep", label: "Rep" },
      { key: "customer", label: "Customer" },
      { key: "purpose", label: "Purpose", kind: "status", hideBelow: "lg" },
      { key: "duration", label: "Minutes", kind: "int", hideBelow: "md" },
      { key: "verified", label: "In geofence", hideBelow: "md" },
      { key: "distance", label: "Metres off", kind: "int", hideBelow: "lg" },
      { key: "outcome", label: "Outcome", hideBelow: "lg" },
      { key: "status", label: "Status", kind: "status" },
    ],
    filters: [
      { key: "status", allLabel: "All statuses" },
      { key: "rep", allLabel: "All reps" },
      { key: "verified", allLabel: "Any geofence result" },
    ],
    defaultSort: { key: "date", dir: "desc" },
    async run(ctx) {
      const self = selfRepId(ctx);
      const visits = await db.visit.findMany({
        where: { companyId: ctx.companyId, ...within(ctx, "scheduledAt"), ...(self ? { repId: self } : {}) },
        select: {
          scheduledAt: true,
          purpose: true,
          status: true,
          durationMin: true,
          geofenceVerified: true,
          distanceFromCustomerM: true,
          outcome: true,
          rep: { select: { name: true } },
          customer: { select: { name: true } },
        },
        take: ROW_LIMIT,
      });
      const { rows: kept, truncated } = capped(visits);
      return {
        truncated,
        rows: kept.map((v) => ({
          date: v.scheduledAt,
          rep: v.rep.name,
          customer: v.customer.name,
          purpose: v.purpose,
          duration: v.durationMin,
          verified: v.geofenceVerified ? "Yes" : "No",
          distance: v.distanceFromCustomerM,
          outcome: v.outcome ?? "",
          status: v.status,
        })),
      };
    },
  },
  {
    key: "rep-performance",
    title: "Rep performance against target",
    description: "Visits, sales and collections per rep, measured against the targets set for the period.",
    group: "field",
    module: "FIELD_SALES",
    permissions: ["visit:read"],
    usesPeriod: true,
    columns: [
      { key: "rep", label: "Rep" },
      { key: "visits", label: "Visits done", kind: "int", total: true },
      { key: "targetVisits", label: "Visit target", kind: "int", total: true, hideBelow: "md" },
      { key: "salesCents", label: "Sales", kind: "money", total: true },
      { key: "targetSalesCents", label: "Sales target", kind: "money", total: true, hideBelow: "md" },
      { key: "salesBp", label: "Achieved", kind: "pct" },
      { key: "collectedCents", label: "Collected", kind: "money", total: true, hideBelow: "md" },
      { key: "targetCollectionCents", label: "Collection target", kind: "money", total: true, hideBelow: "lg" },
    ],
    defaultSort: { key: "salesCents", dir: "desc" },
    async run(ctx) {
      const self = selfRepId(ctx);
      const reps = await db.user.findMany({
        where: { companyId: ctx.companyId, role: "FIELD_REP", ...(self ? { id: self } : {}) },
        select: { id: true, name: true },
      });
      const repIds = reps.map((r) => r.id);
      const [visits, invoices, payments, targets] = await Promise.all([
        db.visit.groupBy({
          by: ["repId"],
          where: { companyId: ctx.companyId, repId: { in: repIds }, status: "COMPLETED", ...within(ctx, "scheduledAt") },
          _count: true,
        }),
        db.invoice.groupBy({
          by: ["createdById"],
          where: {
            companyId: ctx.companyId,
            createdById: { in: repIds },
            status: { notIn: ["DRAFT", "CANCELLED"] },
            ...within(ctx, "issueDate"),
          },
          _sum: { totalCents: true, taxCents: true },
        }),
        db.payment.groupBy({
          by: ["createdById"],
          where: { companyId: ctx.companyId, createdById: { in: repIds }, ...within(ctx, "paidAt") },
          _sum: { amountCents: true },
        }),
        db.salesTarget.findMany({
          where: {
            companyId: ctx.companyId,
            repId: { in: repIds },
            ...(ctx.to ? { periodStart: { lte: ctx.to } } : {}),
            ...(ctx.from ? { periodEnd: { gte: ctx.from } } : {}),
          },
          select: { repId: true, targetSalesCents: true, targetCollectionCents: true, targetVisits: true },
        }),
      ]);
      const visitsBy = new Map(visits.map((v) => [v.repId, v._count]));
      const salesBy = new Map(invoices.map((i) => [i.createdById, (i._sum.totalCents ?? 0) - (i._sum.taxCents ?? 0)]));
      const collectedBy = new Map(payments.map((p) => [p.createdById, p._sum.amountCents ?? 0]));
      const targetSales = new Map<string, number>();
      const targetCollect = new Map<string, number>();
      const targetVisits = new Map<string, number>();
      for (const t of targets) {
        if (!t.repId) continue;
        bump(targetSales, t.repId, t.targetSalesCents);
        bump(targetCollect, t.repId, t.targetCollectionCents);
        bump(targetVisits, t.repId, t.targetVisits);
      }
      return {
        rows: reps.map((r) => {
          const salesCents = salesBy.get(r.id) ?? 0;
          const target = targetSales.get(r.id) ?? 0;
          return {
            rep: r.name,
            visits: visitsBy.get(r.id) ?? 0,
            targetVisits: targetVisits.get(r.id) ?? 0,
            salesCents,
            targetSalesCents: target,
            salesBp: basisPoints(salesCents, target),
            collectedCents: collectedBy.get(r.id) ?? 0,
            targetCollectionCents: targetCollect.get(r.id) ?? 0,
          };
        }),
      };
    },
  },
  {
    key: "geofence-events",
    title: "Geofence events",
    description: "Territory entries, exits and check-ins flagged outside a customer's geofence.",
    group: "field",
    module: "GEOFENCING",
    permissions: ["geofence:read"],
    usesPeriod: true,
    columns: [
      { key: "date", label: "When", kind: "datetime" },
      { key: "user", label: "Rep" },
      { key: "type", label: "Event", kind: "status" },
      { key: "territory", label: "Territory", hideBelow: "md" },
      { key: "detail", label: "Detail", hideBelow: "lg" },
    ],
    filters: [{ key: "type", allLabel: "All events" }, { key: "user", allLabel: "All reps" }],
    defaultSort: { key: "date", dir: "desc" },
    async run(ctx) {
      const self = selfRepId(ctx);
      const events = await db.geofenceEvent.findMany({
        where: { companyId: ctx.companyId, ...within(ctx, "occurredAt"), ...(self ? { userId: self } : {}) },
        select: {
          occurredAt: true,
          type: true,
          detail: true,
          user: { select: { name: true } },
          territory: { select: { name: true } },
        },
        take: ROW_LIMIT,
      });
      const { rows: kept, truncated } = capped(events);
      return {
        truncated,
        rows: kept.map((e) => ({
          date: e.occurredAt,
          user: e.user.name,
          type: e.type,
          territory: e.territory?.name ?? "",
          detail: e.detail ?? "",
        })),
      };
    },
  },
];

export const routingReports: ReportDefinition[] = [
  {
    key: "route-performance",
    title: "Route performance",
    description: "Each route's stops completed and skipped, and its driven distance against the plan.",
    group: "routing",
    module: "ROUTING",
    permissions: ["route:read"],
    usesPeriod: true,
    columns: [
      { key: "date", label: "Date", kind: "date" },
      { key: "name", label: "Route" },
      { key: "rep", label: "Rep" },
      { key: "vehicle", label: "Vehicle", kind: "mono", hideBelow: "md" },
      { key: "stops", label: "Stops", kind: "int", total: true, hideBelow: "md" },
      { key: "done", label: "Done", kind: "int", total: true },
      { key: "skipped", label: "Skipped", kind: "int", total: true, hideBelow: "md" },
      { key: "plannedKm", label: "Planned km", kind: "decimal", total: true, hideBelow: "lg" },
      { key: "actualKm", label: "Driven km", kind: "decimal", total: true, hideBelow: "lg" },
      { key: "status", label: "Status", kind: "status" },
    ],
    filters: [{ key: "status", allLabel: "All statuses" }, { key: "rep", allLabel: "All reps" }],
    defaultSort: { key: "date", dir: "desc" },
    async run(ctx) {
      const self = selfRepId(ctx);
      const routes = await db.route.findMany({
        where: { companyId: ctx.companyId, ...within(ctx, "routeDate"), ...(self ? { repId: self } : {}) },
        select: {
          name: true,
          routeDate: true,
          status: true,
          totalDistanceM: true,
          actualDistanceM: true,
          rep: { select: { name: true } },
          vehicle: { select: { plate: true } },
          stops: { select: { status: true } },
        },
        take: ROW_LIMIT,
      });
      const { rows: kept, truncated } = capped(routes);
      return {
        truncated,
        rows: kept.map((r) => ({
          date: r.routeDate,
          name: r.name,
          rep: r.rep.name,
          vehicle: r.vehicle?.plate ?? "",
          stops: r.stops.length,
          done: r.stops.filter((s) => s.status === "DONE").length,
          skipped: r.stops.filter((s) => s.status === "SKIPPED").length,
          plannedKm: r.totalDistanceM / 1000,
          actualKm: r.actualDistanceM != null ? r.actualDistanceM / 1000 : null,
          status: r.status,
        })),
      };
    },
  },
  {
    key: "vehicle-utilisation",
    title: "Vehicle utilisation",
    description: "Distance, time moving and days out per vehicle, from its tracker or driver's phone.",
    group: "routing",
    module: "ROUTING",
    permissions: ["report:operational", "vehicle:track"],
    usesPeriod: true,
    columns: [
      { key: "plate", label: "Vehicle", kind: "mono", hrefKey: "trackHref" },
      { key: "name", label: "Make and model", hideBelow: "md" },
      { key: "days", label: "Days out", kind: "int", total: true },
      { key: "km", label: "Distance km", kind: "decimal", total: true },
      { key: "movingHours", label: "Hours moving", kind: "decimal", total: true, hideBelow: "md" },
      { key: "maxKmh", label: "Top speed km/h", kind: "int", hideBelow: "md" },
      { key: "source", label: "Source", kind: "status", hideBelow: "lg" },
    ],
    defaultSort: { key: "km", dir: "desc" },
    async run(ctx) {
      const vehicles = await db.vehicle.findMany({
        where: { companyId: ctx.companyId, active: true },
        select: { id: true, plate: true, make: true, model: true },
      });
      const rows = await Promise.all(
        vehicles.map(async (v) => {
          const hardware = await db.vehiclePosition.findMany({
            where: { companyId: ctx.companyId, vehicleId: v.id, ...within(ctx, "recordedAt") },
            select: { latitude: true, longitude: true, speedMps: true, accuracyM: true, recordedAt: true },
            orderBy: { recordedAt: "asc" },
            take: 200_000,
          });
          const phone = hardware.length
            ? []
            : await db.locationPing.findMany({
                where: { companyId: ctx.companyId, vehicleId: v.id, ...within(ctx, "recordedAt") },
                select: { latitude: true, longitude: true, speedMps: true, accuracyM: true, recordedAt: true },
                orderBy: { recordedAt: "asc" },
                take: 200_000,
              });
          const fixes = (hardware.length ? hardware : phone).filter((f) => f.accuracyM == null || f.accuracyM <= 100);

          const byDay = new Map<string, typeof fixes>();
          for (const fix of fixes) {
            const day = new Date(fix.recordedAt.getTime() + 3 * 3_600_000).toISOString().slice(0, 10);
            const list = byDay.get(day) ?? [];
            list.push(fix);
            byDay.set(day, list);
          }
          // By day, so an overnight gap between two parking spots is not counted
          // as a drive.
          let distanceM = 0;
          let movingS = 0;
          let maxKmh: number | null = null;
          for (const list of byDay.values()) {
            const trip = tripSummary(list.map((f) => ({ lat: f.latitude, lng: f.longitude, recordedAt: f.recordedAt, speedMps: f.speedMps })));
            distanceM += trip.distanceM;
            movingS += trip.movingS;
            if (trip.maxSpeedKmh != null) maxKmh = Math.max(maxKmh ?? 0, trip.maxSpeedKmh);
          }
          return {
            plate: v.plate,
            trackHref: `/app/tracking/${v.id}`,
            name: [v.make, v.model].filter(Boolean).join(" "),
            days: byDay.size,
            km: distanceM / 1000,
            movingHours: movingS / 3600,
            maxKmh,
            source: hardware.length ? "TRACKER" : phone.length ? "PHONE" : "",
          };
        }),
      );
      return { rows };
    },
  },
];

export const smsReports: ReportDefinition[] = [
  {
    key: "sms-log",
    title: "SMS log",
    description: "Every message sent, to whom, its delivery state and cost.",
    group: "sms",
    module: "SMS",
    permissions: ["report:operational", "sms:read"],
    usesPeriod: true,
    columns: [
      { key: "date", label: "Queued", kind: "datetime" },
      { key: "to", label: "To", kind: "mono" },
      { key: "customer", label: "Customer", hideBelow: "md" },
      { key: "template", label: "Template", hideBelow: "lg" },
      { key: "body", label: "Message", hideBelow: "lg" },
      { key: "costCents", label: "Cost", kind: "money", total: true },
      { key: "status", label: "Status", kind: "status" },
    ],
    filters: [{ key: "status", allLabel: "All statuses" }, { key: "template", allLabel: "All templates" }],
    defaultSort: { key: "date", dir: "desc" },
    async run(ctx) {
      const messages = await db.smsMessage.findMany({
        where: { companyId: ctx.companyId, ...within(ctx, "createdAt") },
        select: {
          createdAt: true,
          toPhone: true,
          body: true,
          status: true,
          templateKey: true,
          costCents: true,
          customer: { select: { name: true } },
        },
        take: ROW_LIMIT,
      });
      const { rows: kept, truncated } = capped(messages);
      const failed = kept.filter((m) => m.status === "FAILED").length;
      return {
        truncated,
        rows: kept.map((m) => ({
          date: m.createdAt,
          to: m.toPhone,
          customer: m.customer?.name ?? "",
          template: m.templateKey ?? "",
          body: m.body.length > 80 ? `${m.body.slice(0, 80)}…` : m.body,
          costCents: m.costCents,
          status: m.status,
        })),
        summary: [
          { label: "Messages", value: kept.length, kind: "int" },
          { label: "Failed", value: failed, kind: "int", tone: failed > 0 ? "danger" : "neutral" },
          { label: "Cost", value: kept.reduce((n, m) => n + m.costCents, 0), kind: "money" },
        ],
      };
    },
  },
];
