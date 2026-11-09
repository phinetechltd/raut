import { z } from "zod";

import { handler, parseBody } from "@/lib/api";
import { auditAs } from "@/lib/audit";
import { updateLead } from "@/server/crm";

export const dynamic = "force-dynamic";

const schema = z.object({
  name: z.string().min(2).optional(),
  contactName: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  email: z.string().email().nullable().optional(),
  source: z.enum(["REFERRAL", "WEB", "FIELD", "CALL", "EVENT", "OTHER"]).nullable().optional(),
  status: z.enum(["NEW", "WORKING", "CONVERTED", "DISCARDED"]).optional(),
  ownerId: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
});

export const PATCH = handler<{ id: string }>({ permission: "lead:write" }, async ({ principal, params, request }) => {
  const input = await parseBody(request, schema);
  const lead = await updateLead(principal, params.id, input);
  await auditAs(principal, "UPDATE", "Lead", lead.id, input as Record<string, unknown>, request);
  return lead;
});
