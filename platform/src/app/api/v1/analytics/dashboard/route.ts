import { handler } from "@/lib/api";
import { companyIdOf } from "@/lib/tenant";
import { daysAgo, receivablesAgeing, tenantDashboard, territoryPerformance } from "@/server/analytics";
import { repPerformance } from "@/server/field";

export const dynamic = "force-dynamic";

/**
 * Tenant dashboard feed.
 *
 * The core Phase One dashboard is always available. The extra breakdowns —
 * territory performance and rep scorecards — are Module 10 and Module 06
 * deliverables, so they are attached only when licensed rather than returned
 * as empty arrays that would look like a data problem.
 */
export const GET = handler(
  { permission: "report:read" },
  async ({ principal, searchParams }) => {
    const companyId = companyIdOf(principal);
    const days = Math.min(365, Math.max(1, Number(searchParams.get("days") ?? 30)));

    const dashboard = await tenantDashboard(companyId, days);

    const hasAnalytics = principal.enabledModules.has("ANALYTICS");
    const hasFinance = principal.enabledModules.has("FINANCE");
    const hasField = principal.enabledModules.has("FIELD_SALES");

    return {
      period: { days, from: daysAgo(days).toISOString(), to: new Date().toISOString() },
      ...dashboard,
      ageing: hasFinance ? await receivablesAgeing(companyId) : null,
      territories: hasAnalytics ? await territoryPerformance(companyId, days) : null,
      reps: hasField
        ? await repPerformance(companyId, daysAgo(days), new Date())
        : null,
    };
  },
);
