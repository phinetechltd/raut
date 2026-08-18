
import {
  ModuleLocked,
  Money,
  SectionHeading,
  StatCard,
  StatusBadge,
} from "@/components/ui";
import { db } from "@/lib/db";
import { requireTenant } from "@/lib/session";

export const dynamic = "force-dynamic";

/** Module 09 · SMS Communication. */
export default async function SmsPage() {
  const { companyId, principal } = await requireTenant();
  if (!principal.enabledModules.has("SMS")) return <ModuleLocked module="SMS" />;

  const [messages, templates, byStatus, spend] = await Promise.all([
    db.smsMessage.findMany({
      where: { companyId },
      include: { customer: { select: { name: true } } },
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
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

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Messages" value={String(messages.length)} hint="Most recent 50" />
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
      </div>

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
        <SectionHeading title="Message log" />
        <div className="scroll-x rounded-lg border border-border bg-surface shadow-sm">
          <table className="w-full border-collapse text-base">
            <thead>
              <tr>
                <th>When</th>
                <th>To</th>
                <th>Customer</th>
                <th>Template</th>
                <th>Message</th>
                <th>Status</th>
                <th>Cost</th>
              </tr>
            </thead>
            <tbody>
              {messages.length === 0 ? (
                <tr>
                  <td colSpan={7} className="text-content-muted py-10 text-center">
                    No messages sent yet. Confirmations are triggered automatically
                    when orders and payments are recorded.
                  </td>
                </tr>
              ) : (
                messages.map((m) => (
                  <tr key={m.id}>
                    <td className="text-content-muted text-xs">
                      {m.createdAt.toLocaleString("en-KE", {
                        day: "2-digit", month: "short",
                        hour: "2-digit", minute: "2-digit",
                      })}
                    </td>
                    <td className="font-mono text-xs">{m.toPhone}</td>
                    <td className="text-xs">{m.customer?.name ?? "—"}</td>
                    <td className="text-content-muted text-[11px]">{m.templateKey ?? "custom"}</td>
                    <td className="max-w-md truncate text-xs" title={m.body}>
                      {m.body}
                    </td>
                    <td>
                      <StatusBadge status={m.status} />
                      {m.error ? (
                        <span className="text-content-muted block text-[10px]">{m.error}</span>
                      ) : null}
                    </td>
                    <td className="text-content-muted text-xs">
                      <Money cents={m.costCents} />
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

