import { z } from "zod";

import { ApiError, handler, parseBody } from "@/lib/api";
import {
  adapterFor,
  isItemClassCode,
  isItemTypeCode,
  isPackageUnit,
  isQuantityUnit,
  isTaxTypeCode,
  isValidKraPin,
} from "@/lib/etims";
import { companyIdOf } from "@/lib/tenant";
import { resolveEtimsCredentials } from "@/server/credentials";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/** The company's eTIMS settings. Never returns a credential. */
export const GET = handler({ permission: "etims:read" }, async ({ principal }) => {
  const companyId = companyIdOf(principal);
  const config = await db.etimsConfig.findUnique({ where: { companyId } });
  const creds = await resolveEtimsCredentials(companyId);

  const [unclassified, withoutPin, company] = await Promise.all([
    db.product.count({
      where: { companyId, active: true, etimsItemClassCode: null },
    }),
    db.customer.count({ where: { companyId, taxPin: null } }),
    db.company.findUnique({ where: { id: companyId }, select: { taxPin: true } }),
  ]);

  return {
    configured: Boolean(creds),
    // The PIN identifies which taxpayer this company files as, so an admin has
    // to be able to see it. The API key never leaves the vault.
    taxPin: creds?.taxPin ?? null,
    taxPinValid: creds ? isValidKraPin(creds.taxPin) : null,
    companyPinValid: company?.taxPin ? isValidKraPin(company.taxPin) : null,
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

const invalid = (field: string, value: string, hint: string) =>
  new ApiError(422, "INVALID_ETIMS_CODE", `${field}: "${value}" is not ${hint}`, { field, value });

/**
 * Saves the settings.
 *
 * Switching on with LIVE and no stored key is refused here rather than left to
 * fail at the first sale. An admin who thinks eTIMS is on when it cannot
 * transmit will discover it weeks later, in a return.
 *
 * Every code is checked against the published tables before it is stored. A
 * default that KRA does not recognise would otherwise be applied to every
 * unclassified product and reject every sale that touches one.
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
      throw new ApiError(
        422,
        "ETIMS_KEY_REQUIRED",
        "Add a Digitax API key in Settings → Payments before switching eTIMS on in live mode.",
      );
    }

    if (enabled && creds && !isValidKraPin(creds.taxPin)) {
      throw new ApiError(
        422,
        "INVALID_KRA_PIN",
        `The stored Digitax TIN "${creds.taxPin}" is not a valid KRA PIN (expected the form P051234567X). Correct it under Settings → Payments first.`,
      );
    }

    if (body.defaultItemClassCode !== undefined && !isItemClassCode(body.defaultItemClassCode, { tableOnly: true })) {
      throw invalid("defaultItemClassCode", body.defaultItemClassCode, "a known eTIMS item classification");
    }
    if (body.defaultItemTypeCode !== undefined && !isItemTypeCode(body.defaultItemTypeCode)) {
      throw invalid("defaultItemTypeCode", body.defaultItemTypeCode, "an eTIMS item type (1, 2 or 3)");
    }
    if (body.defaultTaxTypeCode !== undefined && !isTaxTypeCode(body.defaultTaxTypeCode)) {
      throw invalid("defaultTaxTypeCode", body.defaultTaxTypeCode, "an eTIMS tax type (A–E)");
    }
    if (body.defaultQuantityUnit !== undefined && !isQuantityUnit(body.defaultQuantityUnit)) {
      throw invalid("defaultQuantityUnit", body.defaultQuantityUnit, "a known eTIMS quantity unit");
    }
    if (body.defaultPackageUnit !== undefined && !isPackageUnit(body.defaultPackageUnit)) {
      throw invalid("defaultPackageUnit", body.defaultPackageUnit, "a known eTIMS packaging unit");
    }
    if (body.defaultOriginNation !== undefined && !/^[A-Z]{2}$/.test(body.defaultOriginNation)) {
      throw invalid("defaultOriginNation", body.defaultOriginNation, "a two-letter ISO country code");
    }

    let activeFrom: Date | null;
    if (body.activeFrom === undefined) {
      // Switching on for the first time starts from now, not from the
      // beginning of time. Nothing already invoiced is pushed at KRA.
      activeFrom = existing?.activeFrom ?? (enabled ? new Date() : null);
    } else if (body.activeFrom) {
      activeFrom = new Date(body.activeFrom);
      if (Number.isNaN(activeFrom.getTime())) {
        throw new ApiError(422, "INVALID_DATE", `activeFrom: "${body.activeFrom}" is not a date`);
      }
    } else {
      activeFrom = null;
    }

    const data = {
      enabled,
      environment,
      autoTransmit: body.autoTransmit ?? existing?.autoTransmit ?? true,
      activeFrom,
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
