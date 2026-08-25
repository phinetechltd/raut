import { z } from "zod";

import { ApiError, handler, parseBody } from "@/lib/api";
import { auditAs } from "@/lib/audit";
import { providerFor, credsFor, type PaymentProviderName } from "@/lib/payments";
import { secretsAvailable } from "@/lib/secrets";
import { companyIdOf } from "@/lib/tenant";
import {
  CREDENTIAL_KEYS,
  OPTIONAL_KEYS,
  deleteCredential,
  listCredentials,
  recordTestResult,
  resolveCredentials,
  saveCredential,
  setCredentialActive,
  type CredentialProvider,
} from "@/server/credentials";

export const dynamic = "force-dynamic";

const PROVIDERS = ["PAYSTACK", "MPESA_DARAJA", "KCB_BUNI", "DIGITAX"] as const;

/**
 * A company's own gateway and tax credentials.
 *
 * The response never carries a secret — only which providers are configured, a
 * masked hint, and the last test result. There is deliberately no read endpoint
 * that returns a stored key: an admin who has lost one replaces it rather than
 * retrieving it, which means a compromised session cannot exfiltrate a
 * merchant account.
 */
export const GET = handler({ permission: "settings:write" }, async ({ principal }) => {
  const companyId = companyIdOf(principal);
  const stored = await listCredentials(companyId);

  return {
    /** False when the deployment has no master key; the UI explains rather than failing on save. */
    vaultAvailable: secretsAvailable(),
    providers: PROVIDERS.map((name) => {
      const row = stored.find((s) => s.provider === name);
      return {
        provider: name,
        requiredKeys: CREDENTIAL_KEYS[name],
        optionalKeys: OPTIONAL_KEYS[name] ?? [],
        configured: Boolean(row),
        active: row?.active ?? false,
        label: row?.label ?? null,
        lastTestedAt: row?.lastTestedAt ?? null,
        lastTestOk: row?.lastTestOk ?? null,
        lastTestNote: row?.lastTestNote ?? null,
        updatedAt: row?.updatedAt ?? null,
      };
    }),
  };
});

const saveSchema = z.object({
  provider: z.enum(PROVIDERS),
  values: z.record(z.string()),
});

export const POST = handler({ permission: "settings:write" }, async ({ principal, request }) => {
  const body = await parseBody(request, saveSchema);
  const companyId = companyIdOf(principal);

  if (!secretsAvailable()) {
    throw new ApiError(
      503,
      "VAULT_UNAVAILABLE",
      "This deployment has no CREDENTIALS_KEY, so credentials cannot be stored securely.",
    );
  }

  try {
    await saveCredential({
      companyId,
      provider: body.provider as CredentialProvider,
      values: body.values,
      updatedById: principal.userId,
    });
  } catch (error) {
    throw new ApiError(
      422,
      "INVALID_CREDENTIALS",
      error instanceof Error ? error.message : "Could not save these credentials",
    );
  }

  // The values are never echoed back, and never enter the audit trail — an
  // audit log that records secrets is just a second copy of them.
  await auditAs(
    principal,
    "UPDATE",
    "TenantCredential",
    body.provider,
    { provider: body.provider, keys: Object.keys(body.values).sort() },
    request,
  );

  return { ok: true };
});

const patchSchema = z.object({
  provider: z.enum(PROVIDERS),
  action: z.enum(["activate", "deactivate", "test", "delete"]),
});

export const PATCH = handler({ permission: "settings:write" }, async ({ principal, request }) => {
  const body = await parseBody(request, patchSchema);
  const companyId = companyIdOf(principal);
  const provider = body.provider as CredentialProvider;

  if (body.action === "delete") {
    await deleteCredential(companyId, provider);
    await auditAs(principal, "DELETE", "TenantCredential", provider, { provider }, request);
    return { ok: true };
  }

  if (body.action !== "test") {
    await setCredentialActive(companyId, provider, body.action === "activate");
    await auditAs(
      principal,
      body.action === "activate" ? "ACTIVATE" : "SUSPEND",
      "TenantCredential",
      provider,
      { provider },
      request,
    );
    return { ok: true };
  }

  // Test: prove the stored key actually authenticates, before a rep discovers
  // it does not while standing at a counter.
  const creds = await resolveCredentials(companyId, provider);
  if (!creds) {
    await recordTestResult(companyId, provider, false, "Stored credentials could not be read");
    return { ok: false, note: "Stored credentials could not be read" };
  }

  if (provider === "DIGITAX") {
    const ready = CREDENTIAL_KEYS.DIGITAX.every((k) => credsFor(creds)(k));
    await recordTestResult(companyId, provider, ready, ready ? "Keys present" : "Keys missing");
    return { ok: ready, note: ready ? "Keys present" : "Keys missing" };
  }

  const adapter = providerFor(provider as PaymentProviderName);
  if (!adapter) return { ok: false, note: "No adapter for this provider" };

  // verify() on a reference that cannot exist: it exercises authentication
  // without creating a charge. A credential problem surfaces as an auth error;
  // a good credential simply reports the transaction as unknown.
  const verdict = await adapter.verify("raut-credential-test", creds);
  const note = verdict.failureReason ?? `Reachable (${verdict.status})`;
  const ok = !/not configured|could not authenticate|invalid|unauthor/i.test(note);

  await recordTestResult(companyId, provider, ok, note);
  return { ok, note };
});
