import {
  Badge,
  ButtonLink,
  EmptyState,
  ModuleLocked,
  PageHeader,
  SectionHeading,
  type Tone,
} from "@/components/ui";
import { db } from "@/lib/db";
import { can } from "@/lib/rbac";
import { requireTenant } from "@/lib/session";
import { listMeetings, meetingUrl } from "@/server/meetings";

import { CancelMeetingButton, InviteButton, MeetingDialog } from "./meetings-client";

export const dynamic = "force-dynamic";

const STATUS_TONE: Record<string, Tone> = { SCHEDULED: "info", DONE: "success", CANCELLED: "neutral" };

type Meeting = Awaited<ReturnType<typeof listMeetings>>[number];

function when(d: Date) {
  return d.toLocaleString("en-KE", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export default async function MeetingsPage() {
  const { companyId, principal } = await requireTenant();
  if (!principal.enabledModules.has("CRM")) return <ModuleLocked module="CRM" />;
  const canWrite = can(principal, "meeting:write");

  const [upcoming, past, customers] = await Promise.all([
    listMeetings(principal, { scope: "upcoming" }),
    listMeetings(principal, { scope: "past" }),
    canWrite ? db.customer.findMany({ where: { companyId, status: "ACTIVE" }, select: { id: true, name: true }, orderBy: { name: "asc" }, take: 500 }) : Promise.resolve([]),
  ]);

  function Card({ m }: { m: Meeting }) {
    const live = m.status === "SCHEDULED";
    return (
      <div className="afr-card flex flex-col gap-2 rounded-xl border border-border bg-surface p-4 shadow-sm sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <p className="truncate font-medium">{m.title}</p>
            <Badge tone={STATUS_TONE[m.status] ?? "neutral"}>{m.status}</Badge>
          </div>
          <p className="mt-0.5 text-xs text-content-muted">
            {when(m.scheduledAt)} · {m.durationMin} min{m.customer ? ` · ${m.customer.name}` : ""}
          </p>
        </div>
        {live ? (
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <ButtonLink href={meetingUrl(m.roomName)} variant="primary" size="sm" target="_blank" rel="noopener">Join</ButtonLink>
            {canWrite ? <InviteButton id={m.id} disabled={!m.customer?.email} /> : null}
            {canWrite ? <CancelMeetingButton id={m.id} /> : null}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Online meetings"
        description="Schedule video meetings with customers in a Jitsi room, and email them the join link."
        actions={canWrite ? <MeetingDialog customers={customers} /> : null}
      />

      <section>
        <SectionHeading title="Upcoming" description={`${upcoming.length} scheduled`} />
        {upcoming.length === 0 ? (
          <EmptyState title="No meetings scheduled" description={canWrite ? "Schedule one with the button above." : undefined} />
        ) : (
          <div className="space-y-2">{upcoming.map((m) => <Card key={m.id} m={m} />)}</div>
        )}
      </section>

      {past.length > 0 ? (
        <section>
          <SectionHeading title="Past & cancelled" />
          <div className="space-y-2">{past.map((m) => <Card key={m.id} m={m} />)}</div>
        </section>
      ) : null}
    </div>
  );
}
