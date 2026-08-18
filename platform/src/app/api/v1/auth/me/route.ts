import { handler } from "@/lib/api";
import { db } from "@/lib/db";
import { MODULE_CATALOG, type ModuleKey } from "@/lib/modules";
import { owningModule, permissionsForRole, ROLE_LABELS, type Role } from "@/lib/rbac";
import { seatUsage } from "@/lib/tenant";

export const dynamic = "force-dynamic";

/**
 * Current principal, live licences and effective permissions.
 *
 * The mobile app calls this on resume so a module revoked overnight takes
 * effect without waiting for the token to expire.
 */
export const GET = handler({ allowPlatform: true }, async ({ principal }) => {
  const user = await db.user.findUniqueOrThrow({
    where: { id: principal.userId },
    include: { company: true, branch: true },
  });

  const modules = [...principal.enabledModules];

  return {
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      role: user.role,
      roleLabel: ROLE_LABELS[user.role as Role],
      branchId: user.branchId,
      branchName: user.branch?.name ?? null,
      avatarUrl: user.avatarUrl,
    },
    company: user.company
      ? {
          id: user.company.id,
          name: user.company.name,
          slug: user.company.slug,
          currency: user.company.currency,
          taxPin: user.company.taxPin,
          latitude: user.company.latitude,
          longitude: user.company.longitude,
          seats: await seatUsage(user.company.id),
        }
      : null,
    modules,
    moduleDetails: modules.map((k) => ({
      key: k,
      name: MODULE_CATALOG[k as ModuleKey]?.name ?? k,
      ordinal: MODULE_CATALOG[k as ModuleKey]?.ordinal ?? "",
    })),
    permissions: permissionsForRole(user.role as Role).filter((p) => {
      if (user.role === "SUPER_ADMIN") return true;
      const owner = owningModule(p);
      return owner === null || modules.includes(owner);
    }),
  };
});
