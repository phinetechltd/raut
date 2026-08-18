import { z } from "zod";

import { fail, ok, parseBody } from "@/lib/api";
import {
  ACCESS_TTL_MIN,
  claimsForUser,
  issueRefreshToken,
  setSessionCookie,
  signAccessToken,
  verifyPassword,
} from "@/lib/auth";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { MODULE_CATALOG, type ModuleKey } from "@/lib/modules";
import { owningModule, permissionsForRole, type Role } from "@/lib/rbac";

export const dynamic = "force-dynamic";

const schema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  /** Present when signing in from the Flutter app. */
  device: z
    .object({
      deviceId: z.string().min(4),
      platform: z.string(),
      model: z.string().optional(),
      appVersion: z.string().optional(),
      pushToken: z.string().optional(),
    })
    .optional(),
});

export async function POST(request: Request) {
  const body = await parseBody(request, schema).catch(() => null);
  if (!body) return fail(422, "VALIDATION_FAILED", "Email and password are required");

  const user = await db.user.findUnique({
    where: { email: body.email.toLowerCase() },
    include: { company: true, branch: true },
  });

  // Same response whether the address is unknown or the password is wrong —
  // distinguishing them turns the login form into an account enumerator.
  const invalid = () =>
    fail(401, "INVALID_CREDENTIALS", "Email or password is incorrect");

  if (!user) {
    await verifyPassword(body.password, "$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinva");
    return invalid();
  }

  if (!(await verifyPassword(body.password, user.passwordHash))) {
    await audit({
      companyId: user.companyId,
      userId: user.id,
      action: "LOGIN_FAILED",
      entity: "User",
      entityId: user.id,
      request,
    });
    return invalid();
  }

  if (user.status !== "ACTIVE") {
    return fail(403, "ACCOUNT_INACTIVE", "This account has been deactivated");
  }
  if (user.companyId && user.company?.status !== "ACTIVE") {
    return fail(
      403,
      "COMPANY_INACTIVE",
      "Your company's subscription is not active. Contact your administrator.",
    );
  }

  const claims = await claimsForUser(user.id);
  if (!claims) return invalid();

  const accessToken = await signAccessToken(claims);
  await setSessionCookie(claims);

  let refreshToken: string | null = null;
  if (body.device) {
    await db.device.upsert({
      where: { deviceId: body.device.deviceId },
      create: {
        userId: user.id,
        deviceId: body.device.deviceId,
        platform: body.device.platform,
        model: body.device.model ?? null,
        appVersion: body.device.appVersion ?? null,
        pushToken: body.device.pushToken ?? null,
        lastSeenAt: new Date(),
      },
      update: {
        userId: user.id,
        platform: body.device.platform,
        model: body.device.model ?? null,
        appVersion: body.device.appVersion ?? null,
        pushToken: body.device.pushToken ?? null,
        lastSeenAt: new Date(),
      },
    });
    refreshToken = await issueRefreshToken(user.id, body.device.deviceId);
  }

  await db.user.update({
    where: { id: user.id },
    data: { lastLoginAt: new Date() },
  });

  await audit({
    companyId: user.companyId,
    userId: user.id,
    action: "LOGIN",
    entity: "User",
    entityId: user.id,
    changes: { channel: body.device ? "mobile" : "console" },
    request,
  });

  const licences = user.companyId
    ? await db.companyModule.findMany({
        where: { companyId: user.companyId, enabled: true },
        select: { moduleKey: true },
      })
    : [];

  const modules = licences.map((l) => l.moduleKey);

  return ok({
    accessToken,
    refreshToken,
    expiresIn: ACCESS_TTL_MIN * 60,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      role: user.role,
      branchId: user.branchId,
      branchName: user.branch?.name ?? null,
    },
    company: user.company
      ? {
          id: user.company.id,
          name: user.company.name,
          slug: user.company.slug,
          currency: user.company.currency,
          latitude: user.company.latitude,
          longitude: user.company.longitude,
        }
      : null,
    modules,
    moduleDetails: modules.map((k) => ({
      key: k,
      name: MODULE_CATALOG[k as ModuleKey]?.name ?? k,
    })),
    // Permissions belonging to unlicensed modules are stripped here, so the
    // client never renders a button the server would refuse.
    permissions: permissionsForRole(user.role as Role).filter((p) => {
      const owner = owningModule(p);
      return owner === null || modules.includes(owner);
    }),
  });
}
