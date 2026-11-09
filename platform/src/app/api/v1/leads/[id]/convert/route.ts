import { z } from "zod";

import { handler, ok, parseBody } from "@/lib/api";
import { auditAs } from "@/lib/audit";
import { convertLead } from "@/server/crm";

export const dynamic = "force-dynamic";

const schema = z.object({
  createDeal: z.boolean().optional(),
  dealTitle: z.string().optional(),
  dealValueCents: z.number().int().min(0).optional(),
});

export const POST = handler<{ id: string }>({ permission: "lead:write" }, async ({ principal, params, request }) => {
  const input = await parseBody(request, schema).catch(() => ({}));
  const result = await convertLead(principal, params.id, input);
  await auditAs(principal, "UPDATE", "Lead", params.id, { converted: result.customer.id }, request);
  return ok(result, undefined, { status: 201 });
});
