/**
 * Module licensing — the commercial spine of the proposal.
 *
 * Each module is sold separately (proposal §3, pp. 6 & 8). A company that has
 * not bought a module must not be able to reach it through the console *or*
 * the mobile API, so the licence check lives here and is called from both.
 */

export const MODULE_KEYS = [
  "CRM",
  "SALES_POS",
  "INVENTORY",
  "PROCUREMENT",
  "FINANCE",
  "FIELD_SALES",
  "ROUTING",
  "GEOFENCING",
  "SMS",
  "ANALYTICS",
] as const;

export type ModuleKey = (typeof MODULE_KEYS)[number];

export interface ModuleDefinition {
  key: ModuleKey;
  /** Ordinal from the proposal, 01–10 */
  ordinal: string;
  name: string;
  priceCents: number;
  summary: string;
  /** Bullets exactly as listed in the proposal */
  features: string[];
  /** Modules that must also be licensed for this one to be useful */
  requires: ModuleKey[];
  icon: string;
}

export const MODULE_CATALOG: Record<ModuleKey, ModuleDefinition> = {
  CRM: {
    key: "CRM",
    ordinal: "01",
    name: "CRM & Customer Management",
    priceCents: 25_000_00,
    summary: "Advanced customer profiles, segmentation and follow-up tracking.",
    features: [
      "Advanced customer profiles",
      "Segmentation & history",
      "Follow-ups & activity log",
    ],
    requires: [],
    icon: "users",
  },
  SALES_POS: {
    key: "SALES_POS",
    ordinal: "02",
    name: "Sales & POS",
    priceCents: 30_000_00,
    summary: "Quotations through to invoices, receipts and rep performance.",
    features: [
      "Quotations, orders, invoices",
      "Receipts & discounts",
      "Salesperson performance",
    ],
    requires: [],
    icon: "receipt",
  },
  INVENTORY: {
    key: "INVENTORY",
    ordinal: "03",
    name: "Inventory Management",
    priceCents: 25_000_00,
    summary: "Product catalogue, multi-location stock and low-stock alerts.",
    features: [
      "Product catalogue & stock",
      "Multi-location transfers",
      "Low-stock alerts",
    ],
    requires: [],
    icon: "box",
  },
  PROCUREMENT: {
    key: "PROCUREMENT",
    ordinal: "04",
    name: "Procurement & Suppliers",
    priceCents: 20_000_00,
    summary: "Purchase orders, goods received and supplier invoicing.",
    features: ["Purchase orders", "Goods received & invoices", "Procurement reports"],
    requires: ["INVENTORY"],
    icon: "truck",
  },
  FINANCE: {
    key: "FINANCE",
    ordinal: "05",
    name: "Finance, Expenses & Receivables",
    priceCents: 25_000_00,
    summary: "Expense claims, receivables ageing and the financial dashboard.",
    features: [
      "Expense management",
      "Receivables & payment history",
      "Financial dashboard",
    ],
    requires: [],
    icon: "wallet",
  },
  FIELD_SALES: {
    key: "FIELD_SALES",
    ordinal: "06",
    name: "Field Sales Management",
    priceCents: 20_000_00,
    summary: "Visit scheduling, check-in, field order capture and targets.",
    features: [
      "Visit scheduling & check-in",
      "Order & payment capture",
      "Sales targets & performance",
    ],
    requires: [],
    icon: "map-pin",
  },
  ROUTING: {
    key: "ROUTING",
    ordinal: "07",
    name: "Smart Routing",
    priceCents: 15_000_00,
    summary: "Route planning, sequencing and the daily field itinerary.",
    features: [
      "Route planning & sequencing",
      "Daily field itinerary",
      "Distance-based planning",
    ],
    requires: ["FIELD_SALES"],
    icon: "route",
  },
  GEOFENCING: {
    key: "GEOFENCING",
    ordinal: "08",
    name: "Geofencing & Location Intel",
    priceCents: 15_000_00,
    summary: "GPS-verified visits, territory zones and out-of-zone alerts.",
    features: [
      "GPS-based visit verification",
      "Territory zones & alerts",
      "Verified visit reporting",
    ],
    requires: ["FIELD_SALES"],
    icon: "shield-check",
  },
  SMS: {
    key: "SMS",
    ordinal: "09",
    name: "SMS Communication",
    priceCents: 10_000_00,
    summary: "Order and payment confirmations, reminders and promotions.",
    features: [
      "Order & payment confirmations",
      "Balance reminders",
      "Promotions & notifications",
    ],
    requires: [],
    icon: "message-square",
  },
  ANALYTICS: {
    key: "ANALYTICS",
    ordinal: "10",
    name: "Advanced Reporting & Analytics",
    priceCents: 5_000_00,
    summary: "Sales and staff dashboards, territory performance and KPIs.",
    features: [
      "Sales & staff dashboards",
      "Territory performance",
      "Management KPIs",
    ],
    requires: [],
    icon: "bar-chart",
  },
};

export const MODULE_LIST = MODULE_KEYS.map((k) => MODULE_CATALOG[k]);

/** Core platform price from proposal §2 — always included, never a module. */
export const CORE_PLATFORM_PRICE_CENTS = 160_000_00;

/** Sum of all ten modules: KES 190,000 (proposal §4). */
export const ALL_MODULES_PRICE_CENTS = MODULE_LIST.reduce(
  (sum, m) => sum + m.priceCents,
  0,
);

/** Complete platform value: KES 350,000 (proposal §4). */
export const FULL_PLATFORM_PRICE_CENTS =
  CORE_PLATFORM_PRICE_CENTS + ALL_MODULES_PRICE_CENTS;

export function isModuleKey(value: string): value is ModuleKey {
  return (MODULE_KEYS as readonly string[]).includes(value);
}

/**
 * Modules whose absence would leave `key` half-working, e.g. Smart Routing
 * without Field Sales has nothing to sequence.
 */
export function missingPrerequisites(
  key: ModuleKey,
  enabled: Set<string>,
): ModuleKey[] {
  return MODULE_CATALOG[key].requires.filter((r) => !enabled.has(r));
}
