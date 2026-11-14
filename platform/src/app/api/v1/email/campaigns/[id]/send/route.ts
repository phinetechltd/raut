import { handler } from "@/lib/api";
import { auditAs } from "@/lib/audit";
import { sendCampaign } from "@/server/email";

export const dynamic = "force-dynamic";

export const POST = handler<{ id: string }>({ permission: "email:send" }, async ({ principal, params, request }) => {
  const campaign = await sendCampaign(principal, params.id);
  await auditAs(principal, "UPDATE", "EmailCampaign", campaign.id, { sent: campaign.sentCount, failed: campaign.failedCount }, request);
  return campaign;
});
