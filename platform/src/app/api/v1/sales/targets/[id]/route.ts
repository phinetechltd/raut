import { z } from "zod";

import { handler, ok, parseBody } from "@/lib/api";
import { auditAs } from "@/lib/audit";
import { deleteTarget, updateTarget } from "@/server/targets";

export const dynamic = "force-dynamic";

const schema = z.object({
  repId: z.string().nullable().optional(),
  territoryId: z.string().nullable().optional(),
  period: z.enum(["MONTHLY", "QUARTERLY", "ANNUAL"]).optional(),
  periodStart: z.string().optional(),
  periodEnd: z.string().optional(),
  targetSalesCents: z.number().int().min(0).optional(),
  targetCollectionCents: z.number().int().min(0).optional(),
  targetVisits: z.number().int().min(0).optional(),
  targetNewCustomers: z.number().int().min(0).optional(),
  commissionRateBp: z.number().int().min(0).max(10_000).optional(),
});

export const PATCH = handler<{ id: string }>({ permission: "target:write" }, async ({ principal, params, request }) => {
  const input = await parseBody(request, schema);
  const target = await updateTarget(principal, params.id, input);
  await auditAs(principal, "UPDATE", "SalesTarget", target.id, input as Record<string, unknown>, request);
  return target;
});

export const DELETE = handler<{ id: string }>({ permission: "target:write" }, async ({ principal, params, request }) => {
  await deleteTarget(principal, params.id);
  await auditAs(principal, "DELETE", "SalesTarget", params.id, {}, request);
  return ok({ deleted: true });
});
