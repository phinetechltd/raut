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
  // Sales & POS
  | "product:read"
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
  // Routing
  | "route:read"
  | "route:write"
  // Geofencing
  | "geofence:read"
  | "geofence:write"
  // SMS
  | "sms:read"
  | "sms:send"
  | "sms:template"
  // Analytics
  | "report:read"
  | "report:advanced"
  // Statutory financial statements. Deliberately NOT report:read: that is held
  // by field reps, and the P&L, balance sheet, cash position and VAT liability
  // are not theirs to see.
  | "report:financial"
  // eTIMS
  | "etims:read"
  | "etims:configure"
  | "etims:submit"
  | "creditnote:read"
  | "creditnote:write";

/**
 * Which module owns each permission. Permissions absent from this map belong to
 * the core platform and are always available.
 */
const PERMISSION_MODULE: Partial<Record<Permission, ModuleKey>> = {
  "customer:delete": "CRM",
  "territory:write": "CRM",
  "activity:write": "CRM",

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

  "route:read": "ROUTING",
  "route:write": "ROUTING",

  "geofence:read": "GEOFENCING",
  "geofence:write": "GEOFENCING",

  "sms:read": "SMS",
  "sms:send": "SMS",
  "sms:template": "SMS",

  "report:advanced": "ANALYTICS",
  // Owned by Finance, not Analytics, so the API and the Finance console page
  // gate on the same module. A page that renders and then 402s on its own data
  // reads as a broken product rather than a licence boundary.
  "report:financial": "FINANCE",

  "etims:read": "ETIMS",
  "etims:configure": "ETIMS",
  "etims:submit": "ETIMS",
  // Credit notes belong to Sales: a company reverses an invoice whether or not
  // it files with KRA. Only the transmission is gated on ETIMS.
  "creditnote:read": "SALES_POS",
  "creditnote:write": "SALES_POS",
};

const CORE_READ: Permission[] = ["company:read", "user:read", "customer:read", "product:read", "report:read"];

const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  SUPER_ADMIN: ["platform:manage"], // expanded below to everything

  COMPANY_ADMIN: [
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
    "product:write",
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
    "target:write",
    "route:read",
    "route:write",
    "geofence:read",
    "geofence:write",
    "sms:read",
    "sms:send",
    "sms:template",
    "report:advanced",
    "report:financial",
    "etims:read",
    "etims:configure",
    "etims:submit",
    "creditnote:read",
    "creditnote:write",
  ],

  BRANCH_MANAGER: [
    ...CORE_READ,
    "customer:write",
    "activity:write",
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
    "route:read",
    "route:write",
    "geofence:read",
    "sms:read",
    "sms:send",
    "report:advanced",
    "report:financial",
    "etims:read",
    "etims:submit",
    "creditnote:read",
    "creditnote:write",
  ],

  SALES_MANAGER: [
    ...CORE_READ,
    "customer:write",
    "territory:write",
    "activity:write",
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
    "target:write",
    "route:read",
    "route:write",
    "geofence:read",
    "geofence:write",
    "sms:read",
    "sms:send",
    "report:advanced",
    "report:financial",
    "etims:read",
    "creditnote:read",
    "creditnote:write",
  ],

  ACCOUNTANT: [
    ...CORE_READ,
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
    "report:advanced",
    "report:financial",
    "etims:read",
    "etims:submit",
    "creditnote:read",
    "creditnote:write",
  ],

  STOREKEEPER: [
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
    "etims:read",
  ],

  // The mobile principal. Deliberately narrow: a rep sees their own field data
  // and may create orders/payments/visits, but cannot approve or edit masters.
  FIELD_REP: [
    "customer:read",
    "customer:write",
    "product:read",
    "activity:write",
    "order:read",
    "order:write",
    "invoice:read",
    "payment:read",
    "payment:write",
    "stock:read",
    "visit:read",
    "visit:write",
    "route:read",
    "expense:read",
    "expense:write",
    "field:self",
    "report:read",
    "creditnote:read",
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
