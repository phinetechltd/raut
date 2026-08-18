import "server-only";

import bcrypt from "bcryptjs";
import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { randomBytes, createHash } from "node:crypto";

import { db } from "./db";
import type { Principal, Role } from "./rbac";
import type { Permission } from "./rbac";

/**
 * One credential store, two token shapes.
 *
 *  - Web console: HTTP-only session cookie holding the same JWT.
 *  - Mobile app:  short-lived bearer access token + rotating refresh token
 *                 bound to a Device row, so a lost handset can be cut off
 *                 without forcing every other rep to sign in again.
 *
 * Both decode to the identical claim set, which lets authorization code be
 * written once and used by the console and /api/v1 alike.
 */

const SESSION_COOKIE = "raut_session";

const ACCESS_TTL_MIN = Number(process.env.ACCESS_TOKEN_TTL_MIN ?? 60);
const REFRESH_TTL_DAYS = Number(process.env.REFRESH_TOKEN_TTL_DAYS ?? 30);

function secretKey(): Uint8Array {
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < 24) {
    throw new Error(
      "AUTH_SECRET is missing or too short. Set a value of at least 24 characters.",
    );
  }
  return new TextEncoder().encode(secret);
}

export interface TokenClaims {
  sub: string;
  companyId: string | null;
  role: Role;
  branchId: string | null;
  name: string;
  email: string;
}

// ── passwords ──────────────────────────────────────────────────────────

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 10);
}

export async function verifyPassword(
  plain: string,
  hash: string,
): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

// ── access tokens ──────────────────────────────────────────────────────

export async function signAccessToken(claims: TokenClaims): Promise<string> {
  return new SignJWT({ ...claims })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(claims.sub)
    .setIssuedAt()
    .setIssuer("raut-platform")
    .setExpirationTime(`${ACCESS_TTL_MIN}m`)
    .sign(secretKey());
}

export async function verifyAccessToken(
  token: string,
): Promise<TokenClaims | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey(), {
      issuer: "raut-platform",
    });
    return {
      sub: String(payload.sub),
      companyId: (payload.companyId as string | null) ?? null,
      role: payload.role as Role,
      branchId: (payload.branchId as string | null) ?? null,
      name: String(payload.name ?? ""),
      email: String(payload.email ?? ""),
    };
  } catch {
    return null;
  }
}

// ── refresh tokens (mobile) ────────────────────────────────────────────

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function issueRefreshToken(
  userId: string,
  deviceId?: string | null,
): Promise<string> {
  const token = randomBytes(48).toString("base64url");
  const expiresAt = new Date(Date.now() + REFRESH_TTL_DAYS * 86_400_000);

  // One live refresh token per device: re-authenticating on the same handset
  // supersedes the previous token rather than accumulating grants.
  if (deviceId) {
    await db.refreshToken.updateMany({
      where: { userId, deviceId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  await db.refreshToken.create({
    data: { userId, deviceId: deviceId ?? null, tokenHash: hashToken(token), expiresAt },
  });
  return token;
}

/**
 * Rotates a refresh token. Returns null if the token is unknown, expired or
 * already revoked — a replayed token is treated as invalid, not renewed.
 */
export async function rotateRefreshToken(
  token: string,
): Promise<{ userId: string; refreshToken: string } | null> {
  const row = await db.refreshToken.findUnique({
    where: { tokenHash: hashToken(token) },
  });
  if (!row || row.revokedAt || row.expiresAt < new Date()) return null;

  await db.refreshToken.update({
    where: { id: row.id },
    data: { revokedAt: new Date() },
  });
  const next = await issueRefreshToken(row.userId, row.deviceId);
  return { userId: row.userId, refreshToken: next };
}

export async function revokeRefreshToken(token: string): Promise<void> {
  await db.refreshToken
    .updateMany({
      where: { tokenHash: hashToken(token), revokedAt: null },
      data: { revokedAt: new Date() },
    })
    .catch(() => undefined);
}

// ── console session cookie ─────────────────────────────────────────────

export async function setSessionCookie(claims: TokenClaims): Promise<void> {
  const token = await signAccessToken(claims);
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: ACCESS_TTL_MIN * 60,
  });
}

export async function clearSessionCookie(): Promise<void> {
  const jar = await cookies();
  jar.delete(SESSION_COOKIE);
}

export async function readSessionClaims(): Promise<TokenClaims | null> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return verifyAccessToken(token);
}

// ── principal resolution ───────────────────────────────────────────────

/**
 * Turns claims into a Principal by loading the company's live module licences.
 * Licences are read per request rather than baked into the token so that
 * revoking a module takes effect immediately instead of at next sign-in.
 */
export async function principalFromClaims(
  claims: TokenClaims,
): Promise<Principal | null> {
  const user = await db.user.findUnique({
    where: { id: claims.sub },
    select: {
      id: true,
      companyId: true,
      branchId: true,
      role: true,
      status: true,
      extraPermissions: true,
      company: { select: { status: true } },
    },
  });

  if (!user || user.status !== "ACTIVE") return null;
  // A suspended tenant loses access even while holding a valid token.
  if (user.companyId && user.company?.status !== "ACTIVE") return null;

  const enabledModules = new Set<string>();
  if (user.companyId) {
    const licences = await db.companyModule.findMany({
      where: { companyId: user.companyId, enabled: true },
      select: { moduleKey: true },
    });
    for (const l of licences) enabledModules.add(l.moduleKey);
  }

  let extra: Permission[] = [];
  try {
    const parsed = JSON.parse(user.extraPermissions || "[]");
    if (Array.isArray(parsed)) extra = parsed as Permission[];
  } catch {
    extra = [];
  }

  return {
    userId: user.id,
    companyId: user.companyId,
    branchId: user.branchId,
    role: user.role as Role,
    extraPermissions: extra,
    enabledModules,
  };
}

/** Console-side principal, resolved from the session cookie. */
export async function getSessionPrincipal(): Promise<Principal | null> {
  const claims = await readSessionClaims();
  if (!claims) return null;
  return principalFromClaims(claims);
}

/** API-side principal, resolved from an Authorization: Bearer header. */
export async function getBearerPrincipal(
  request: Request,
): Promise<Principal | null> {
  const header = request.headers.get("authorization");
  if (!header?.toLowerCase().startsWith("bearer ")) return null;
  const claims = await verifyAccessToken(header.slice(7).trim());
  if (!claims) return null;
  return principalFromClaims(claims);
}

/**
 * Accepts either credential. The console fetches its own API routes with the
 * cookie; the Flutter app sends a bearer token.
 */
export async function getPrincipal(request: Request): Promise<Principal | null> {
  return (await getBearerPrincipal(request)) ?? (await getSessionPrincipal());
}

export async function claimsForUser(userId: string): Promise<TokenClaims | null> {
  const user = await db.user.findUnique({ where: { id: userId } });
  if (!user) return null;
  return {
    sub: user.id,
    companyId: user.companyId,
    role: user.role as Role,
    branchId: user.branchId,
    name: user.name,
    email: user.email,
  };
}

export { ACCESS_TTL_MIN, REFRESH_TTL_DAYS, SESSION_COOKIE };
