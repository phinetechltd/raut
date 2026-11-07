import "server-only";

import { db } from "@/lib/db";
import type { ModuleKey } from "@/lib/modules";
import { can, isSelfScoped, type Permission, type Principal } from "@/lib/rbac";
import {
  MAX_REPORT_ROWS,
  type ReportColumn,
  type ReportFilterField,
  type ReportOutput,
} from "@/lib/report-engine";

export const REPORT_GROUPS = [
  { key: "accounting", label: "Accounting", description: "Ledgers, statements and reconciliations." },
  { key: "tax", label: "Tax", description: "VAT return workings, schedules and eTIMS filing." },
  { key: "sales", label: "Sales", description: "What sold, to whom, by whom, and what came back." },
  { key: "customers", label: "Customers", description: "The customer book, credit and activity." },
  { key: "inventory", label: "Inventory", description: "Stock on hand, movements and transfers." },
  { key: "procurement", label: "Procurement", description: "Orders, receipts, bills and supplier spend." },
  { key: "finance", label: "Payments & expenses", description: "Money in, money out and gateway collections." },
  { key: "field", label: "Field sales", description: "Visits, rep performance and geofence compliance." },
  { key: "routing", label: "Routes & vehicles", description: "Route execution and how the fleet was used." },
  { key: "sms", label: "SMS", description: "Messages sent and what they cost." },
] as const;

export type ReportGroup = (typeof REPORT_GROUPS)[number]["key"];

export interface ReportContext {
  companyId: string;
  principal: Principal;
  from: Date | null;
  to: Date | null;
  now: Date;
  params: Record<string, string | undefined>;
}

/** A dropdown whose options come from the database, passed to the report's query. */
export interface ReportSelect {
  key: string;
  allLabel: string;
  load: (companyId: string) => Promise<Array<{ value: string; label: string }>>;
}

export interface ReportDefinition {
  key: string;
  title: string;
  description: string;
  group: ReportGroup;
  /** The licence this report belongs to. Null means core. */
  module: ModuleKey | null;
  /** All of these are required, so the report never shows more than its data allows. */
  permissions: Permission[];
  /** False for a position as it stands now, such as stock on hand. */
  usesPeriod: boolean;
  defaultRange?: string;
  columns: ReportColumn[];
  filters?: ReportFilterField[];
  selects?: ReportSelect[];
  defaultSort?: { key: string; dir: "asc" | "desc" };
  run: (ctx: ReportContext) => Promise<ReportOutput>;
}

/** A statement that lives on its own page but is listed with the rest. */
export interface ReportLink {
  key: string;
  title: string;
  description: string;
  group: ReportGroup;
  module: ModuleKey | null;
  permissions: Permission[];
  href: string;
}

export function canRunReport(principal: Principal, report: Pick<ReportDefinition, "module" | "permissions">): boolean {
  if (report.module && principal.role !== "SUPER_ADMIN" && !principal.enabledModules.has(report.module)) {
    return false;
  }
  return report.permissions.every((p) => can(principal, p));
}

/** `{ field: { gte, lte } }` for the report's period, or nothing for all time. */
export function within(ctx: ReportContext, field: string): Record<string, unknown> {
  if (!ctx.from && !ctx.to) return {};
  return {
    [field]: {
      ...(ctx.from ? { gte: ctx.from } : {}),
      ...(ctx.to ? { lte: ctx.to } : {}),
    },
  };
}

/** Loads one row past the ceiling so an over-long report can say so. */
export const ROW_LIMIT = MAX_REPORT_ROWS + 1;

export function capped<T>(rows: T[]): { rows: T[]; truncated: boolean } {
  return rows.length > MAX_REPORT_ROWS
    ? { rows: rows.slice(0, MAX_REPORT_ROWS), truncated: true }
    : { rows, truncated: false };
}

export function selfRepId(ctx: ReportContext): string | null {
  return isSelfScoped(ctx.principal) ? ctx.principal.userId : null;
}

export async function userNames(companyId: string): Promise<Map<string, string>> {
  const users = await db.user.findMany({ where: { companyId }, select: { id: true, name: true } });
  return new Map(users.map((u) => [u.id, u.name]));
}

export function bump(map: Map<string, number>, key: string, by: number): void {
  map.set(key, (map.get(key) ?? 0) + by);
}
