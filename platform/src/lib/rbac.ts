import { MODULE_CATALOG, type ModuleKey } from "./modules";

/**
 * Role-based access control.
 *
 * A permission resolves to ALLOWED only when both hold:
 *   1. the principal's role (or an explicit grant) carries the permission, and
 *   2. the module that owns the permission is licensed to their company.
 *
 * Rule 2 is what keeps the commercial model honest — a COMPANY_ADMIN still
 * cannot open Procurement if Raut never bought Procurement.
 */

export const ROLES = [
  "SUPER_ADMIN",
  "COMPANY_ADMIN",
  "BRANCH_MANAGER",
  "SALES_MANAGER",
  "ACCOUNTANT",
  "STOREKEEPER",
  "FIELD_REP",
] as const;

export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  SUPER_ADMIN: "Super Admin",
  COMPANY_ADMIN: "Company Admin",
  BRANCH_MANAGER: "Branch Manager",
  SALES_MANAGER: "Sales Manager",
  ACCOUNTANT: "Accountant",
  STOREKEEPER: "Storekeeper",
  FIELD_REP: "Field Sales Rep",
};

export type Permission =
  // platform (core — never module-gated)
  | "platform:manage"
  | "company:read"
  | "company:write"
  | "user:read"
  | "user:write"
  | "branch:write"
  | "audit:read"
  | "settings:write"
  // CRM
  | "customer:read"
  | "customer:write"
  | "customer:delete"
  | "territory:write"
  | "activity:write"
  | "lead:read"
  | "lead:write"
  | "deal:read"
  | "deal:write"
  | "task:read"
  | "task:write"
  // Sales & POS
  | "product:read"
  | "quotation:read"
  | "quotation:write"
  | "order:read"
  | "order:write"
  | "invoice:read"
  | "invoice:write"
  | "invoice:approve"
  | "payment:read"
  | "payment:write"
  | "discount:approve"
  // Inventory
  | "product:write"
  | "stock:read"
  | "stock:write"
  | "transfer:write"
  // Procurement
  | "supplier:read"
  | "supplier:write"
  | "purchase:read"
  | "purchase:write"
  | "grn:write"
  // Finance
  | "expense:read"
  | "expense:write"
  | "expense:approve"
  | "finance:read"
  // Field sales
  | "visit:read"
  | "visit:write"
  | "target:write"
  | "field:self"
  | "message:read"
  | "message:write"
  // Routing
  | "route:read"
  | "route:write"
  | "vehicle:read"
  | "vehicle:write"
  | "vehicle:track"
  | "tracker:manage"
  // Geofencing
  | "geofence:read"
  | "geofence:write"
  // SMS & email (the Communication module)
  | "sms:read"
  | "sms:send"
  | "sms:template"
  | "email:read"
  | "email:send"
  // Analytics
  | "report:read"
  | "report:advanced"
  // Statutory financial statements. Deliberately NOT report:read: that is held
  // by field reps, and the P&L, balance sheet, cash position and VAT liability
  // are not theirs to see.
  | "report:financial"
  // Operational reports. Each report also needs its module and its own data
  // permission, so a storekeeper gets stock reports and not the sales book.
  | "report:operational"
  // Accounting tools.
  | "journal:write"
  | "payable:write"
  | "period:close"
  | "period:reopen"
  // eTIMS
  | "etims:read"
  | "etims:configure"
  | "etims:submit"
  | "creditnote:read"
  | "creditnote:write"
  // Delivery notes
  | "delivery:read"
  | "delivery:write";

/**
 * Which module owns each permission. Permissions absent from this map belong to
 * the core platform and are always available.
 */
