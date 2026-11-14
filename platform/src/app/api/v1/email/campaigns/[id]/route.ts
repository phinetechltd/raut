import { z } from "zod";

import { handler, parseBody } from "@/lib/api";
import { auditAs } from "@/lib/audit";
import { campaignRecipientCount, getCampaign, updateCampaign } from "@/server/email";

export const dynamic = "force-dynamic";

export const GET = handler<{ id: string }>({ permission: "email:read" }, async ({ principal, params }) => {
  const campaign = await getCampaign(principal, params.id);
  const recipientCount = await campaignRecipientCount(principal, params.id);
  return { campaign, recipientCount };
});

const schema = z.object({
  name: z.string().min(2).optional(),
  subject: z.string().min(1).optional(),
  bodyHtml: z.string().min(1).optional(),
  segment: z.enum(["A", "B", "C"]).nullable().optional(),
  customerType: z.enum(["RETAIL", "WHOLESALE", "DISTRIBUTOR", "INSTITUTION"]).nullable().optional(),
  territoryId: z.string().nullable().optional(),
});

export const PATCH = handler<{ id: string }>({ permission: "email:send" }, async ({ principal, params, request }) => {
  const input = await parseBody(request, schema);
  const campaign = await updateCampaign(principal, params.id, input);
  await auditAs(principal, "UPDATE", "EmailCampaign", campaign.id, input as Record<string, unknown>, request);
  return campaign;
});
