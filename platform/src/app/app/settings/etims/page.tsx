import { notFound } from "next/navigation";

import { ModuleLocked, PageHeader } from "@/components/ui";
import { db } from "@/lib/db";
import { can } from "@/lib/rbac";
import { requireTenant } from "@/lib/session";
import { resolveEtimsCredentials } from "@/server/credentials";

import { EtimsForm } from "./etims-form";

export const dynamic = "force-dynamic";

/**
 * Settings > eTIMS.
 *
 * Two gates, and they mean different things. The module licence says the
 * company has bought eTIMS; the switch on this page says whether it is running.
 * A company that has paid but has not finished registering with KRA needs to
 * sit in the second state without anything transmitting.
 */
export default async function EtimsSettingsPage() {
  const { companyId, principal } = await requireTenant();

  if (!principal.enabledModules.has("ETIMS")) return <ModuleLocked module="ETIMS" />;
  if (!can(principal, "etims:configure")) notFound();

  const [config, creds, productsWithoutClassification, customersWithoutPin, company] =
    await Promise.all([
      db.etimsConfig.findUnique({ where: { companyId } }),
      // Only ever used to answer "is a key stored, and for which PIN". The key
      // itself is not returned to the page.
      resolveEtimsCredentials(companyId),
      db.product.count({ where: { companyId, active: true, etimsItemClassCode: null } }),
      db.customer.count({ where: { companyId, taxPin: null } }),
      db.company.findUniqueOrThrow({ where: { id: companyId }, select: { taxPin: true } }),
    ]);

  return (
    <div className="space-y-5">
      <PageHeader
        title="eTIMS"
        breadcrumb={{ href: "/app/settings", label: "Settings" }}
        description="Transmits invoices and credit notes to KRA under this company's own PIN."
      />
      <EtimsForm
        configured={Boolean(creds)}
        storedPin={creds?.taxPin ?? null}
        companyPin={company.taxPin}
        readiness={{ productsWithoutClassification, customersWithoutPin }}
        initial={{
          enabled: config?.enabled ?? false,
          environment: config?.environment ?? "SANDBOX",
          autoTransmit: config?.autoTransmit ?? true,
          activeFrom: config?.activeFrom?.toISOString().slice(0, 10) ?? null,
          defaultItemClassCode: config?.defaultItemClassCode ?? "99000000",
          defaultItemTypeCode: config?.defaultItemTypeCode ?? "2",
          defaultTaxTypeCode: config?.defaultTaxTypeCode ?? "B",
          defaultQuantityUnit: config?.defaultQuantityUnit ?? "U",
          defaultPackageUnit: config?.defaultPackageUnit ?? "NT",
          defaultOriginNation: config?.defaultOriginNation ?? "KE",
          branchName: config?.branchName ?? null,
          lastVerifiedAt: config?.lastVerifiedAt?.toISOString() ?? null,
        }}
      />
    </div>
  );
}
