import { z } from "zod";

import { handler, ok, parseBody } from "@/lib/api";
import { auditAs } from "@/lib/audit";
import { createCampaign, listCampaigns } from "@/server/email";

export const dynamic = "force-dynamic";

export const GET = handler({ permission: "email:read" }, async ({ principal }) => {
  return listCampaigns(principal);
});

const schema = z.object({
  name: z.string().min(2),
  subject: z.string().min(1),
  bodyHtml: z.string().min(1),
  segment: z.enum(["A", "B", "C"]).nullable().optional(),
  customerType: z.enum(["RETAIL", "WHOLESALE", "DISTRIBUTOR", "INSTITUTION"]).nullable().optional(),
  territoryId: z.string().nullable().optional(),
});

export const POST = handler({ permission: "email:send" }, async ({ principal, request }) => {
  const input = await parseBody(request, schema);
  const campaign = await createCampaign(principal, input);
  await auditAs(principal, "CREATE", "EmailCampaign", campaign.id, { name: campaign.name }, request);
  return ok(campaign, undefined, { status: 201 });
});
