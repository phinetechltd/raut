/**
 * Seed for the Raut platform.
 *
 * Data mirrors the proposal's mockups so the running system looks like the
 * document it was sold from: the customers on page 7 (Nairobi Fresh Traders,
 * Coastal Retail Ltd, Rift Valley Distributors, Lakeview Stores, Eastlands
 * Wholesale) and the rep on page 9 (J. Mwangi) are the ones seeded here, with
 * real Kenyan coordinates so the maps and geofencing are exercisable.
 *
 * Two tenants are created: Zamar Solutions with every module, and a
 * second company on the core platform only — without it, nothing proves the
 * module gate actually gates anything.
 */

import { PrismaClient } from "@prisma/client";
import { MODULE_LIST } from "../src/lib/modules";
import bcrypt from "bcryptjs";

const db = new PrismaClient();

const PASSWORD = "Raut@2026";

// Derived from the catalogue rather than copied from it. The duplicate list
// this replaces silently withheld the eleventh module from every seeded
// company, because adding a module to the catalogue did not add it here.
const MODULE_PRICES: Record<string, number> = Object.fromEntries(
  MODULE_LIST.map((m) => [m.key, m.priceCents]),
);
const ALL_MODULES = MODULE_LIST.map((m) => m.key);

const SMS_TEMPLATES = [
  {
    key: "ORDER_CONFIRMATION",
    name: "Order confirmation",
    body: "Hi {{customer}}, we have received your order {{number}} for {{amount}}. Thank you for your business. {{company}}",
  },
  {
    key: "PAYMENT_RECEIPT",
    name: "Payment receipt",
    body: "Hi {{customer}}, we confirm payment of {{amount}} received on {{date}}. Your balance is now {{balance}}. {{company}}",
  },
  {
    key: "BALANCE_REMINDER",
    name: "Balance reminder",
    body: "Dear {{customer}}, your account balance of {{balance}} is due on {{date}}. Kindly arrange payment. {{company}}",
  },
  { key: "PROMOTION", name: "Promotion", body: "Hi {{customer}}, {{message}} {{company}}" },
  {
    key: "VISIT_REMINDER",
    name: "Visit reminder",
    body: "Hi {{customer}}, our rep {{rep}} will visit you on {{date}}. {{company}}",
  },
];

const DOC_TYPES: Array<[string, string]> = [
  ["INVOICE", "INV"], ["QUOTE", "QT"], ["ORDER", "SO"], ["PO", "PO"],
  ["GRN", "GRN"], ["PAYMENT", "PAY"], ["EXPENSE", "EXP"], ["TRANSFER", "TRF"],
  ["SUPPLIER_INVOICE", "SIN"], ["CUSTOMER", "CUS"], ["SUPPLIER", "SUP"],
];

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 86_400_000);
}

function daysAhead(n: number): Date {
  return new Date(Date.now() + n * 86_400_000);
}

