import { notFound } from "next/navigation";

import { PageHeader } from "@/components/ui";
import { can } from "@/lib/rbac";
import { secretsAvailable } from "@/lib/secrets";
import { requireTenant } from "@/lib/session";
import {
  CREDENTIAL_KEYS,
  OPTIONAL_KEYS,
  listCredentials,
} from "@/server/credentials";

import { CredentialsForm, type ProviderState } from "./credentials-form";

export const dynamic = "force-dynamic";

const PROVIDERS = ["MPESA_DARAJA", "PAYSTACK", "KCB_BUNI", "DIGITAX"] as const;

/**
 * Settings → Payments & Tax.
 *
 * Rendered on the server so the stored state arrives with the page, but no
 * secret is ever part of that payload — only whether one exists and its masked
 * hint. See src/server/credentials.ts for why there is no read path at all.
 */
export default async function PaymentSettingsPage() {
  const { companyId, principal } = await requireTenant();

  // The API already refuses a rep, but the page must not render either. A form
  // that appears and then fails on save teaches people the system is flaky;
  // 404 rather than 403 keeps the page's existence itself need-to-know.
  if (!can(principal, "settings:write")) notFound();

  const stored = await listCredentials(companyId);

  const initial: ProviderState[] = PROVIDERS.map((name) => {
    const row = stored.find((s) => s.provider === name);
    return {
      provider: name,
      requiredKeys: CREDENTIAL_KEYS[name],
      optionalKeys: OPTIONAL_KEYS[name] ?? [],
      configured: Boolean(row),
      active: row?.active ?? false,
      label: row?.label ?? null,
      lastTestedAt: row?.lastTestedAt?.toISOString() ?? null,
      lastTestOk: row?.lastTestOk ?? null,
      lastTestNote: row?.lastTestNote ?? null,
      updatedAt: row?.updatedAt?.toISOString() ?? null,
    };
  });

  return (
    <>
      <PageHeader
        title="Payments & Tax"
        description="Your own payment gateways and KRA transmission. Keys are encrypted before they are stored and are never shown again."
      />
      <CredentialsForm initial={initial} vaultAvailable={secretsAvailable()} />
    </>
  );
}
