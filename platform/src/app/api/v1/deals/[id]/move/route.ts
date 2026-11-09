import { z } from "zod";

import { handler, parseBody } from "@/lib/api";
import { auditAs } from "@/lib/audit";
import { moveDeal } from "@/server/crm";

export const dynamic = "force-dynamic";

const schema = z.object({
  stageId: z.string().min(1),
  lostReason: z.string().optional(),
});

export const POST = handler<{ id: string }>({ permission: "deal:write" }, async ({ principal, params, request }) => {
  const input = await parseBody(request, schema);
  const deal = await moveDeal(principal, params.id, input.stageId, input.lostReason);
  await auditAs(principal, "UPDATE", "Deal", deal.id, { stage: deal.stageId, status: deal.status }, request);
  return deal;
});
