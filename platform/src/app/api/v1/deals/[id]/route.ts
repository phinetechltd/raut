import { z } from "zod";

import { handler, parseBody } from "@/lib/api";
import { auditAs } from "@/lib/audit";
import { updateDeal } from "@/server/crm";

export const dynamic = "force-dynamic";

const schema = z.object({
  title: z.string().min(2).optional(),
  customerId: z.string().nullable().optional(),
  valueCents: z.number().int().min(0).optional(),
  probability: z.number().int().min(0).max(100).nullable().optional(),
  expectedCloseAt: z.string().nullable().optional(),
  ownerId: z.string().nullable().optional(),
});

export const PATCH = handler<{ id: string }>({ permission: "deal:write" }, async ({ principal, params, request }) => {
  const input = await parseBody(request, schema);
  const deal = await updateDeal(principal, params.id, input);
  await auditAs(principal, "UPDATE", "Deal", deal.id, input as Record<string, unknown>, request);
  return deal;
});