async function main() {
  console.log("Resetting database…");
  // Order matters: children before parents. Companies cascade most of this,
  // but platform-level rows (users with no company, idempotency) do not.
  await db.idempotencyKey.deleteMany();
  await db.auditLog.deleteMany();
  await db.refreshToken.deleteMany();
  await db.device.deleteMany();
  await db.company.deleteMany();
  await db.user.deleteMany();

  const passwordHash = await bcrypt.hash(PASSWORD, 10);

  // ── platform ────────────────────────────────────────────────────────
  await db.user.create({
    data: {
      name: "Tari Africa Platform Admin",
      email: "admin@tariafrica.com",
      passwordHash,
      role: "SUPER_ADMIN",
      status: "ACTIVE",
      phone: "+254700000001",
    },
  });
  console.log("✓ Super admin");

  // ── Zamar Solutions: full platform ──────────────────────────────────
  const zamar = await db.company.create({
    data: {
      name: "Zamar Solutions Limited",
      slug: "zamar",
      taxPin: "P051234567X",
      email: "info@zamarsolutions.co.ke",
      phone: "+254711000000",
      address: "Enterprise Road, Industrial Area, Nairobi",
      currency: "KES",
      status: "ACTIVE",
      seatLimit: 50,
      latitude: -1.30326,
      longitude: 36.85107,
      activatedAt: daysAgo(120),
      createdAt: daysAgo(120),
    },
  });

  await db.companyModule.createMany({
    data: ALL_MODULES.map((moduleKey) => ({
      companyId: zamar.id,
      moduleKey,
      enabled: true,
      priceCents: MODULE_PRICES[moduleKey],
      activatedAt: daysAgo(120),
    })),
  });

  await db.documentCounter.createMany({
    data: DOC_TYPES.map(([docType, prefix]) => ({
      companyId: zamar.id,
      docType,
      prefix,
      nextValue: 1,
    })),
  });

  await db.smsTemplate.createMany({
    data: SMS_TEMPLATES.map((t) => ({ ...t, companyId: zamar.id })),
  });

  const [nairobiBranch, mombasaBranch] = await Promise.all([
    db.branch.create({
      data: {
        companyId: zamar.id, name: "Nairobi Head Office", code: "HQ",
        isPrimary: true, phone: "+254711000000",
        address: "Enterprise Road, Industrial Area",
        latitude: -1.30326, longitude: 36.85107,
      },
    }),
    db.branch.create({
      data: {
        companyId: zamar.id, name: "Mombasa Depot", code: "MSA",
        phone: "+254711000002", address: "Nyerere Avenue, Mombasa",
        latitude: -4.05466, longitude: 39.66359,
      },
    }),
  ]);

  const territories = await Promise.all([
    db.territory.create({
      data: {
        companyId: zamar.id, name: "Nairobi Central", code: "NBO-C", colour: "#2f83f7",
        centerLat: -1.28333, centerLng: 36.81667, radiusM: 12_000,
        // Rough ring around the Nairobi CBD and near-east.
        boundary: JSON.stringify([
          [-1.2200, 36.7600], [-1.2200, 36.9200],
          [-1.3400, 36.9200], [-1.3400, 36.7600],
        ]),
      },
    }),
    db.territory.create({
      data: {
        companyId: zamar.id, name: "Coast", code: "CST", colour: "#12b981",
        centerLat: -4.04350, centerLng: 39.66820, radiusM: 25_000,
      },
    }),
    db.territory.create({
      data: {
        companyId: zamar.id, name: "Rift Valley", code: "RV", colour: "#f59e0b",
        centerLat: -0.30310, centerLng: 36.08000, radiusM: 40_000,
      },
    }),
    db.territory.create({
      data: {
        companyId: zamar.id, name: "Western", code: "WST", colour: "#8b5cf6",
        centerLat: -0.09170, centerLng: 34.76796, radiusM: 40_000,
      },
    }),
  ]);
  const [nboT, coastT, riftT, westT] = territories;

  const users = await Promise.all([
    db.user.create({
      data: {
        companyId: zamar.id, branchId: nairobiBranch.id,
        name: "Grace Wanjiku", email: "admin@zamarsolutions.co.ke",
        phone: "+254711000010", passwordHash, role: "COMPANY_ADMIN",
      },
    }),
    db.user.create({
      data: {
        companyId: zamar.id, branchId: nairobiBranch.id,
        name: "Peter Kimani", email: "sales@zamarsolutions.co.ke",
        phone: "+254711000011", passwordHash, role: "SALES_MANAGER",
      },
    }),
    db.user.create({
      data: {
        companyId: zamar.id, branchId: nairobiBranch.id,
        name: "Alice Nyambura", email: "accounts@zamarsolutions.co.ke",
        phone: "+254711000012", passwordHash, role: "ACCOUNTANT",
      },
    }),
    db.user.create({
      data: {
        companyId: zamar.id, branchId: nairobiBranch.id,
        name: "Samuel Otieno", email: "stores@zamarsolutions.co.ke",
        phone: "+254711000013", passwordHash, role: "STOREKEEPER",
      },
    }),
    db.user.create({
      data: {
        companyId: zamar.id, branchId: mombasaBranch.id,
        name: "Fatuma Ali", email: "mombasa@zamarsolutions.co.ke",
        phone: "+254711000014", passwordHash, role: "BRANCH_MANAGER",
      },
    }),
    // The rep named on proposal page 9.
    db.user.create({
      data: {
        companyId: zamar.id, branchId: nairobiBranch.id,
        name: "James Mwangi", email: "rep@zamarsolutions.co.ke",
        phone: "+254711000015", passwordHash, role: "FIELD_REP",
      },
    }),
    db.user.create({
      data: {
        companyId: zamar.id, branchId: mombasaBranch.id,
        name: "Brian Omondi", email: "rep2@zamarsolutions.co.ke",
        phone: "+254711000016", passwordHash, role: "FIELD_REP",
      },
    }),
  ]);
  const [, salesManager, , storekeeper, , repJames, repBrian] = users;

  const [mainStore, msaStore, vanJames] = await Promise.all([
    db.stockLocation.create({
      data: {
        companyId: zamar.id, branchId: nairobiBranch.id,
        name: "Nairobi Main Store", code: "MAIN", type: "WAREHOUSE",
      },
    }),
    db.stockLocation.create({
      data: {
        companyId: zamar.id, branchId: mombasaBranch.id,
        name: "Mombasa Store", code: "MSA-ST", type: "WAREHOUSE",
      },
    }),
    db.stockLocation.create({
      data: {
        companyId: zamar.id, branchId: nairobiBranch.id,
        name: "Van KDG 445J — J. Mwangi", code: "VAN-01", type: "VAN",
        ownerUserId: repJames.id,
      },
    }),
  ]);

  const categories = await Promise.all([
    db.productCategory.create({ data: { companyId: zamar.id, name: "Cooking Oils & Fats", code: "OIL" } }),
    db.productCategory.create({ data: { companyId: zamar.id, name: "Grains & Cereals", code: "GRN" } }),
    db.productCategory.create({ data: { companyId: zamar.id, name: "Home Care", code: "HC" } }),
    db.productCategory.create({ data: { companyId: zamar.id, name: "Beverages", code: "BEV" } }),
  ]);
  const [oil, grain, homecare, bev] = categories;

  // Prices in cents. The three products on the proposal's invoice mockup
  // (p.7) are priced so the same line totals reproduce: 12 × 1,500 = 18,000;
  // 30 × 2,100 = 63,000; 8 × 1,200 = 9,600.
  const productSpecs = [
    { sku: "OIL-5L", name: "Cooking Oil 5L", unit: "CTN", cat: oil.id, sell: 1_500_00, cost: 1_240_00, reorder: 40 },
    { sku: "OIL-2L", name: "Cooking Oil 2L", unit: "CTN", cat: oil.id, sell: 680_00, cost: 545_00, reorder: 60 },
    { sku: "RICE-25", name: "Rice 25kg", unit: "BAG", cat: grain.id, sell: 2_100_00, cost: 1_820_00, reorder: 30 },
    { sku: "MAIZE-25", name: "Maize Flour 25kg", unit: "BAG", cat: grain.id, sell: 1_850_00, cost: 1_600_00, reorder: 30 },
    { sku: "SUGAR-50", name: "Sugar 50kg", unit: "BAG", cat: grain.id, sell: 6_400_00, cost: 5_900_00, reorder: 15 },
    { sku: "DET-10", name: "Detergent 10kg", unit: "CTN", cat: homecare.id, sell: 1_200_00, cost: 960_00, reorder: 25 },
    { sku: "SOAP-BAR", name: "Bar Soap 1kg (12s)", unit: "CTN", cat: homecare.id, sell: 1_080_00, cost: 880_00, reorder: 50 },
    { sku: "JUICE-1L", name: "Fruit Juice 1L (12s)", unit: "CTN", cat: bev.id, sell: 1_440_00, cost: 1_150_00, reorder: 35 },
    { sku: "WATER-500", name: "Drinking Water 500ml (24s)", unit: "CTN", cat: bev.id, sell: 420_00, cost: 310_00, reorder: 80 },
    { sku: "TEA-500", name: "Tea Leaves 500g (10s)", unit: "CTN", cat: bev.id, sell: 2_250_00, cost: 1_900_00, reorder: 20 },
  ];

  const products: Awaited<ReturnType<typeof db.product.create>>[] = [];
  for (const spec of productSpecs) {
    products.push(
      await db.product.create({
        data: {
          companyId: zamar.id, categoryId: spec.cat, sku: spec.sku, name: spec.name,
          unit: spec.unit, unitsPerPack: 12, sellPriceCents: spec.sell,
          costPriceCents: spec.cost, taxRateBp: 1600, reorderLevel: spec.reorder,
        },
      }),
    );
  }
  console.log(`✓ ${products.length} products`);

  // Opening stock. A couple of lines are deliberately left below reorder level
  // so the low-stock alert on the dashboard has something real to report.
  //
  // Every stock row gets its movement. Writing a StockItem on its own leaves
  // goods that no movement created: the quantity is real, the ledger never
  // hears about it, and the stock valuation report reports a variance against
  // account 1300 forever. The seed is also where people learn the shape of a
  // stock write, so it has to model the right one.
  const openStock = async (
    productId: string,
    costPriceCents: number,
    locationId: string,
    quantity: number,
  ) => {
    await db.stockItem.create({
      data: { companyId: zamar.id, productId, locationId, quantity },
    });
    await db.stockMovement.create({
      data: {
        companyId: zamar.id, productId, locationId,
        type: "OPENING", quantity, balanceAfter: quantity,
        unitCostCents: costPriceCents, note: "Opening balance",
        createdById: storekeeper.id, createdAt: daysAgo(110),
      },
    });
  };

  for (const [i, product] of products.entries()) {
    const cost = product.costPriceCents;
    await openStock(product.id, cost, mainStore.id, i === 4 ? 8 : i === 9 ? 12 : 120 + i * 25);
    await openStock(product.id, cost, msaStore.id, 40 + i * 8);
    if (i < 6) await openStock(product.id, cost, vanJames.id, 20 + i * 3);
  }
  console.log("✓ Opening stock");

  // eTIMS on, in sandbox. With no Digitax key stored the console adapter is
  // used, so the whole flow — registration, control code, QR on the printed
  // invoice, credit note — is demonstrable without a Digitax account. It will
  // never reach KRA in this state, which is the point.
  await db.etimsConfig.create({
    data: {
      companyId: zamar.id,
      enabled: true,
      environment: "SANDBOX",
      autoTransmit: true,
      activeFrom: daysAgo(1),
      defaultItemClassCode: "99010000",
      defaultItemTypeCode: "2",
      defaultTaxTypeCode: "B",
      defaultQuantityUnit: "U",
      defaultPackageUnit: "CT",
      defaultOriginNation: "KE",
    },
  });
  console.log("✓ eTIMS (sandbox, console adapter)");

  // Customers from the proposal mockups, with real coordinates.
  const customerSpecs = [
    { code: "CUS-0001", name: "Nairobi Fresh Traders", town: "Nairobi CBD", lat: -1.28472, lng: 36.82361, terr: nboT.id, rep: repJames.id, seg: "A", terms: 30, credit: 500_000_00, type: "WHOLESALE" },
    { code: "CUS-0002", name: "Coastal Retail Ltd", town: "Mombasa", lat: -4.05466, lng: 39.66359, terr: coastT.id, rep: repBrian.id, seg: "A", terms: 30, credit: 400_000_00, type: "WHOLESALE" },
    { code: "CUS-0003", name: "Rift Valley Distributors", town: "Nakuru", lat: -0.30310, lng: 36.08000, terr: riftT.id, rep: repJames.id, seg: "A", terms: 14, credit: 600_000_00, type: "DISTRIBUTOR" },
    { code: "CUS-0004", name: "Lakeview Stores", town: "Kisumu", lat: -0.09170, lng: 34.76796, terr: westT.id, rep: repJames.id, seg: "B", terms: 14, credit: 200_000_00, type: "RETAIL" },
    { code: "CUS-0005", name: "Eastlands Wholesale", town: "Nairobi East", lat: -1.28640, lng: 36.89150, terr: nboT.id, rep: repJames.id, seg: "A", terms: 30, credit: 750_000_00, type: "WHOLESALE" },
    { code: "CUS-0006", name: "Westlands Mini Mart", town: "Westlands", lat: -1.26730, lng: 36.80280, terr: nboT.id, rep: repJames.id, seg: "C", terms: 0, credit: 50_000_00, type: "RETAIL" },
    { code: "CUS-0007", name: "Karen Provision Store", town: "Karen", lat: -1.31930, lng: 36.70690, terr: nboT.id, rep: repJames.id, seg: "C", terms: 0, credit: 40_000_00, type: "RETAIL" },
    { code: "CUS-0008", name: "Thika Road Supermarket", town: "Kasarani", lat: -1.22030, lng: 36.89720, terr: nboT.id, rep: repJames.id, seg: "B", terms: 14, credit: 180_000_00, type: "RETAIL" },
    { code: "CUS-0009", name: "Nyali Beach Grocers", town: "Nyali", lat: -4.02620, lng: 39.70180, terr: coastT.id, rep: repBrian.id, seg: "B", terms: 14, credit: 150_000_00, type: "RETAIL" },
    { code: "CUS-0010", name: "Naivasha Trading Co", town: "Naivasha", lat: -0.71720, lng: 36.43060, terr: riftT.id, rep: repJames.id, seg: "B", terms: 14, credit: 220_000_00, type: "WHOLESALE" },
  ];

  const customers: Awaited<ReturnType<typeof db.customer.create>>[] = [];
  for (const [i, spec] of customerSpecs.entries()) {
    customers.push(
      await db.customer.create({
        data: {
          companyId: zamar.id,
          branchId: spec.terr === coastT.id ? mombasaBranch.id : nairobiBranch.id,
          territoryId: spec.terr, assignedRepId: spec.rep,
          code: spec.code, name: spec.name, type: spec.type, segment: spec.seg,
          phone: `+2547220000${String(i + 10).padStart(2, "0")}`,
          email: `${spec.name.toLowerCase().replace(/[^a-z]+/g, ".")}@example.co.ke`,
          town: spec.town, address: `${spec.town}, Kenya`,
          latitude: spec.lat, longitude: spec.lng, geofenceRadiusM: 150,
          creditLimitCents: spec.credit, paymentTermsDays: spec.terms,
          createdAt: daysAgo(100 - i * 3),
        },
      }),
    );
  }
  await db.documentCounter.update({
    where: { companyId_docType: { companyId: zamar.id, docType: "CUSTOMER" } },
    data: { nextValue: customers.length + 1 },
  });
  console.log(`✓ ${customers.length} customers`);

  await db.expenseCategory.createMany({
    data: [
      { companyId: zamar.id, name: "Fuel", code: "FUEL" },
      { companyId: zamar.id, name: "Airtime & Data", code: "AIRTIME" },
      { companyId: zamar.id, name: "Travel & Accommodation", code: "TRAVEL" },
      { companyId: zamar.id, name: "Vehicle Maintenance", code: "VEHICLE" },
      { companyId: zamar.id, name: "Miscellaneous", code: "MISC" },
    ],
  });

  const suppliers = await Promise.all([
    db.supplier.create({
      data: {
        companyId: zamar.id, code: "SUP-0001", name: "Bidco Africa Ltd",
        contactName: "Procurement Desk", phone: "+254733000001",
        email: "orders@bidco.example", paymentTermsDays: 30, taxPin: "P051111111A",
      },
    }),
    db.supplier.create({
      data: {
        companyId: zamar.id, code: "SUP-0002", name: "Mwea Rice Millers",
        contactName: "Sales Office", phone: "+254733000002",
        email: "sales@mwearice.example", paymentTermsDays: 14,
      },
    }),
    db.supplier.create({
      data: {
        companyId: zamar.id, code: "SUP-0003", name: "Kapa Home Care",
        contactName: "Distribution", phone: "+254733000003",
        email: "distribution@kapa.example", paymentTermsDays: 30,
      },
    }),
  ]);
  await db.documentCounter.update({
    where: { companyId_docType: { companyId: zamar.id, docType: "SUPPLIER" } },
    data: { nextValue: suppliers.length + 1 },
  });

  // ── trading history ─────────────────────────────────────────────────
  // Ninety days of invoices so the weekly chart, ageing buckets and top-customer
  // tables have a real shape rather than a single spike.
  let invoiceSeq = 1;
  let paymentSeq = 1;
  let orderSeq = 1;
  const rand = mulberry32(20260731);

  for (let day = 90; day >= 0; day--) {
    const invoicesToday = 1 + Math.floor(rand() * 3);

    for (let n = 0; n < invoicesToday; n++) {
      const customer = customers[Math.floor(rand() * customers.length)];
      const lineCount = 1 + Math.floor(rand() * 3);
      const chosen = new Set<number>();
      while (chosen.size < lineCount) chosen.add(Math.floor(rand() * products.length));

      const lines = [...chosen].map((idx) => {
        const product = products[idx];
        const quantity = 4 + Math.floor(rand() * 26);
        const gross = quantity * product.sellPriceCents;
        const tax = Math.round((gross * product.taxRateBp) / 10_000);
        return {
          productId: product.id, description: product.name, quantity,
          unitPriceCents: product.sellPriceCents, discountCents: 0,
          taxRateBp: product.taxRateBp, lineTotalCents: gross + tax,
        };
      });

      const subtotalCents = lines.reduce((s, l) => s + l.quantity * l.unitPriceCents, 0);
      const taxCents = lines.reduce(
        (s, l) => s + Math.round((l.quantity * l.unitPriceCents * l.taxRateBp) / 10_000), 0);
      const totalCents = subtotalCents + taxCents;

      const issueDate = daysAgo(day);
      const dueDate = customer.paymentTermsDays > 0
        ? new Date(issueDate.getTime() + customer.paymentTermsDays * 86_400_000)
        : issueDate;

      const isField = rand() > 0.55;

      const order = await db.salesOrder.create({
        data: {
          companyId: zamar.id, customerId: customer.id, branchId: nairobiBranch.id,
          number: `SO-${String(orderSeq++).padStart(4, "0")}`,
          status: "INVOICED", channel: isField ? "FIELD" : "CONSOLE",
          orderDate: issueDate, subtotalCents, taxCents, totalCents,
          createdById: isField ? repJames.id : salesManager.id,
          createdAt: issueDate, updatedAt: issueDate,
          lines: { create: lines.map(({ ...l }) => l) },
        },
      });

      const invoice = await db.invoice.create({
        data: {
          companyId: zamar.id, customerId: customer.id, branchId: nairobiBranch.id,
          locationId: isField ? vanJames.id : mainStore.id, orderId: order.id,
          number: `INV-${String(invoiceSeq++).padStart(4, "0")}`,
          status: "ISSUED", channel: isField ? "FIELD" : "CONSOLE",
          issueDate, dueDate, subtotalCents, taxCents, totalCents,
          createdById: isField ? repJames.id : salesManager.id,
          createdAt: issueDate, updatedAt: issueDate,
          lines: { create: lines },
        },
      });

      // Most older invoices are settled; recent ones stay open so the
      // receivables ageing report shows all five buckets populated.
      const settle = day > 35 ? rand() < 0.92 : rand() < 0.35;
      const partial = !settle && rand() < 0.35;

      if (settle || partial) {
        const amount = settle ? totalCents : Math.round(totalCents * (0.3 + rand() * 0.4));
        const paidAt = new Date(issueDate.getTime() + (2 + rand() * 20) * 86_400_000);
        if (paidAt <= new Date()) {
          const payment = await db.payment.create({
            data: {
              companyId: zamar.id, customerId: customer.id,
              number: `PAY-${String(paymentSeq++).padStart(4, "0")}`,
              amountCents: amount, method: rand() > 0.45 ? "MPESA" : "CASH",
              paidAt, createdById: isField ? repJames.id : salesManager.id,
              createdAt: paidAt, updatedAt: paidAt,
            },
          });
          await db.paymentAllocation.create({
            data: { paymentId: payment.id, invoiceId: invoice.id, amountCents: amount },
          });
          await db.invoice.update({
            where: { id: invoice.id },
            data: {
              paidCents: amount,
              status: amount >= totalCents ? "PAID" : dueDate < new Date() ? "OVERDUE" : "PARTIALLY_PAID",
            },
          });
        }
      } else if (dueDate < new Date()) {
        await db.invoice.update({ where: { id: invoice.id }, data: { status: "OVERDUE" } });
      }
    }
  }
  await db.documentCounter.updateMany({
    where: { companyId: zamar.id, docType: "INVOICE" }, data: { nextValue: invoiceSeq },
  });
  await db.documentCounter.updateMany({
    where: { companyId: zamar.id, docType: "PAYMENT" }, data: { nextValue: paymentSeq },
  });
  await db.documentCounter.updateMany({
    where: { companyId: zamar.id, docType: "ORDER" }, data: { nextValue: orderSeq },
  });
  console.log(`✓ ${invoiceSeq - 1} invoices, ${paymentSeq - 1} payments`);

  // Recompute customer balances from the ledger rather than tracking them
  // through the loop — this is also a check that the derived field agrees.
  for (const customer of customers) {
    const open = await db.invoice.findMany({
      where: { customerId: customer.id, status: { in: ["ISSUED", "PARTIALLY_PAID", "OVERDUE"] } },
      select: { totalCents: true, paidCents: true },
    });
    await db.customer.update({
      where: { id: customer.id },
      data: { balanceCents: open.reduce((s, i) => s + (i.totalCents - i.paidCents), 0) },
    });
  }

  // ── today's field operations (proposal p.9) ─────────────────────────
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const routeCustomers = [customers[0], customers[1], customers[2], customers[3], customers[4]];

  const route = await db.route.create({
    data: {
      companyId: zamar.id, repId: repJames.id, territoryId: nboT.id,
      name: "Today's Route — Nairobi Central", routeDate: today, status: "ACTIVE",
      startLat: nairobiBranch.latitude, startLng: nairobiBranch.longitude,
      totalDistanceM: 48_200, estimatedMin: 111, startedAt: new Date(today.getTime() + 8 * 3_600_000),
    },
  });

  // Times and statuses mirror the mockup: two checked in, one in progress,
  // two still scheduled.
  const stopPlan = [
    { customer: customers[0], hour: 8, minute: 30, status: "DONE", visit: "COMPLETED" },
    { customer: customers[1], hour: 9, minute: 45, status: "DONE", visit: "COMPLETED" },
    { customer: customers[2], hour: 11, minute: 15, status: "ARRIVED", visit: "IN_PROGRESS" },
    { customer: customers[3], hour: 13, minute: 0, status: "PENDING", visit: "SCHEDULED" },
    { customer: customers[4], hour: 14, minute: 30, status: "PENDING", visit: "SCHEDULED" },
  ];

  for (const [i, plan] of stopPlan.entries()) {
    const plannedAt = new Date(today);
    plannedAt.setHours(plan.hour, plan.minute, 0, 0);

    await db.routeStop.create({
      data: {
        routeId: route.id, customerId: plan.customer.id, sequence: i + 1,
        status: plan.status, plannedAt,
        legDistanceM: i === 0 ? 4_200 : 8_000 + i * 2_400,
        legMin: i === 0 ? 10 : 18 + i * 4,
      },
    });

    const checkedIn = plan.visit !== "SCHEDULED";
    const completed = plan.visit === "COMPLETED";

    // Check-in points sit a few metres off the customer pin — close enough to
    // verify, which is what a real handset fix looks like.
    const jitter = () => (rand() - 0.5) * 0.0008;

    await db.visit.create({
      data: {
        companyId: zamar.id, customerId: plan.customer.id, repId: repJames.id,
        routeId: route.id, status: plan.visit, purpose: "SALES", scheduledAt: plannedAt,
        checkInAt: checkedIn ? plannedAt : null,
        checkInLat: checkedIn ? plan.customer.latitude! + jitter() : null,
        checkInLng: checkedIn ? plan.customer.longitude! + jitter() : null,
        checkInAccuracyM: checkedIn ? 12 + Math.floor(rand() * 30) : null,
        geofenceVerified: checkedIn,
        distanceFromCustomerM: checkedIn ? 15 + Math.floor(rand() * 60) : null,
        checkOutAt: completed ? new Date(plannedAt.getTime() + 40 * 60_000) : null,
        durationMin: completed ? 40 : null,
        outcome: completed ? "Order placed" : null,
      },
    });
  }

  // Brian's Coast route, so the console shows more than one rep working.
  const coastRoute = await db.route.create({
    data: {
      companyId: zamar.id, repId: repBrian.id, territoryId: coastT.id,
      name: "Today's Route — Coast", routeDate: today, status: "PLANNED",
      startLat: mombasaBranch.latitude, startLng: mombasaBranch.longitude,
      totalDistanceM: 16_400, estimatedMin: 38,
    },
  });
  for (const [i, customer] of [customers[1], customers[8]].entries()) {
    const plannedAt = new Date(today);
    plannedAt.setHours(9 + i * 2, 0, 0, 0);
    await db.routeStop.create({
      data: {
        routeId: coastRoute.id, customerId: customer.id, sequence: i + 1,
        plannedAt, legDistanceM: 6_200 + i * 4_000, legMin: 14 + i * 9,
      },
    });
    await db.visit.create({
      data: {
        companyId: zamar.id, customerId: customer.id, repId: repBrian.id,
        routeId: coastRoute.id, status: "SCHEDULED", scheduledAt: plannedAt,
      },
    });
  }

  // Historical visits — needed for the rep scorecard to mean anything. A slice
  // are left unverified so the verification rate is not a flat 100%.
  for (let day = 30; day >= 1; day--) {
    for (const rep of [repJames, repBrian]) {
      const repCustomers = customers.filter((c) => c.assignedRepId === rep.id);
      const count = 2 + Math.floor(rand() * 3);
      for (let n = 0; n < count && n < repCustomers.length; n++) {
        const customer = repCustomers[Math.floor(rand() * repCustomers.length)];
        const scheduledAt = daysAgo(day);
        scheduledAt.setHours(8 + n * 2, 30, 0, 0);
        const attended = rand() > 0.12;
        const verified = attended && rand() > 0.18;
        await db.visit.create({
          data: {
            companyId: zamar.id, customerId: customer.id, repId: rep.id,
            status: attended ? "COMPLETED" : "MISSED", purpose: "SALES", scheduledAt,
            checkInAt: attended ? scheduledAt : null,
            checkInLat: attended ? customer.latitude : null,
            checkInLng: attended ? customer.longitude : null,
            geofenceVerified: verified,
            distanceFromCustomerM: attended ? (verified ? 30 + Math.floor(rand() * 80) : 400 + Math.floor(rand() * 900)) : null,
            checkOutAt: attended ? new Date(scheduledAt.getTime() + 35 * 60_000) : null,
            durationMin: attended ? 35 : null,
            createdAt: scheduledAt, updatedAt: scheduledAt,
          },
        });
      }
    }
  }
  console.log("✓ Routes and visits");

  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const monthEnd = new Date(monthStart);
  monthEnd.setMonth(monthEnd.getMonth() + 1);

  await db.salesTarget.createMany({
    data: [repJames, repBrian].map((rep) => ({
      companyId: zamar.id, repId: rep.id, period: "MONTHLY",
      periodStart: monthStart, periodEnd: monthEnd,
      targetSalesCents: 2_500_000_00, targetCollectionCents: 2_000_000_00,
      targetVisits: 80, targetNewCustomers: 5,
    })),
  });

  const fuelCategory = await db.expenseCategory.findFirstOrThrow({
    where: { companyId: zamar.id, code: "FUEL" },
  });
  for (let i = 0; i < 8; i++) {
    await db.expense.create({
      data: {
        companyId: zamar.id, branchId: nairobiBranch.id, categoryId: fuelCategory.id,
        userId: i % 2 === 0 ? repJames.id : repBrian.id,
        number: `EXP-${String(i + 1).padStart(4, "0")}`,
        description: i % 2 === 0 ? "Fuel — Nairobi Central route" : "Fuel — Coast route",
        amountCents: (2_500 + Math.floor(rand() * 3_000)) * 100,
        status: i < 5 ? "APPROVED" : "SUBMITTED",
        incurredAt: daysAgo(i * 3),
        paymentMethod: "MPESA",
        latitude: -1.2921 + (rand() - 0.5) * 0.05,
        longitude: 36.8219 + (rand() - 0.5) * 0.05,
        approvedById: i < 5 ? salesManager.id : null,
        approvedAt: i < 5 ? daysAgo(i * 3 - 1) : null,
      },
    });
  }
  await db.documentCounter.updateMany({
    where: { companyId: zamar.id, docType: "EXPENSE" }, data: { nextValue: 9 },
  });

  // ── second tenant: core platform only ───────────────────────────────
  // Exists to prove the module gate. Signing in as this admin must show a
  // console without CRM, POS, Inventory, Field Sales and the rest.
  const acacia = await db.company.create({
    data: {
      name: "Acacia Distributors Ltd", slug: "acacia",
      email: "info@acacia.example", phone: "+254799000000",
      address: "Eldoret, Kenya", status: "ACTIVE", seatLimit: 15,
      latitude: 0.51427, longitude: 35.26977,
      activatedAt: daysAgo(20), createdAt: daysAgo(20),
    },
  });

  await db.companyModule.createMany({
    data: ALL_MODULES.map((moduleKey) => ({
      companyId: acacia.id, moduleKey,
      // Core platform only — nothing from the KES 190,000 module catalogue.
      enabled: false, priceCents: 0,
    })),
  });
  await db.documentCounter.createMany({
    data: DOC_TYPES.map(([docType, prefix]) => ({
      companyId: acacia.id, docType, prefix, nextValue: 1,
    })),
  });
  await db.smsTemplate.createMany({
    data: SMS_TEMPLATES.map((t) => ({ ...t, companyId: acacia.id })),
  });

  const acaciaBranch = await db.branch.create({
    data: {
      companyId: acacia.id, name: "Eldoret Head Office", code: "HQ", isPrimary: true,
      latitude: 0.51427, longitude: 35.26977,
    },
  });
  await db.stockLocation.create({
    data: {
      companyId: acacia.id, branchId: acaciaBranch.id,
      name: "Main Store", code: "MAIN", type: "WAREHOUSE",
    },
  });
  await db.user.create({
    data: {
      companyId: acacia.id, branchId: acaciaBranch.id,
      name: "Daniel Kiptoo", email: "admin@acacia.example",
      phone: "+254799000010", passwordHash, role: "COMPANY_ADMIN",
    },
  });

  // A pending tenant, so the Super Admin activation flow has a subject.
  await db.company.create({
    data: {
      name: "Highland Traders Ltd", slug: "highland",
      email: "info@highland.example", status: "PENDING", seatLimit: 10,
      latitude: -0.36760, longitude: 35.28610, createdAt: daysAgo(2),
    },
  });

  console.log("✓ Additional tenants");

  console.log(`
────────────────────────────────────────────────────────────
  Raut seeded.  All accounts use password: ${PASSWORD}

  PLATFORM
    admin@tariafrica.com            Super Admin

  ZAMAR SOLUTIONS  (all 11 modules licensed, eTIMS in sandbox)
    admin@zamarsolutions.co.ke      Company Admin
    sales@zamarsolutions.co.ke      Sales Manager
    accounts@zamarsolutions.co.ke   Accountant
    stores@zamarsolutions.co.ke     Storekeeper
    mombasa@zamarsolutions.co.ke    Branch Manager
    rep@zamarsolutions.co.ke        Field Rep  (James Mwangi — mobile app)
    rep2@zamarsolutions.co.ke       Field Rep  (Brian Omondi)

  ACACIA DISTRIBUTORS  (core platform only — module gate demo)
    admin@acacia.example            Company Admin
────────────────────────────────────────────────────────────
`);
}

/** Deterministic PRNG so reseeding produces the same demo numbers. */
function mulberry32(seed: number) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
  });
