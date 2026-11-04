import { z } from "zod";

import { ApiError, handler, parseBody } from "@/lib/api";
import { auditAs } from "@/lib/audit";
import { baseUrlFor, digitaxAdapter, isValidKraPin } from "@/lib/etims";
import { db } from "@/lib/db";
import { providerFor, credsFor, testCredentialProblem, type PaymentProviderName } from "@/lib/payments";
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

  // A malformed KRA PIN would be stored, then refused at every transmission.
  // Catch it where it is typed.
  const tin = body.provider === "DIGITAX" ? body.values.DIGITAX_TIN : undefined;
  if (tin !== undefined && !isValidKraPin(tin)) {
    throw new ApiError(
      422,
      "INVALID_KRA_PIN",
      `DIGITAX_TIN "${tin}" is not a valid KRA PIN (expected the form P051234567X)`,
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
    // Three things can be wrong with a Digitax credential, and "keys present"
    // catches none of them: a TIN that is not a KRA PIN, a key Digitax does
    // not accept, and a key that belongs to a different taxpayer than the TIN
    // says. The last one files this company's sales under someone else's
    // registration, so the test asks Digitax whose key it is.
    const get = credsFor(creds);
    const missing = CREDENTIAL_KEYS.DIGITAX.filter((k) => !get(k));
    if (missing.length > 0) {
      const note = `Keys missing: ${missing.join(", ")}`;
      await recordTestResult(companyId, provider, false, note);
      return { ok: false, note };
    }

    const tin = get("DIGITAX_TIN")!.trim();
    if (!isValidKraPin(tin)) {
      const note = `DIGITAX_TIN "${tin}" is not a valid KRA PIN (expected the form P051234567X)`;
      await recordTestResult(companyId, provider, false, note);
      return { ok: false, note };
    }

    const config = await db.etimsConfig.findUnique({
      where: { companyId },
      select: { environment: true },
    });
    const info = await digitaxAdapter.info({
      apiKey: get("DIGITAX_API_KEY")!,
      taxPin: tin,
      baseUrl: baseUrlFor(get("DIGITAX_BASE_URL"), config?.environment),
      branchId: get("DIGITAX_BRANCH_ID"),
    });

    if (!info.ok) {
      const note = `Digitax refused the key: ${info.error ?? "no response"}`;
      await recordTestResult(companyId, provider, false, note);
      return { ok: false, note };
    }

    const reported = typeof info.data?.tax_pin === "string" ? info.data.tax_pin.trim() : null;
    if (reported && reported !== tin) {
      const note = `The key belongs to PIN ${reported}, not ${tin}. Filing with it would use another taxpayer's registration.`;
      await recordTestResult(companyId, provider, false, note);
      return { ok: false, note };
    }

    const branch = typeof info.data?.branch_office_name === "string" ? info.data.branch_office_name : null;
    const note = `Authenticated as ${reported ?? tin}${branch ? ` (${branch})` : ""}`;
    await recordTestResult(companyId, provider, true, note);
    await db.etimsConfig
      .updateMany({
        where: { companyId },
        data: {
          taxPin: reported ?? tin,
          branchName: branch,
          branchId: typeof info.data?.branch_id === "string" ? info.data.branch_id : undefined,
          businessId: typeof info.data?.business_id === "string" ? info.data.business_id : undefined,
          lastVerifiedAt: new Date(),
          lastError: null,
        },
      })
      .catch(() => undefined);
    return { ok: true, note };
  }

  const adapter = providerFor(provider as PaymentProviderName);
  if (!adapter) return { ok: false, note: "No adapter for this provider" };

  // Each adapter proves its own key without moving money: Paystack is asked
  // to verify a reference that cannot exist (a good key is told "not found",
  // a bad one gets 401); Daraja mints a token and then queries an impossible
  // CheckoutRequestID, which exercises the shortcode and passkey as well as
  // the app credentials. A sandbox or test key on a production deployment is
  // reported as a failure even if it authenticates.
  const unfit = testCredentialProblem(provider, creds);
  const result = unfit ? { ok: false, note: unfit } : await adapter.testCredentials(creds);

  await recordTestResult(companyId, provider, result.ok, result.note);
  return result;
});
