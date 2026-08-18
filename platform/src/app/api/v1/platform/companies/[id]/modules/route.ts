import { z } from "zod";

import { forbidden, handler, moduleKeyOrThrow, parseBody } from "@/lib/api";
import { auditAs } from "@/lib/audit";
import { MODULE_CATALOG, missingPrerequisites } from "@/lib/modules";
import { db } from "@/lib/db";
import { licenceSummary, setModule } from "@/server/provisioning";

export const dynamic = "force-dynamic";

export const GET = handler<{ id: string }>(
  { allowPlatform: true },
  async ({ principal, params }) => {
    if (principal.role !== "SUPER_ADMIN") throw forbidden();
    return licenceSummary(params.id);
  },
);

const schema = z.object({
  moduleKey: z.string(),
  enabled: z.boolean(),
});

/**
 * Toggles a module licence — the lever the whole commercial model hangs on.
 *
 * Enabling a module whose prerequisite is missing is allowed but reported, so
 * the operator finds out at the point of sale that Smart Routing without Field
 * Sales will not do anything useful.
 */
export const PUT = handler<{ id: string }>(
  { allowPlatform: true },
  async ({ principal, params, request }) => {
    if (principal.role !== "SUPER_ADMIN") throw forbidden();

    const input = await parseBody(request, schema);
    const moduleKey = moduleKeyOrThrow(input.moduleKey);

    const licence = await setModule(params.id, moduleKey, input.enabled);

    const enabled = new Set(
      (
        await db.companyModule.findMany({
          where: { companyId: params.id, enabled: true },
          select: { moduleKey: true },
        })
      ).map((m) => m.moduleKey),
    );

    await auditAs(
      principal,
      input.enabled ? "MODULE_ENABLE" : "MODULE_DISABLE",
      "CompanyModule",
      licence.id,
      { companyId: params.id, moduleKey },
      request,
    );

    return {
      licence,
      definition: MODULE_CATALOG[moduleKey],
      warnings: input.enabled
        ? missingPrerequisites(moduleKey, enabled).map(
            (k) =>
              `${MODULE_CATALOG[moduleKey].name} needs ${MODULE_CATALOG[k].name} to be useful.`,
          )
        : [],
    };
  },
);