const PERMISSION_MODULE: Partial<Record<Permission, ModuleKey>> = {
  "customer:delete": "CRM",
  "territory:write": "CRM",
  "activity:write": "CRM",
  "lead:read": "CRM",
  "lead:write": "CRM",
  "deal:read": "CRM",
  "deal:write": "CRM",
  "task:read": "CRM",
  "task:write": "CRM",

  "quotation:read": "SALES_POS",
  "quotation:write": "SALES_POS",
  "order:read": "SALES_POS",
  "order:write": "SALES_POS",
  "invoice:read": "SALES_POS",
  "invoice:write": "SALES_POS",
  "invoice:approve": "SALES_POS",
  "payment:read": "SALES_POS",
  "payment:write": "SALES_POS",
  "discount:approve": "SALES_POS",

  "stock:read": "INVENTORY",
  "stock:write": "INVENTORY",
  "transfer:write": "INVENTORY",

  "supplier:read": "PROCUREMENT",
  "supplier:write": "PROCUREMENT",
  "purchase:read": "PROCUREMENT",
  "purchase:write": "PROCUREMENT",
  "grn:write": "PROCUREMENT",

  "expense:read": "FINANCE",
  "expense:write": "FINANCE",
  "expense:approve": "FINANCE",
  "finance:read": "FINANCE",

  "visit:read": "FIELD_SALES",
  "visit:write": "FIELD_SALES",
  "target:write": "FIELD_SALES",
  "field:self": "FIELD_SALES",
  "message:read": "FIELD_SALES",
  "message:write": "FIELD_SALES",

  "route:read": "ROUTING",
  "route:write": "ROUTING",
  "vehicle:read": "ROUTING",
  "vehicle:write": "ROUTING",
  "vehicle:track": "ROUTING",
  "tracker:manage": "ROUTING",

  "geofence:read": "GEOFENCING",
  "geofence:write": "GEOFENCING",

  "sms:read": "SMS",
  "sms:send": "SMS",
  "sms:template": "SMS",
  "email:read": "SMS",
  "email:send": "SMS",

  "report:advanced": "ANALYTICS",
  // Owned by Finance, not Analytics, so the API and the Finance console page
  // gate on the same module. A page that renders and then 402s on its own data
  // reads as a broken product rather than a licence boundary.
  "report:financial": "FINANCE",
  "journal:write": "FINANCE",
  "payable:write": "FINANCE",
  "period:close": "FINANCE",
  "period:reopen": "FINANCE",

  "etims:read": "ETIMS",
  "etims:configure": "ETIMS",
  "etims:submit": "ETIMS",
  // Credit notes belong to Sales: a company reverses an invoice whether or not
  // it files with KRA. Only the transmission is gated on ETIMS.
  "creditnote:read": "SALES_POS",
  "creditnote:write": "SALES_POS",
  // Delivery notes are dispatch paperwork for a sale, so they belong with it.
  "delivery:read": "SALES_POS",
  "delivery:write": "SALES_POS",
};

const CORE_READ: Permission[] = ["company:read", "user:read", "customer:read", "product:read", "report:read"];

const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  SUPER_ADMIN: ["platform:manage"], // expanded below to everything

  COMPANY_ADMIN: [
    "report:operational",
    "journal:write",
    "payable:write",
    "period:close",
    "period:reopen",
    ...CORE_READ,
    "company:write",
    "user:write",
    "branch:write",
    "audit:read",
    "settings:write",
    "customer:write",
    "customer:delete",
    "territory:write",
    "activity:write",
    "lead:read",
    "lead:write",
    "deal:read",
    "deal:write",
    "task:read",
    "task:write",
    "product:write",
    "quotation:read",
    "quotation:write",
    "order:read",
    "order:write",
    "invoice:read",
    "invoice:write",
    "invoice:approve",
    "payment:read",
    "payment:write",
    "discount:approve",
    "stock:read",
    "stock:write",
    "transfer:write",
    "supplier:read",
    "supplier:write",
    "purchase:read",
    "purchase:write",
    "grn:write",
    "expense:read",
    "expense:write",
    "expense:approve",
    "finance:read",
    "visit:read",
    "visit:write",
    "message:read",
    "message:write",
    "target:write",
    "route:read",
    "route:write",
    "vehicle:read",
    "vehicle:write",
    "vehicle:track",
    "tracker:manage",
    "geofence:read",
    "geofence:write",
    "sms:read",
    "sms:send",
    "sms:template",
    "email:read",
    "email:send",
    "report:advanced",
    "report:financial",
    "etims:read",
    "etims:configure",
    "etims:submit",
    "creditnote:read",
    "creditnote:write",
    "delivery:read",
    "delivery:write",
  ],

  BRANCH_MANAGER: [
    "report:operational",
    ...CORE_READ,
    "customer:write",
    "activity:write",
    "lead:read",
    "lead:write",
    "deal:read",
    "deal:write",
    "task:read",
    "task:write",
    "order:read",
    "order:write",
    "invoice:read",
    "invoice:write",
    "invoice:approve",
    "payment:read",
    "payment:write",
    "discount:approve",
    "stock:read",
    "stock:write",
    "transfer:write",
    "purchase:read",
    "expense:read",
    "expense:write",
    "expense:approve",
    "visit:read",
    "visit:write",
    "message:read",
    "message:write",
    "route:read",
    "route:write",
    "vehicle:read",
    "vehicle:track",
    "geofence:read",
    "sms:read",
    "sms:send",
    "email:read",
    "email:send",
    "report:advanced",
    "report:financial",
    "etims:read",
    "etims:submit",
    "creditnote:read",
    "creditnote:write",
    "delivery:read",
    "delivery:write",
  ],

  SALES_MANAGER: [
    "report:operational",
    ...CORE_READ,
    "customer:write",
    "territory:write",
    "activity:write",
    "lead:read",
    "lead:write",
    "deal:read",
    "deal:write",
    "task:read",
    "task:write",
    "quotation:read",
    "quotation:write",
    "order:read",
    "order:write",
    "invoice:read",
    "invoice:write",
    "payment:read",
    "discount:approve",
    "stock:read",
    "visit:read",
    "visit:write",
    "message:read",
    "message:write",
    "target:write",
    "route:read",
    "route:write",
    "vehicle:read",
    "vehicle:write",
    "vehicle:track",
    "geofence:read",
    "geofence:write",
    "sms:read",
    "sms:send",
    "email:read",
    "email:send",
    "report:advanced",
    "report:financial",
    "etims:read",
    "creditnote:read",
    "creditnote:write",
    "delivery:read",
    "delivery:write",
  ],

  ACCOUNTANT: [
    "report:operational",
    "journal:write",
    "payable:write",
    "period:close",
    ...CORE_READ,
    "task:read",
    "task:write",
    "invoice:read",
    "invoice:write",
    "invoice:approve",
    "payment:read",
    "payment:write",
    "order:read",
    "supplier:read",
    "purchase:read",
    "expense:read",
    "expense:approve",
    "finance:read",
    "sms:read",
    "sms:send",
    "email:read",
    "email:send",
    "report:advanced",
    "report:financial",
    "etims:read",
    "etims:submit",
    "creditnote:read",
    "creditnote:write",
    "delivery:read",
  ],

  STOREKEEPER: [
    "report:operational",
    ...CORE_READ,
    "stock:read",
    "stock:write",
    "transfer:write",
    "product:write",
    "supplier:read",
    "purchase:read",
    "purchase:write",
    "grn:write",
    "order:read",
    "delivery:read",
    "delivery:write",
    "etims:read",
  ],

  // The mobile principal. Deliberately narrow: a rep sees their own field data
  // and may create orders/payments/visits, but cannot approve or edit masters.
  FIELD_REP: [
    "customer:read",
    "customer:write",
    "product:read",
    "activity:write",
    "lead:read",
    "lead:write",
    "deal:read",
    "deal:write",
    "task:read",
    "task:write",
    "order:read",
    "order:write",
    "invoice:read",
    "payment:read",
    "payment:write",
    "stock:read",
    "visit:read",
    "visit:write",
    "message:read",
    "message:write",
    "route:read",
    // The plate and odometer of the van they are driving today, nothing more.
    "vehicle:read",
    // Their own van's position only; the fleet query narrows self-scoped roles.
    "vehicle:track",
    "expense:read",
    "expense:write",
    "field:self",
    "report:read",
    "creditnote:read",
    // A rep is the person the goods are handed back to, so a return has to be
    // possible where they are standing. It reduces what a customer owes, which
    // is the same power `payment:write` above already gives them, and the
    // server refuses an over-credit either way. Withholding it would have left
    // the return flow unreachable by the only people who need it.
    "creditnote:write",
    // Submit only, not read. A rep at a counter is the person who discovers a
    // stuck filing and needs to push it, but the transmission log carries every
    // customer and amount in the company and is none of their business. Their
    // pending list is built from the invoices they already sync.
    "etims:submit",
    // Confirming a drop at the customer's door is the rep's own field record,
    // and the note they print or show on the handset is theirs to raise.
    "delivery:read",
    "delivery:write",
  ],
};

