import { z } from "zod";

import { handler, ok, parseBody } from "@/lib/api";
import { auditAs } from "@/lib/audit";
import { createLead, listLeads } from "@/server/crm";

export const dynamic = "force-dynamic";

export const GET = handler({ permission: "lead:read" }, async ({ principal, searchParams }) => {
  return listLeads(principal, {
    status: searchParams.get("status") ?? undefined,
    q: searchParams.get("q") ?? undefined,
  });
});

const schema = z.object({
  name: z.string().min(2),
  contactName: z.string().optional().nullable(),
  phone: z.string().optional().nullable(),
  email: z.string().email().optional().nullable(),
  source: z.enum(["REFERRAL", "WEB", "FIELD", "CALL", "EVENT", "OTHER"]).optional().nullable(),
  status: z.enum(["NEW", "WORKING", "CONVERTED", "DISCARDED"]).optional(),
  ownerId: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
});

export const POST = handler({ permission: "lead:write" }, async ({ principal, request }) => {
  const input = await parseBody(request, schema);
  const lead = await createLead(principal, input);
  await auditAs(principal, "CREATE", "Lead", lead.id, { name: lead.name }, request);
  return ok(lead, undefined, { status: 201 });
});
