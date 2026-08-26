import "server-only";

import { hashPassword } from "@/lib/auth";
import { db } from "@/lib/db";
import { MODULE_CATALOG, MODULE_KEYS, type ModuleKey } from "@/lib/modules";
import { initCounters } from "@/lib/numbering";
import { DEFAULT_TEMPLATES } from "@/lib/sms";
import { ensureChartOfAccounts } from "./ledger";

/**
 * Super Admin provisioning — "create & activate companies" from Phase One.
 *
 * A new tenant is not just a Company row: it needs its module licences, its
 * document counters, a primary branch, a stock location, an admin user and the
 * default SMS templates. Doing that in one transaction is what makes "activate
 * a company" a single click rather than a checklist someone can get wrong.
 */

export interface CreateCompanyInput {
  name: string;
  slug: string;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  taxPin?: string | null;
  seatLimit?: number;
  latitude?: number | null;
  longitude?: number | null;
  /** Modules purchased at signup. Core platform is always included. */
  modules?: ModuleKey[];
  admin: {
    name: string;
    email: string;
    password: string;
    phone?: string | null;
  };
  activate?: boolean;
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

export async function createCompany(input: CreateCompanyInput) {
  const passwordHash = await hashPassword(input.admin.password);
  const purchased = new Set<ModuleKey>(input.modules ?? []);

  const company = await db.$transaction(async (tx) => {
    const created = await tx.company.create({
      data: {
        name: input.name,
        slug: input.slug,
        email: input.email ?? null,
        phone: input.phone ?? null,
        address: input.address ?? null,
        taxPin: input.taxPin ?? null,
        seatLimit: input.seatLimit ?? 50,
        latitude: input.latitude ?? null,
        longitude: input.longitude ?? null,
        status: input.activate === false ? "PENDING" : "ACTIVE",
        activatedAt: input.activate === false ? null : new Date(),
      },
    });

    // Every module gets a row; `enabled` is what was actually bought. Keeping
    // rows for unbought modules means the console can show the full catalogue
    // with an upgrade path rather than hiding what is for sale.
    await tx.companyModule.createMany({
      data: MODULE_KEYS.map((key) => ({
        companyId: created.id,
        moduleKey: key,
        enabled: purchased.has(key),
        priceCents: purchased.has(key) ? MODULE_CATALOG[key].priceCents : 0,
        activatedAt: purchased.has(key) ? new Date() : null,
      })),
    });

    const branch = await tx.branch.create({
      data: {
        companyId: created.id,
        name: "Head Office",
        code: "HQ",
        isPrimary: true,
        phone: input.phone ?? null,
        address: input.address ?? null,
        latitude: input.latitude ?? null,
        longitude: input.longitude ?? null,
      },
    });

    await tx.stockLocation.create({
      data: {
        companyId: created.id,
        branchId: branch.id,
        name: "Main Store",
        code: "MAIN",
        type: "WAREHOUSE",
      },
    });

    await tx.user.create({
      data: {
        companyId: created.id,
        branchId: branch.id,
        name: input.admin.name,
        email: input.admin.email.toLowerCase(),
        phone: input.admin.phone ?? null,
        passwordHash,
        role: "COMPANY_ADMIN",
        status: "ACTIVE",
      },
    });

    await tx.smsTemplate.createMany({
      data: DEFAULT_TEMPLATES.map((t) => ({
        companyId: created.id,
        key: t.key,
        name: t.name,
        body: t.body,
      })),
    });

    await tx.expenseCategory.createMany({
      data: [
        { companyId: created.id, name: "Fuel", code: "FUEL" },
        { companyId: created.id, name: "Airtime & Data", code: "AIRTIME" },
        { companyId: created.id, name: "Travel & Accommodation", code: "TRAVEL" },
        { companyId: created.id, name: "Vehicle Maintenance", code: "VEHICLE" },
        { companyId: created.id, name: "Miscellaneous", code: "MISC" },
      ],
    });

    return created;
  });

  await initCounters(company.id);

  // Every company gets books from the moment it exists. Creating the chart
  // lazily on first posting would work, but it would also mean the first sale
  // a company ever makes is the one that discovers a problem with it.
  await ensureChartOfAccounts(company.id);

  return company;
}

/** Toggles a module licence and records the price paid at activation. */
export async function setModule(
  companyId: string,
  moduleKey: ModuleKey,
  enabled: boolean,
) {
  return db.companyModule.upsert({
    where: { companyId_moduleKey: { companyId, moduleKey } },
    create: {
      companyId,
      moduleKey,
      enabled,
      priceCents: enabled ? MODULE_CATALOG[moduleKey].priceCents : 0,
      activatedAt: enabled ? new Date() : null,
    },
    update: {
      enabled,
      priceCents: enabled ? MODULE_CATALOG[moduleKey].priceCents : 0,
      activatedAt: enabled ? new Date() : null,
    },
  });
}

export async function setCompanyStatus(companyId: string, status: string) {
  return db.company.update({
    where: { id: companyId },
    data: {
      status,
      activatedAt: status === "ACTIVE" ? new Date() : undefined,
    },
  });
}

/** Licence summary shown on the company detail screen. */
export async function licenceSummary(companyId: string) {
  const modules = await db.companyModule.findMany({
    where: { companyId },
    orderBy: { moduleKey: "asc" },
  });

  const enabled = modules.filter((m) => m.enabled);
  return {
    modules: modules.map((m) => ({
      ...m,
      definition: MODULE_CATALOG[m.moduleKey as ModuleKey],
    })),
    enabledCount: enabled.length,
    moduleValueCents: enabled.reduce((sum, m) => sum + m.priceCents, 0),
  };
}