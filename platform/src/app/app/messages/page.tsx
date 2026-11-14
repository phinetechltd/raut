import Link from "next/link";

import { Badge, Callout, EmptyState, ModuleLocked, PageHeader, cx } from "@/components/ui";
import { db } from "@/lib/db";
import { can, isSelfScoped } from "@/lib/rbac";
import { requireTenant } from "@/lib/session";
import { officeConversation, officeInbox, repThread } from "@/server/messaging";

import { BroadcastDialog, MessageComposer } from "./messages-client";

export const dynamic = "force-dynamic";

function timeLabel(d: Date) {
  return d.toLocaleString("en-KE", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

interface Msg { id: string; senderId: string; body: string; isBroadcast: boolean; createdAt: Date }

function Thread({ messages, mineIf, names }: { messages: Msg[]; mineIf: (senderId: string) => boolean; names: Map<string, string> }) {
  if (messages.length === 0) {
    return <div className="grid flex-1 place-items-center p-8 text-sm text-content-muted">No messages yet. Say hello.</div>;
  }
  return (
    <div className="flex-1 space-y-2 overflow-y-auto p-4">
      {messages.map((m) => {
        const mine = mineIf(m.senderId);
        return (
          <div key={m.id} className={cx("flex", mine ? "justify-end" : "justify-start")}>
            <div className={cx("max-w-[75%] rounded-xl px-3 py-2 text-sm shadow-sm", mine ? "bg-accent-subtle" : "bg-surface border border-border")}>
              {!mine ? <p className="mb-0.5 text-[11px] font-semibold text-content-muted">{names.get(m.senderId) ?? "Office"}</p> : null}
              {m.isBroadcast ? <Badge tone="info">Broadcast</Badge> : null}
              <p className="whitespace-pre-wrap leading-snug">{m.body}</p>
              <p className={cx("mt-1 text-[10px]", mine ? "text-content-muted" : "text-content-muted")}>{timeLabel(m.createdAt)}</p>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default async function MessagesPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const { companyId, principal } = await requireTenant();
  if (!principal.enabledModules.has("FIELD_SALES")) return <ModuleLocked module="FIELD_SALES" />;
  if (!can(principal, "message:read")) return <Callout tone="info">Messaging is available to field reps and their managers.</Callout>;

  // ── rep on the console: just their own thread ──
  if (isSelfScoped(principal)) {
    const { messages } = await repThread(principal);
    return (
      <div className="space-y-6">
        <PageHeader title="Messages" description="Your conversation with the office." />
        <div className="afr-card flex h-[70vh] flex-col overflow-hidden rounded-xl border border-border bg-surface-sunken shadow-sm">
          <Thread messages={messages} mineIf={(s) => s === principal.userId} names={new Map()} />
          <MessageComposer />
        </div>
      </div>
    );
  }

  // ── office: inbox + selected thread ──
  const inbox = await officeInbox(principal);
  const sp = await searchParams;
  const selectedRepId = sp.rep ?? inbox[0]?.conversation.repId;

  let threadView: { repName: string; messages: Msg[]; names: Map<string, string> } | null = null;
  if (selectedRepId) {
    const { repName, messages } = await officeConversation(principal, selectedRepId);
    const officeIds = [...new Set(messages.map((m) => m.senderId).filter((id) => id !== selectedRepId))];
    const users = await db.user.findMany({ where: { id: { in: officeIds } }, select: { id: true, name: true } });
    threadView = { repName, messages, names: new Map(users.map((u) => [u.id, u.name])) };
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Messages" description="Conversations with your field reps." actions={<BroadcastDialog />} />
      {inbox.length === 0 ? (
        <EmptyState title="No conversations yet" description="Broadcast to all reps, or message a rep to start a thread." />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[300px_1fr]">
          <div className="divide-y rounded-xl border border-border bg-surface shadow-sm">
            {inbox.map((row) => (
              <Link
                key={row.conversation.id}
                href={`/app/messages?rep=${row.conversation.repId}`}
                className={cx("block px-3 py-2.5 hover:bg-surface-hover", row.conversation.repId === selectedRepId && "bg-surface-hover")}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium">{row.repName}</span>
                  {row.unread > 0 ? <Badge tone="danger">{row.unread}</Badge> : null}
                </div>
                <p className="truncate text-xs text-content-muted">{row.last?.body ?? "No messages yet"}</p>
              </Link>
            ))}
          </div>

          <div className="afr-card flex h-[70vh] flex-col overflow-hidden rounded-xl border border-border bg-surface-sunken shadow-sm">
            {threadView ? (
              <>
                <div className="border-b border-border bg-surface px-4 py-2.5 text-sm font-semibold">{threadView.repName}</div>
                <Thread messages={threadView.messages} mineIf={(s) => s !== selectedRepId} names={threadView.names} />
                <MessageComposer repId={selectedRepId} />
              </>
            ) : (
              <div className="grid flex-1 place-items-center text-sm text-content-muted">Select a conversation</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
