import "server-only";

import { conflict, notFound } from "@/lib/api";
import { db } from "@/lib/db";
import { queueEmail } from "@/lib/email";
import type { Principal } from "@/lib/rbac";
import { scope } from "@/lib/tenant";

/**
 * Email at the application layer: a one-off message to a customer, bulk
 * campaigns to a segment, and the send log. The transport and unsubscribe
 * mechanics live in lib/email; this is who-gets-what.
 */

// ── send log ───────────────────────────────────────────────────────────────

export async function listMessages(principal: Principal, opts: { campaignId?: string; q?: string } = {}) {
  const where: Record<string, unknown> = scope(principal);
  if (opts.campaignId) where.campaignId = opts.campaignId;
  if (opts.q) where.OR = [{ toEmail: { contains: opts.q } }, { subject: { contains: opts.q } }];
  return db.emailMessage.findMany({ where, orderBy: { createdAt: "desc" }, take: 500 });
}

// ── one-off ──────────────────────────────────────────────────────────────

export async function sendOneOff(
  principal: Principal,
  input: { customerId?: string | null; toEmail?: string; subject: string; html: string },
) {
  const companyId = principal.companyId!;
  let toEmail = input.toEmail?.trim() ?? "";
  let customerId = input.customerId ?? null;

  if (customerId) {
    const customer = await db.customer.findFirst({ where: { id: customerId, companyId }, select: { id: true, email: true } });
    if (!customer) throw notFound("Customer not found");
    if (!customer.email) throw conflict("This customer has no email address on file");
    toEmail = customer.email;
  }
  if (!toEmail) throw conflict("A recipient is required");

  // One-off, not bulk: a direct reply to a customer is not marketing, so it is
  // not gated on the unsubscribe list and carries no unsubscribe footer.
  return queueEmail({ companyId, customerId, toEmail, subject: input.subject, html: input.html });
}

// ── campaigns ──────────────────────────────────────────────────────────────

export interface CampaignInput {
  name: string;
  subject: string;
  bodyHtml: string;
  segment?: string | null;
  customerType?: string | null;
  territoryId?: string | null;
}

export async function listCampaigns(principal: Principal) {
  return db.emailCampaign.findMany({ where: scope(principal), orderBy: { createdAt: "desc" }, take: 500 });
}

export async function getCampaign(principal: Principal, id: string) {
  const campaign = await db.emailCampaign.findFirst({ where: { id, ...scope(principal) } });
  if (!campaign) throw notFound("Campaign not found");
  return campaign;
}

export async function createCampaign(principal: Principal, input: CampaignInput) {
  return db.emailCampaign.create({
    data: {
      companyId: principal.companyId!,
      name: input.name,
      subject: input.subject,
      bodyHtml: input.bodyHtml,
      segment: input.segment ?? null,
      customerType: input.customerType ?? null,
      territoryId: input.territoryId ?? null,
      createdById: principal.userId,
    },
  });
}

export async function updateCampaign(principal: Principal, id: string, input: Partial<CampaignInput>) {
  const existing = await db.emailCampaign.findFirst({ where: { id, ...scope(principal) }, select: { id: true, status: true } });
  if (!existing) throw notFound("Campaign not found");
  if (existing.status !== "DRAFT") throw conflict("Only a draft campaign can be edited");
  const data: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) if (v !== undefined) data[k] = v;
  return db.emailCampaign.update({ where: { id }, data });
}

/** Active customers matching the campaign's filters who have an address. */
function recipientWhere(companyId: string, c: { segment: string | null; customerType: string | null; territoryId: string | null }) {
  return {
    companyId,
    status: "ACTIVE",
    email: { not: null },
    ...(c.segment ? { segment: c.segment } : {}),
    ...(c.customerType ? { type: c.customerType } : {}),
    ...(c.territoryId ? { territoryId: c.territoryId } : {}),
  };
}

export async function campaignRecipientCount(principal: Principal, id: string) {
  const c = await getCampaign(principal, id);
  return db.customer.count({ where: recipientWhere(principal.companyId!, c) as never });
}

/**
 * Sends a draft campaign to everyone it targets. Each message goes through
 * queueEmail with bulk semantics (unsubscribe honoured and footer appended),
 * and the campaign's counts are updated from what actually happened.
 */
export async function sendCampaign(principal: Principal, id: string) {
  const companyId = principal.companyId!;
  const campaign = await db.emailCampaign.findFirst({ where: { id, ...scope(principal) } });
  if (!campaign) throw notFound("Campaign not found");
  if (campaign.status !== "DRAFT") throw conflict("This campaign has already been sent");

  const recipients = await db.customer.findMany({
    where: recipientWhere(companyId, campaign) as never,
    select: { id: true, email: true },
  });

  await db.emailCampaign.update({ where: { id }, data: { status: "SENDING", totalRecipients: recipients.length } });

  let sent = 0;
  let failed = 0;
  for (const r of recipients) {
    if (!r.email) continue;
    const msg = await queueEmail({
      companyId,
      customerId: r.id,
      campaignId: id,
      toEmail: r.email,
      subject: campaign.subject,
      html: campaign.bodyHtml,
      bulk: true,
    });
    if (msg.status === "SENT") sent += 1;
    else if (msg.status === "FAILED") failed += 1;
  }

  return db.emailCampaign.update({
    where: { id },
    data: { status: "SENT", sentCount: sent, failedCount: failed, sentAt: new Date() },
  });
}
