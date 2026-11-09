import { z } from "zod";

import { handler, ok, parseBody } from "@/lib/api";
import { auditAs } from "@/lib/audit";
import { createTarget, listTargets, targetAchievement } from "@/server/targets";

export const dynamic = "force-dynamic";

export const GET = handler({ permission: "target:write" }, async ({ principal, searchParams }) => {
  if (searchParams.get("achievement") === "1") {
    return targetAchievement(principal, { current: searchParams.get("current") === "1" });
  }
  return listTargets(principal, { repId: searchParams.get("repId") ?? undefined });
});

const schema = z.object({
  repId: z.string().nullable().optional(),
  territoryId: z.string().nullable().optional(),
  period: z.enum(["MONTHLY", "QUARTERLY", "ANNUAL"]).optional(),
  periodStart: z.string(),
  periodEnd: z.string(),
  targetSalesCents: z.number().int().min(0).optional(),
  targetCollectionCents: z.number().int().min(0).optional(),
  targetVisits: z.number().int().min(0).optional(),
  targetNewCustomers: z.number().int().min(0).optional(),
  commissionRateBp: z.number().int().min(0).max(10_000).optional(),
});

export const POST = handler({ permission: "target:write" }, async ({ principal, request }) => {
  const input = await parseBody(request, schema);
  const target = await createTarget(principal, input);
  await auditAs(principal, "CREATE", "SalesTarget", target.id, { repId: target.repId, period: target.period }, request);
  return ok(target, undefined, { status: 201 });
});
