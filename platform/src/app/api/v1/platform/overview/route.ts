import { forbidden, handler } from "@/lib/api";
import { db } from "@/lib/db";
import { FULL_PLATFORM_PRICE_CENTS, MODULE_CATALOG, type ModuleKey } from "@/lib/modules";
import { platformOverview } from "@/server/analytics";

export const dynamic = "force-dynamic";

/** Feeds the Super Admin dashboard illustrated on proposal page 5. */
export const GET = handler({ allowPlatform: true }, async ({ principal }) => {
  if (principal.role !== "SUPER_ADMIN") throw forbidden();

  const overview = await platformOverview();

  const recentAudit = await db.auditLog.findMany({
    orderBy: { createdAt: "desc" },
    take: 15,
    include: {
      user: { select: { name: true } },
      company: { select: { name: true } },
    },
  });

  return {
    ...overview,
    fullPlatformPriceCents: FULL_PLATFORM_PRICE_CENTS,
    moduleCounts: overview.moduleCounts.map((m) => ({
      ...m,
      name: MODULE_CATALOG[m.moduleKey as ModuleKey]?.name ?? m.moduleKey,
    })),
    recentAudit,
  };
});
