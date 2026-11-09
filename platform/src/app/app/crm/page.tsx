import Link from "next/link";

import {
  Badge,
  EmptyState,
  ModuleLocked,
  Money,
  PageHeader,
  SectionHeading,
  StatCard,
  StatGrid,
} from "@/components/ui";
import { db } from "@/lib/db";
import { requireTenant } from "@/lib/session";
import { crmDashboard } from "@/server/crm";

import { DealStageSelect, NewDealDialog, type Option, type StageOption } from "./crm-client";

export const dynamic = "force-dynamic";

/** Module 01 · CRM — the sales pipeline board and its headline numbers. */
export default async function CrmPage() {
  const { companyId, principal } = await requireTenant();
  if (!principal.enabledModules.has("CRM")) return <ModuleLocked module="CRM" />;

  const dash = await crmDashboard(principal);
  const stages: StageOption[] = dash.board.map((c) => ({ id: c.stage.id, name: c.stage.name, kind: c.stage.kind }));

  const [customers, users] = await Promise.all([
    db.customer.findMany({
      where: { companyId, status: "ACTIVE" },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
      take: 500,
    }),
    db.user.findMany({
      where: { companyId, status: { not: "SUSPENDED" } },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
  ]);
  const customerOpts: Option[] = customers;
  const userOpts: Option[] = users;

  return (
    <div className="space-y-6">
      <PageHeader
        title="CRM & Pipeline"
        description="Opportunities moving from first contact to a closed sale."
        actions={<NewDealDialog customers={customerOpts} reps={userOpts} stages={stages} />}
      />

      <StatGrid>
        <StatCard label="Open pipeline" value={<Money cents={dash.openValueCents} compact />} hint={`${dash.openCount} open deals`} />
        <StatCard label="Win rate" value={dash.winRate == null ? "—" : `${dash.winRate}%`} hint={`${dash.won} won · ${dash.lost} lost`} tone={dash.winRate != null && dash.winRate >= 50 ? "success" : "neutral"} />
        <StatCard label="Open tasks" value={String(dash.openTasks)} hint={dash.overdueTasks > 0 ? `${dash.overdueTasks} overdue` : "none overdue"} tone={dash.overdueTasks > 0 ? "warning" : "neutral"} />
        <StatCard label="Active leads" value={String(dash.newLeads)} hint="new or being worked" />
      </StatGrid>

      <section>
        <SectionHeading title="Pipeline" description="Move a deal with the stage dropdown on its card. Won and Lost close it." />
        <div className="scroll-x mt-4 flex gap-4 pb-2">
          {dash.board.map((col) => (
            <div key={col.stage.id} className="w-72 shrink-0">
              <div className="afr-card flex items-center justify-between rounded-t-xl border border-b-0 border-border bg-surface px-3 py-2">
                <span className="text-sm font-semibold">{col.stage.name}</span>
                <span className="text-xs text-content-muted">{col.count} · <Money cents={col.valueCents} compact /></span>
              </div>
              <div className="min-h-24 space-y-2 rounded-b-xl border border-border bg-surface-sunken p-2">
                {col.deals.length === 0 ? (
                  <p className="px-1 py-6 text-center text-xs text-content-muted">No deals</p>
                ) : (
                  col.deals.map((deal) => (
                    <div key={deal.id} className="rounded-lg border border-border bg-surface p-2.5 shadow-sm">
                      <p className="text-sm font-medium leading-tight">{deal.title}</p>
                      <p className="mt-0.5 text-xs text-content-muted">
                        {deal.customer ? (
                          <Link href={`/app/customers/${deal.customer.id}`} className="hover:text-accent">{deal.customer.name}</Link>
                        ) : (
                          "No customer"
                        )}
                      </p>
                      <div className="mt-1.5 flex items-center justify-between gap-2">
                        <span className="text-sm font-semibold"><Money cents={deal.valueCents} compact /></span>
                        {deal.probability != null ? <Badge tone="neutral">{deal.probability}%</Badge> : null}
                      </div>
                      <div className="mt-2">
                        <DealStageSelect dealId={deal.id} stageId={deal.stageId} stages={stages} />
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          ))}
        </div>
        {dash.board.every((c) => c.count === 0) ? (
          <EmptyState title="No open deals yet" description="Create a deal, or convert a lead, to start the pipeline." />
        ) : null}
      </section>
    </div>
  );
}
