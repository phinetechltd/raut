import "server-only";

import { db } from "@/lib/db";
import {
  REQUIRED_KEYS,
  baseUrlProblem,
  testCredentialProblem,
  type Creds,
  type PaymentProviderName,
} from "@/lib/payments";
import { baseUrlFor, type EtimsCredentials } from "@/lib/etims";
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
  DIGITAX: ["DIGITAX_API_KEY", "DIGITAX_TIN"],
};

/** Optional keys accepted but not required, e.g. environment switches. */
export const OPTIONAL_KEYS: Partial<Record<CredentialProvider, string[]>> = {
  PAYSTACK: ["PAYSTACK_PUBLIC_KEY", "PAYSTACK_BASE_URL"],
  MPESA_DARAJA: ["MPESA_ENV", "MPESA_TRANSACTION_TYPE", "MPESA_PARTY_B", "MPESA_BASE_URL"],
  KCB_BUNI: ["KCB_ENV", "KCB_BASE_URL", "KCB_WEBHOOK_SECRET"],
  DIGITAX: ["DIGITAX_BASE_URL", "DIGITAX_BRANCH_ID"],
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

/** The stored bundle whether or not it is active — for merging on save only. */
async function storedCredentials(companyId: string, provider: CredentialProvider): Promise<Creds | null> {
  if (!secretsAvailable()) return null;
  const row = await db.tenantCredential.findUnique({
    where: { companyId_provider: { companyId, provider } },
  });
  if (!row) return null;
  return openJson<Creds>(companyId, { cipherText: row.cipherText, iv: row.iv, authTag: row.authTag });
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

/**
 * A company's eTIMS credentials, or null.
 *
 * Deliberately NOT `credsFor()`. That helper falls back to `process.env`, which
 * is right for a payment gateway the platform may run centrally and wrong — in
 * a way that is only ever discovered by the revenue authority — for a tax
 * filing. There is no shared eTIMS account: a company with no stored key is not
 * configured, and nothing is transmitted on its behalf.
 *
 * The base URL is read from env when the company has not set one, because a
 * host is not an identity.
 */
export async function resolveEtimsCredentials(
  companyId: string,
): Promise<EtimsCredentials | null> {
  const creds = await resolveCredentials(companyId, "DIGITAX");
  if (!creds) return null;

  const apiKey = creds.DIGITAX_API_KEY;
  const taxPin = creds.DIGITAX_TIN;
  if (!apiKey || !taxPin) return null;

  return {
    apiKey,
    taxPin,
    baseUrl: baseUrlFor(creds.DIGITAX_BASE_URL),
    branchId: creds.DIGITAX_BRANCH_ID,
  };
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
 * like a configured-but-broken gateway. When a bundle already exists, an
 * optional key left blank keeps its stored value: "Replace keys" with a new
 * secret must not silently reset MPESA_ENV to the default or drop a webhook
 * secret the admin set last month. Required keys are always taken from the
 * form — replacing them is the point of the action.
 *
 * Two refusals happen here rather than at the provider: a base URL that is
 * not an official gateway host (the bundle is where this server sends a
 * merchant secret, so an arbitrary host is an exfiltration channel), and a
 * test key or sandbox switch on a production deployment.
 */
export async function saveCredential(input: SaveCredentialInput) {
  if (!secretsAvailable()) {
    throw new Error(
      "This deployment has no CREDENTIALS_KEY, so credentials cannot be stored securely.",
    );
  }

  const required = CREDENTIAL_KEYS[input.provider] ?? [];
  const optional = OPTIONAL_KEYS[input.provider] ?? [];
  const allowed = new Set([...required, ...optional]);

  const values: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.values)) {
    if (allowed.has(k) && typeof v === "string" && v.trim().length > 0) {
      values[k] = v.trim();
    }
  }

  // Merge: optional keys the form left blank keep what is stored. Read
  // server-side, so the browser never sees the current values.
  const current = await storedCredentials(input.companyId, input.provider);
  if (current) {
    for (const k of optional) {
      if (!values[k] && current[k]) values[k] = current[k]!;
    }
  }

  const missing = required.filter((k) => !values[k]);
  if (missing.length > 0) {
    throw new Error(`Missing required values: ${missing.join(", ")}`);
  }

  for (const k of optional) {
    if (values[k] && k.endsWith("_BASE_URL")) {
      const problem = baseUrlProblem(k, values[k]);
      if (problem) throw new Error(problem);
    }
  }

  const unfit = testCredentialProblem(input.provider, values);
  if (unfit) throw new Error(unfit);

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
