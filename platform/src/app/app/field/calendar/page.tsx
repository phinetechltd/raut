import Link from "next/link";

import { Badge, ButtonLink, ModuleLocked, PageHeader, StatusBadge, cx } from "@/components/ui";
import { db } from "@/lib/db";
import { can } from "@/lib/rbac";
import { requireTenant } from "@/lib/session";

import { VisitDialog } from "../visit-dialog";

export const dynamic = "force-dynamic";

/** Monday 00:00 of the week containing `base`, in local time. */
function weekStart(base: Date): Date {
  const d = new Date(base);
  d.setHours(0, 0, 0, 0);
  const dow = (d.getDay() + 6) % 7; // 0 = Monday
  d.setDate(d.getDate() - dow);
  return d;
}

const PURPOSE_TONE: Record<string, "neutral" | "info" | "success" | "warning"> = {
  SALES: "info", COLLECTION: "warning", DELIVERY: "neutral", PROSPECTING: "success", SUPPORT: "neutral",
};

export default async function VisitCalendarPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const { companyId, principal } = await requireTenant();
  if (!principal.enabledModules.has("FIELD_SALES")) return <ModuleLocked module="FIELD_SALES" />;

  const sp = await searchParams;
  const offset = Number(sp.week ?? 0) || 0;
  const start = weekStart(new Date());
  start.setDate(start.getDate() + offset * 7);
  const end = new Date(start);
  end.setDate(end.getDate() + 7);

  const selfScope = principal.role === "FIELD_REP" ? { repId: principal.userId } : {};
  const visits = await db.visit.findMany({
    where: { companyId, ...selfScope, scheduledAt: { gte: start, lt: end } },
    include: { customer: { select: { id: true, name: true } } },
    orderBy: { scheduledAt: "asc" },
  });

  const canWrite = can(principal, "visit:write");
  const [customers, repUsers] = canWrite
    ? await Promise.all([
        db.customer.findMany({ where: { companyId, status: "ACTIVE" }, select: { id: true, name: true }, orderBy: { name: "asc" }, take: 500 }),
        db.user.findMany({ where: { companyId, status: { not: "SUSPENDED" }, role: { in: ["FIELD_REP", "SALES_MANAGER", "BRANCH_MANAGER"] } }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
      ])
    : [[], []];

  const repName = new Map(repUsers.map((r) => [r.id, r.name]));

  // Group by day index 0..6.
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    return d;
  });
  const byDay = new Map<string, typeof visits>();
  for (const v of visits) {
    const key = new Date(v.scheduledAt).toDateString();
    const list = byDay.get(key) ?? [];
    list.push(v);
    byDay.set(key, list);
  }

  const todayKey = new Date().toDateString();
  const label = `${start.toLocaleDateString("en-KE", { day: "numeric", month: "short" })} – ${new Date(end.getTime() - 1).toLocaleDateString("en-KE", { day: "numeric", month: "short", year: "numeric" })}`;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Visit calendar"
        description="Scheduled visits across the week. Plan ahead and spot gaps."
        actions={canWrite ? <VisitDialog customers={customers} reps={repUsers} selfIsRep={principal.role === "FIELD_REP"} /> : null}
      />

      <div className="flex items-center justify-between gap-3">
        <ButtonLink href={`/app/field/calendar?week=${offset - 1}`} variant="secondary" size="sm">← Previous</ButtonLink>
        <div className="flex items-center gap-2 text-sm font-medium">
          <span>{label}</span>
          {offset !== 0 ? <Link href="/app/field/calendar" className="text-xs text-accent hover:underline">This week</Link> : <Badge tone="info">This week</Badge>}
        </div>
        <ButtonLink href={`/app/field/calendar?week=${offset + 1}`} variant="secondary" size="sm">Next →</ButtonLink>
      </div>

      <div className="grid gap-3 md:grid-cols-7">
        {days.map((d) => {
          const key = d.toDateString();
          const list = byDay.get(key) ?? [];
          const isToday = key === todayKey;
          return (
            <div key={key} className={cx("rounded-xl border bg-surface p-2 shadow-sm", isToday ? "border-accent" : "border-border")}>
              <div className="mb-2 flex items-baseline justify-between px-1">
                <span className="text-xs font-semibold uppercase tracking-wide text-content-muted">{d.toLocaleDateString("en-KE", { weekday: "short" })}</span>
                <span className={cx("text-sm font-semibold", isToday && "text-accent")}>{d.getDate()}</span>
              </div>
              <div className="space-y-1.5">
                {list.length === 0 ? (
                  <p className="px-1 py-3 text-center text-[11px] text-content-muted">—</p>
                ) : (
                  list.map((v) => (
                    <div key={v.id} className="rounded-lg border border-border bg-surface-sunken p-1.5">
                      <div className="flex items-center justify-between gap-1">
                        <span className="text-[11px] font-medium tabular">{v.scheduledAt.toLocaleTimeString("en-KE", { hour: "2-digit", minute: "2-digit" })}</span>
                        <StatusBadge status={v.status} />
                      </div>
                      <Link href={`/app/customers/${v.customer?.id ?? ""}`} className="mt-0.5 block truncate text-xs font-medium hover:text-accent">
                        {v.customer?.name ?? "—"}
                      </Link>
                      <div className="mt-0.5 flex items-center gap-1">
                        <Badge tone={PURPOSE_TONE[v.purpose] ?? "neutral"}>{v.purpose.toLowerCase()}</Badge>
                        {principal.role !== "FIELD_REP" ? <span className="truncate text-[10px] text-content-muted">{repName.get(v.repId) ?? ""}</span> : null}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
