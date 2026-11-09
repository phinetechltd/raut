import { z } from "zod";

import { handler, ok, parseBody } from "@/lib/api";
import { auditAs } from "@/lib/audit";
import { createDeal, dealBoard, listDeals } from "@/server/crm";

export const dynamic = "force-dynamic";

export const GET = handler({ permission: "deal:read" }, async ({ principal, searchParams }) => {
  if (searchParams.get("board") === "1") return dealBoard(principal);
  return listDeals(principal, {
    status: searchParams.get("status") ?? undefined,
    stageId: searchParams.get("stageId") ?? undefined,
    customerId: searchParams.get("customerId") ?? undefined,
  });
});

const schema = z.object({
  title: z.string().min(2),
  customerId: z.string().nullable().optional(),
  leadId: z.string().nullable().optional(),
  stageId: z.string().optional(),
  valueCents: z.number().int().min(0).optional(),
  probability: z.number().int().min(0).max(100).nullable().optional(),
  expectedCloseAt: z.string().nullable().optional(),
  ownerId: z.string().nullable().optional(),
});

export const POST = handler({ permission: "deal:write" }, async ({ principal, request }) => {
  const input = await parseBody(request, schema);
  const deal = await createDeal(principal, input);
  await auditAs(principal, "CREATE", "Deal", deal.id, { title: deal.title, valueCents: deal.valueCents }, request);
  return ok(deal, undefined, { status: 201 });
});
