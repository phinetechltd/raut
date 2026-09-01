import { z } from "zod";

import { handler, parseBody } from "@/lib/api";
import { adapterFor } from "@/lib/etims";
import { companyIdOf } from "@/lib/tenant";
import { resolveEtimsCredentials } from "@/server/credentials";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/** The company's eTIMS settings. Never returns a credential. */
export const GET = handler({ permission: "etims:read" }, async ({ principal }) => {
  const companyId = companyIdOf(principal);
  const config = await db.etimsConfig.findUnique({ where: { companyId } });
  const creds = await resolveEtimsCredentials(companyId);

  const [unclassified, withoutPin] = await Promise.all([
    db.product.count({
      where: { companyId, active: true, etimsItemClassCode: null },
    }),
    db.customer.count({ where: { companyId, taxPin: null } }),
  ]);

  return {
    configured: Boolean(creds),
    // The PIN identifies which taxpayer this company files as, so an admin has
    // to be able to see it. The API key never leaves the vault.
    taxPin: creds?.taxPin ?? null,
    config: config ?? null,
    readiness: { productsWithoutClassification: unclassified, customersWithoutPin: withoutPin },
  };
});

const Body = z.object({
  enabled: z.boolean().optional(),
  environment: z.enum(["SANDBOX", "LIVE"]).optional(),
  autoTransmit: z.boolean().optional(),
  activeFrom: z.string().nullable().optional(),
  defaultItemClassCode: z.string().optional(),
  defaultItemTypeCode: z.string().optional(),
  defaultTaxTypeCode: z.string().optional(),
  defaultQuantityUnit: z.string().optional(),
  defaultPackageUnit: z.string().optional(),
  defaultOriginNation: z.string().optional(),
});

/**
 * Saves the settings.
 *
 * Switching on with LIVE and no stored key is refused here rather than left to
 * fail at the first sale. An admin who thinks eTIMS is on when it cannot
 * transmit will discover it weeks later, in a return.
 */
export const PUT = handler(
  { permission: "etims:configure" },
  async ({ principal, request }) => {
    const body = await parseBody(request, Body);
    const companyId = companyIdOf(principal);
    const creds = await resolveEtimsCredentials(companyId);

    const existing = await db.etimsConfig.findUnique({ where: { companyId } });
    const environment = body.environment ?? existing?.environment ?? "SANDBOX";
    const enabled = body.enabled ?? existing?.enabled ?? false;

    if (enabled && !adapterFor(environment, Boolean(creds))) {
      throw new Error(
        "Add a Digitax API key in Settings → Payments before switching eTIMS on in live mode.",
      );
    }

    const data = {
      enabled,
      environment,
      autoTransmit: body.autoTransmit ?? existing?.autoTransmit ?? true,
      activeFrom:
        body.activeFrom === undefined
          ? // Switching on for the first time starts from now, not from the
            // beginning of time. Nothing already invoiced is pushed at KRA.
            (existing?.activeFrom ?? (enabled ? new Date() : null))
          : body.activeFrom
            ? new Date(body.activeFrom)
            : null,
      defaultItemClassCode: body.defaultItemClassCode ?? existing?.defaultItemClassCode ?? "99000000",
      defaultItemTypeCode: body.defaultItemTypeCode ?? existing?.defaultItemTypeCode ?? "2",
      defaultTaxTypeCode: body.defaultTaxTypeCode ?? existing?.defaultTaxTypeCode ?? "B",
      defaultQuantityUnit: body.defaultQuantityUnit ?? existing?.defaultQuantityUnit ?? "U",
      defaultPackageUnit: body.defaultPackageUnit ?? existing?.defaultPackageUnit ?? "NT",
      defaultOriginNation: body.defaultOriginNation ?? existing?.defaultOriginNation ?? "KE",
    };

    const saved = await db.etimsConfig.upsert({
      where: { companyId },
      create: { companyId, ...data },
      update: data,
    });

    return { config: saved };
  },
);
