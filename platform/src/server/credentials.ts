import "server-only";

import { db } from "@/lib/db";
import {
  REQUIRED_KEYS,
  type Creds,
  type PaymentProviderName,
} from "@/lib/payments";
import {
  maskSecret,
  openJson,
  sealJson,
  secretsAvailable,
} from "@/lib/secrets";

/**
 * Reading and writing a company's own gateway and tax credentials.
 *
 * The plaintext never leaves this module in the outward direction: nothing here
 * returns a secret to a caller that might serialise it into a response. What
 * goes back to the console is a masked hint and a configured/not flag, which is
 * everything an admin needs to know that the right account is wired up.
 */

export type CredentialProvider = PaymentProviderName | "DIGITAX";

/** Keys each provider expects. Digitax joins the payment providers here. */
export const CREDENTIAL_KEYS: Record<CredentialProvider, string[]> = {
  ...REQUIRED_KEYS,
  DIGITAX: ["DIGITAX_API_KEY", "DIGITAX_API_SECRET", "DIGITAX_TIN"],
};

/** Optional keys accepted but not required, e.g. environment switches. */
export const OPTIONAL_KEYS: Partial<Record<CredentialProvider, string[]>> = {
  PAYSTACK: ["PAYSTACK_PUBLIC_KEY", "PAYSTACK_BASE_URL"],
  MPESA_DARAJA: ["MPESA_ENV", "MPESA_TRANSACTION_TYPE", "MPESA_PARTY_B"],
  KCB_BUNI: ["KCB_ENV", "KCB_BASE_URL", "KCB_WEBHOOK_SECRET"],
  DIGITAX: ["DIGITAX_ENV", "DIGITAX_BASE_URL", "DIGITAX_BRANCH_ID"],
};

/**
 * A company's credentials for one provider, decrypted.
 *
 * Returns null when nothing is stored, when the deployment has no master key,
 * or when the stored blob fails authentication — all of which mean the same
 * thing to a caller: this company has no usable credentials, fall back to the
 * environment. Failing closed is deliberate; a half-decrypted bundle would be
 * worse than none.
 */
export async function resolveCredentials(
  companyId: string,
  provider: CredentialProvider,
): Promise<Creds | null> {
  if (!secretsAvailable()) return null;

  const row = await db.tenantCredential.findUnique({
    where: { companyId_provider: { companyId, provider } },
  });
  if (!row || !row.active) return null;

  return openJson<Creds>(companyId, {
    cipherText: row.cipherText,
    iv: row.iv,
    authTag: row.authTag,
  });
}

/** All payment credentials for a company, for `availableProviders`. */
export async function resolvePaymentCredentials(companyId: string) {
  const names: PaymentProviderName[] = ["PAYSTACK", "MPESA_DARAJA", "KCB_BUNI"];
  const entries = await Promise.all(
    names.map(async (n) => [n, await resolveCredentials(companyId, n)] as const),
  );
  return Object.fromEntries(
    entries.filter(([, creds]) => creds !== null),
  ) as Partial<Record<PaymentProviderName, Creds>>;
}

export interface SaveCredentialInput {
  companyId: string;
  provider: CredentialProvider;
  /** Plain values keyed by the provider's key names. */
  values: Record<string, string>;
  updatedById?: string | null;
}

/**
 * Stores a credential bundle, encrypted.
 *
 * Blank values are dropped rather than saved, so an admin can leave the
 * optional fields empty without writing empty strings that would later look
 * like a configured-but-broken gateway.
 */
export async function saveCredential(input: SaveCredentialInput) {
  if (!secretsAvailable()) {
    throw new Error(
      "This deployment has no CREDENTIALS_KEY, so credentials cannot be stored securely.",
    );
  }

  const allowed = new Set([
    ...(CREDENTIAL_KEYS[input.provider] ?? []),
    ...(OPTIONAL_KEYS[input.provider] ?? []),
  ]);

  const values: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.values)) {
    if (allowed.has(k) && typeof v === "string" && v.trim().length > 0) {
      values[k] = v.trim();
    }
  }

  const missing = (CREDENTIAL_KEYS[input.provider] ?? []).filter((k) => !values[k]);
  if (missing.length > 0) {
    throw new Error(`Missing required values: ${missing.join(", ")}`);
  }

  const sealed = sealJson(input.companyId, values);

  // The hint is built from whichever key most identifies the account, so an
  // admin can tell two Paystack accounts apart without seeing either secret.
  const primary = values[CREDENTIAL_KEYS[input.provider][0]] ?? "";

  return db.tenantCredential.upsert({
    where: {
      companyId_provider: { companyId: input.companyId, provider: input.provider },
    },
    create: {
      companyId: input.companyId,
      provider: input.provider,
      ...sealed,
      label: maskSecret(primary),
      active: true,
      updatedById: input.updatedById ?? null,
    },
    update: {
      ...sealed,
      label: maskSecret(primary),
      active: true,
      updatedById: input.updatedById ?? null,
      lastTestedAt: null,
      lastTestOk: null,
      lastTestNote: null,
    },
  });
}

/** What the console may see: never a secret, only whether one is present. */
export async function listCredentials(companyId: string) {
  const rows = await db.tenantCredential.findMany({
    where: { companyId },
    select: {
      provider: true,
      label: true,
      active: true,
      lastTestedAt: true,
      lastTestOk: true,
      lastTestNote: true,
      updatedAt: true,
    },
  });
  return rows;
}

export async function setCredentialActive(
  companyId: string,
  provider: CredentialProvider,
  active: boolean,
) {
  return db.tenantCredential.update({
    where: { companyId_provider: { companyId, provider } },
    data: { active },
  });
}

export async function deleteCredential(
  companyId: string,
  provider: CredentialProvider,
) {
  return db.tenantCredential.delete({
    where: { companyId_provider: { companyId, provider } },
  });
}

export async function recordTestResult(
  companyId: string,
  provider: CredentialProvider,
  ok: boolean,
  note: string,
) {
  return db.tenantCredential.update({
    where: { companyId_provider: { companyId, provider } },
    data: { lastTestedAt: new Date(), lastTestOk: ok, lastTestNote: note.slice(0, 300) },
  });
}
