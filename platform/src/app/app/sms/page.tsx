
import {
  DataTable,
  CellStack,
  FilterBar,
  FilterSearch,
  FilterSelect,
  ModuleLocked,
  Money,
  SectionHeading,
  StatCard,
  StatGrid,
  StatusBadge,
  type Column,
} from "@/components/ui";
import { db } from "@/lib/db";
import { requireTenant } from "@/lib/session";
import { preserved, tableHref, tableState, toggleSort } from "@/lib/table";

export const dynamic = "force-dynamic";

/** Module 09 · SMS Communication. */
export default async function SmsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { companyId, principal } = await requireTenant();
  if (!principal.enabledModules.has("SMS")) return <ModuleLocked module="SMS" />;

  const params = await searchParams;
  const ts = tableState(params, {
    prefix: "sms",
    allowed: ["created", "status"],
    defaultSort: "created",
    defaultDir: "desc",
    limit: 20,
  });

  const where = {
    companyId,
    ...(params.q
      ? {
          OR: [
            { body: { contains: params.q } },
            { toPhone: { contains: params.q } },
            { customer: { name: { contains: params.q } } },
          ],
        }
      : {}),
    ...(params.status ? { status: params.status } : {}),
  };

  const [messages, messageCount, templates, byStatus, spend] = await Promise.all([
    db.smsMessage.findMany({
      where,
      include: { customer: { select: { name: true } } },
      orderBy: { [ts.sort === "status" ? "status" : "createdAt"]: ts.dir } as Record<string, string>,
      take: ts.limit,
      skip: (ts.page - 1) * ts.limit,
    }),
    db.smsMessage.count({ where }),
    db.smsTemplate.findMany({ where: { companyId }, orderBy: { key: "asc" } }),
    db.smsMessage.groupBy({ by: ["status"], where: { companyId }, _count: true }),
    db.smsMessage.aggregate({
      where: { companyId, status: { in: ["SENT", "DELIVERED"] } },
      _sum: { costCents: true },
    }),
  ]);

  const provider = process.env.SMS_PROVIDER ?? "console";
  const count = (s: string) => byStatus.find((x) => x.status === s)?._count ?? 0;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">SMS Communication</h1>
        <p className="text-content-muted text-sm">
          Order and payment confirmations, balance reminders and promotions.
        </p>
      </div>

      {provider === "console" ? (
        <div className="rounded-lg border border-border bg-surface shadow-sm border-warn/40 bg-warn/5 p-4">
          <p className="text-sm font-medium text-warning">
            No SMS provider is connected
          </p>
          <p className="text-content-muted mt-1 text-sm">
            The platform is running the <code>console</code> adapter: messages are
            composed, queued and recorded here, but nothing is transmitted. A bulk
            SMS account is quoted separately from the platform price. Set{" "}
            <code>SMS_PROVIDER</code>, <code>SMS_API_KEY</code> and{" "}
            <code>SMS_API_USERNAME</code> to go live.
          </p>
        </div>
      ) : null}

      <StatGrid>
        <StatCard label="Messages" value={messageCount.toLocaleString("en-KE")} hint="Matching filters" />
        <StatCard label="Sent" value={String(count("SENT") + count("DELIVERED"))} tone="success" />
        <StatCard
          label="Failed"
          value={String(count("FAILED"))}
          tone={count("FAILED") > 0 ? "danger" : "neutral"}
        />
        <StatCard
          label="Spend"
          value={<Money cents={spend._sum.costCents ?? 0} />}
          hint={`Provider: ${provider}`}
        />
      </StatGrid>

      <div>
        <SectionHeading
          title="Templates"
          description="Placeholders in {{braces}} are substituted at send time"
        />
        <div className="grid gap-3 sm:grid-cols-2">
          {templates.map((t) => (
            <div key={t.id} className="rounded-lg border border-border bg-surface p-4 shadow-sm">
              <div className="flex items-baseline justify-between gap-2">
                <p className="text-sm font-medium">{t.name}</p>
                {t.active ? (
                  <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium bg-success-bg text-success">active</span>
                ) : (
                  <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium bg-surface-sunken">off</span>
                )}
              </div>
              <p className="text-content-muted mt-2 text-xs leading-relaxed">{t.body}</p>
              <p className="text-content-muted mt-2 font-mono text-[10px]">{t.key}</p>
            </div>
          ))}
        </div>
      </div>

      <div>
        <SectionHeading title="Message log" description={`${messageCount.toLocaleString("en-KE")} messages`} />
        <FilterBar action="/app/sms" preserve={preserved(params, ["q", "status", "sms_page"])}>
          <FilterSearch name="q" value={params.q} placeholder="Search messages, numbers, customers…" />
          <FilterSelect
            name="status"
            value={params.status}
            allLabel="Any status"
            options={["SENT", "DELIVERED", "QUEUED", "FAILED"].map((s) => ({ value: s, label: s.toLowerCase() }))}
          />
        </FilterBar>
        <DataTable
          columns={[
            {
              key: "when",
              header: "When",
              sortKey: "created",
              cell: (m) => (
                <span className="text-content-muted text-xs">
                  {m.createdAt.toLocaleString("en-KE", {
                    day: "2-digit", month: "short",
                    hour: "2-digit", minute: "2-digit",
                  })}
                </span>
              ),
            },
            { key: "to", header: "To", cell: (m) => <span className="tabular text-xs">{m.toPhone}</span> },
            {
              key: "customer",
              header: "Customer",
              hideBelow: "md",
              cell: (m) => <CellStack primary={<span className="text-xs">{m.customer?.name ?? "—"}</span>} secondary="" />,
            },
            {
              key: "template",
              header: "Template",
              hideBelow: "lg",
              cell: (m) => <span className="text-content-muted text-[11px]">{m.templateKey ?? "custom"}</span>,
            },
            {
              key: "message",
              header: "Message",
              cell: (m) => (
                <span className="block max-w-md truncate text-xs" title={m.body}>
                  {m.body}
                </span>
              ),
            },
            {
              key: "status",
              header: "Status",
              sortKey: "status",
              align: "right",
              cell: (m) => (
                <div>
                  <StatusBadge status={m.status} />
                  {m.error ? (
                    <span className="text-content-muted block text-[10px]">{m.error}</span>
                  ) : null}
                </div>
              ),
            },
            {
              key: "cost",
              header: "Cost",
              align: "right",
              cell: (m) => (
                <span className="text-content-muted text-xs">
                  <Money cents={m.costCents} />
                </span>
              ),
            },
          ]}
          rows={messages}
          getRowKey={(m) => m.id}
          caption="SMS message log"
          sort={{ key: ts.sort, dir: ts.dir }}
          sortHrefFor={(key) => {
            const next = toggleSort(ts, key);
            return tableHref("/app/sms", params, { sms_sort: next.sort, sms_dir: next.dir }, "sms");
          }}
          pagination={{
            page: ts.page,
            pages: Math.max(1, Math.ceil(messageCount / ts.limit)),
            total: messageCount,
            limit: ts.limit,
            hrefFor: (p) => tableHref("/app/sms", params, { sms_page: p }),
          }}
          empty={{
            title: "No messages sent yet",
            description: "Confirmations are triggered automatically when orders and payments are recorded.",
          }}
        />
      </div>
    </div>
  );
}

