import "server-only";

import crypto from "node:crypto";

/**
 * Per-tenant credential encryption.
 *
 * Gateway secrets used to live only in the environment, which meant every
 * company collected into one merchant account. Holding them per company means
 * holding them in the database — so they are encrypted, and the key is not.
 *
 * AES-256-GCM, with the **company id bound in as additional authenticated
 * data**. That is the part worth understanding: a cipher text lifted out of one
 * tenant's row and pasted into another's fails to decrypt rather than quietly
 * handing the second tenant the first one's Paystack key. Row-level tenancy
 * mistakes are the likeliest way this goes wrong, so the cryptography is made
 * to catch them rather than trusting the query.
 *
 * The master key lives in `CREDENTIALS_KEY`. A database dump on its own is
 * therefore inert.
 */

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12; // 96 bits, the GCM standard

export interface SealedSecret {
  cipherText: string;
  iv: string;
  authTag: string;
}

/** Thrown when the deployment has no usable key. Never carries key material. */
export class SecretsUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretsUnavailableError";
  }
}

function masterKey(): Buffer | null {
  const raw = process.env.CREDENTIALS_KEY;
  if (!raw) return null;

  let key: Buffer;
  try {
    key = Buffer.from(raw, "base64");
  } catch {
    return null;
  }
  // A short key would still "work" in the sense of not throwing here, and would
  // silently weaken everything, so the length is a hard requirement.
  return key.length === KEY_BYTES ? key : null;
}

/**
 * Whether this deployment can store tenant credentials at all.
 *
 * Callers use this to report a feature as unconfigured rather than throwing at
 * the moment an admin tries to save a key — a configuration gap should be
 * visible before someone types a secret into a form that cannot keep it.
 */
export function secretsAvailable(): boolean {
  return masterKey() !== null;
}

/** Generates a key suitable for CREDENTIALS_KEY. Used by tooling, not at runtime. */
export function generateMasterKey(): string {
  return crypto.randomBytes(KEY_BYTES).toString("base64");
}

export function encryptFor(companyId: string, plaintext: string): SealedSecret {
  const key = masterKey();
  if (!key) {
    throw new SecretsUnavailableError(
      "CREDENTIALS_KEY is not set, so tenant credentials cannot be stored.",
    );
  }

  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(Buffer.from(companyId, "utf8"));

  const cipherText = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);

  return {
    cipherText: cipherText.toString("base64"),
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
  };
}

/**
 * Returns null when the secret cannot be authenticated — a wrong key, a
 * tampered row, or a blob belonging to a different company. Callers treat that
 * as "not configured", which fails closed.
 */
export function decryptFor(companyId: string, sealed: SealedSecret): string | null {
  const key = masterKey();
  if (!key) return null;

  try {
    const decipher = crypto.createDecipheriv(
      ALGORITHM,
      key,
      Buffer.from(sealed.iv, "base64"),
    );
    decipher.setAAD(Buffer.from(companyId, "utf8"));
    decipher.setAuthTag(Buffer.from(sealed.authTag, "base64"));

    return Buffer.concat([
      decipher.update(Buffer.from(sealed.cipherText, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    // GCM raises on a failed tag check. That is the whole point of it, and the
    // reason is never reported outward: it would tell an attacker which of the
    // key, the tag or the AAD was wrong.
    return null;
  }
}

/** Convenience for credential bundles, which are objects rather than strings. */
export function sealJson(companyId: string, value: unknown): SealedSecret {
  return encryptFor(companyId, JSON.stringify(value));
}

export function openJson<T>(companyId: string, sealed: SealedSecret): T | null {
  const raw = decryptFor(companyId, sealed);
  if (raw == null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Masks a secret for display. The last four characters are kept so an admin can
 * tell which key is loaded without the value ever going back over the wire.
 */
export function maskSecret(value: string): string {
  if (value.length <= 4) return "••••";
  return `••••${value.slice(-4)}`;
}
