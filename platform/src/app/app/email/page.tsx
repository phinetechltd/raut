import {
  Badge,
  Callout,
  DataTable,
  ModuleLocked,
  PageHeader,
  SectionHeading,
  type Column,
  type Tone,
} from "@/components/ui";
import { db } from "@/lib/db";
import { can } from "@/lib/rbac";
import { requireTenant } from "@/lib/session";
import { listCampaigns, listMessages } from "@/server/email";

import { CampaignDialog, ComposeDialog, SendCampaignButton } from "./email-client";

export const dynamic = "force-dynamic";

const CAMPAIGN_TONE: Record<string, Tone> = { DRAFT: "neutral", SENDING: "info", SENT: "success", FAILED: "danger" };
const MSG_TONE: Record<string, Tone> = { QUEUED: "info", SENT: "success", FAILED: "danger", SKIPPED: "warning" };

type Campaign = Awaited<ReturnType<typeof listCampaigns>>[number];
type Message = Awaited<ReturnType<typeof listMessages>>[number];

export default async function EmailPage() {
  const { companyId, principal } = await requireTenant();
  if (!principal.enabledModules.has("SMS")) return <ModuleLocked module="SMS" />;
  if (!can(principal, "email:read")) {
    return <Callout tone="info">Email is sent by managers, accountants and administrators.</Callout>;
  }
  const canSend = can(principal, "email:send");

  const [campaigns, messages, customers, territories] = await Promise.all([
    listCampaigns(principal),
    listMessages(principal),
    db.customer.findMany({ where: { companyId, status: "ACTIVE", email: { not: null } }, select: { id: true, name: true }, orderBy: { name: "asc" }, take: 500 }),
    db.territory.findMany({ where: { companyId, active: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);

  const audience = (c: Campaign) =>
    [c.segment ? `Seg ${c.segment}` : null, c.customerType, c.territoryId ? "territory" : null].filter(Boolean).join(" · ") || "All customers";

  const campaignColumns: Array<Column<Campaign>> = [
    {
      key: "name",
      header: "Campaign",
      cell: (c) => (
        <div>
          <p className="font-medium">{c.name}</p>
          <p className="text-xs text-content-muted">{c.subject}</p>
        </div>
      ),
    },
    { key: "audience", header: "Audience", hideBelow: "md", cell: (c) => audience(c) },
    { key: "status", header: "Status", cell: (c) => <Badge tone={CAMPAIGN_TONE[c.status] ?? "neutral"}>{c.status}</Badge> },
    {
      key: "result",
      header: "Sent",
      align: "right",
      cell: (c) => (c.status === "SENT" ? `${c.sentCount}/${c.totalRecipients}${c.failedCount ? ` · ${c.failedCount} failed` : ""}` : "—"),
    },
    {
      key: "actions",
      header: "",
      align: "right",
      cell: (c) => (canSend && c.status === "DRAFT" ? <SendCampaignButton id={c.id} name={c.name} /> : null),
    },
  ];

  const messageColumns: Array<Column<Message>> = [
    { key: "to", header: "To", cell: (m) => <span className="font-medium">{m.toEmail}</span> },
    { key: "subject", header: "Subject", hideBelow: "md", cell: (m) => m.subject },
    { key: "when", header: "When", hideBelow: "lg", cell: (m) => m.createdAt.toLocaleString("en-KE", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) },
    {
      key: "status",
      header: "Status",
      align: "right",
      cell: (m) => (
        <span className="inline-flex flex-col items-end">
          <Badge tone={MSG_TONE[m.status] ?? "neutral"}>{m.status}</Badge>
          {m.error ? <span className="mt-0.5 max-w-48 truncate text-[11px] text-content-muted" title={m.error}>{m.error}</span> : null}
        </span>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Email"
        description="One-off emails to customers and bulk campaigns to a segment, sent through your mail server."
        actions={canSend ? <div className="flex gap-2"><ComposeDialog customers={customers} /><CampaignDialog territories={territories} /></div> : null}
      />

      <section>
        <SectionHeading title="Campaigns" description="Bulk email to customer segments. Unsubscribes are honoured." />
        <DataTable columns={campaignColumns} rows={campaigns} getRowKey={(c) => c.id} caption="Email campaigns" empty={{ title: "No campaigns yet", description: canSend ? "Create one with New campaign." : undefined }} />
      </section>

      <section>
        <SectionHeading title="Send log" description="Every email the system has sent, newest first." />
        <DataTable columns={messageColumns} rows={messages} getRowKey={(m) => m.id} caption="Email send log" empty={{ title: "Nothing sent yet" }} />
      </section>
    </div>
  );
}