const ALL_PERMISSIONS = Array.from(
  new Set(Object.values(ROLE_PERMISSIONS).flat()),
) as Permission[];

export interface Principal {
  userId: string;
  companyId: string | null;
  role: Role;
  branchId?: string | null;
  extraPermissions?: Permission[];
  /** Module keys licensed & enabled for the principal's company */
  enabledModules: Set<string>;
}

export function permissionsForRole(role: Role): Permission[] {
  if (role === "SUPER_ADMIN") return ALL_PERMISSIONS;
  return ROLE_PERMISSIONS[role] ?? [];
}

/** The module that owns a permission, or null when it is core platform. */
export function owningModule(permission: Permission): ModuleKey | null {
  return PERMISSION_MODULE[permission] ?? null;
}

export function can(principal: Principal, permission: Permission): boolean {
  // Super Admin operates above tenancy and above module licensing: it manages
  // the licences themselves, so gating it on them would be circular.
  if (principal.role === "SUPER_ADMIN") return true;

  const granted =
    permissionsForRole(principal.role).includes(permission) ||
    (principal.extraPermissions ?? []).includes(permission);
  if (!granted) return false;

  const module = owningModule(permission);
  if (module && !principal.enabledModules.has(module)) return false;

  return true;
}

export function canAny(principal: Principal, permissions: Permission[]): boolean {
  return permissions.some((p) => can(principal, p));
}

/** Human-readable reason a permission was denied — surfaced in API errors. */
export function denialReason(
  principal: Principal,
  permission: Permission,
): "role" | "module" | null {
  if (can(principal, permission)) return null;
  const granted =
    permissionsForRole(principal.role).includes(permission) ||
    (principal.extraPermissions ?? []).includes(permission);
  if (!granted) return "role";
  const module = owningModule(permission);
  if (module && !principal.enabledModules.has(module)) return "module";
  return "role";
}

export function moduleNameFor(permission: Permission): string | null {
  const key = owningModule(permission);
  return key ? MODULE_CATALOG[key].name : null;
}

/** Reps only ever see their own field records; everyone else sees the company. */
export function isSelfScoped(principal: Principal): boolean {
  return principal.role === "FIELD_REP";
}
