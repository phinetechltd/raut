import {
  Badge,
  Callout,
  DataTable,
  EmptyState,
  ModuleLocked,
  Money,
  PageHeader,
  type Column,
  type Tone,
} from "@/components/ui";
import { db } from "@/lib/db";
import { can } from "@/lib/rbac";
import { requireTenant } from "@/lib/session";
import { targetAchievement } from "@/server/targets";

import { DeleteTargetButton, TargetDialog } from "./target-client";

export const dynamic = "force-dynamic";

type Row = Awaited<ReturnType<typeof targetAchievement>>[number];

function progressTone(pct: number | null): Tone {
  if (pct == null) return "neutral";
  if (pct >= 100) return "success";
  if (pct >= 60) return "info";
  return "warning";
}

function Metric({ actual, target, pct, money }: { actual: number; target: number; pct: number | null; money?: boolean }) {
  if (!target) return <span className="text-content-muted">—</span>;
  return (
    <div className="flex flex-col items-end gap-0.5">
      <span className="text-sm tabular">
        {money ? <Money cents={actual} compact /> : actual} / {money ? <Money cents={target} compact /> : target}
      </span>
      {pct != null ? <Badge tone={progressTone(pct)}>{pct}%</Badge> : null}
    </div>
  );
}

export default async function TargetsPage() {
  const { companyId, principal } = await requireTenant();
  if (!principal.enabledModules.has("FIELD_SALES")) return <ModuleLocked module="FIELD_SALES" />;
  if (!can(principal, "target:write")) {
    return (
      <Callout tone="info">
        Sales targets are set and reviewed by sales managers and administrators.
      </Callout>
    );
  }

  const rows = await targetAchievement(principal);
  const reps = await db.user.findMany({
    where: { companyId, status: { not: "SUSPENDED" }, role: { in: ["FIELD_REP", "SALES_MANAGER", "BRANCH_MANAGER"] } },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });

  const fmtPeriod = (d: Date) => d.toLocaleDateString("en-KE", { day: "numeric", month: "short" });

  const columns: Array<Column<Row>> = [
    {
      key: "rep",
      header: "Rep / scope",
      cell: (r) => (
        <div>
          <p className="font-medium">{r.target.rep?.name ?? "Whole company"}</p>
          <p className="text-xs text-content-muted">
            {r.target.period.toLowerCase()} · {fmtPeriod(r.target.periodStart)}–{fmtPeriod(r.target.periodEnd)}
          </p>
        </div>
      ),
    },
    { key: "sales", header: "Sales", align: "right", cell: (r) => <Metric actual={r.actual.salesCents} target={r.target.targetSalesCents} pct={r.progress.sales} money /> },
    { key: "collection", header: "Collected", align: "right", hideBelow: "md", cell: (r) => <Metric actual={r.actual.collectionCents} target={r.target.targetCollectionCents} pct={r.progress.collection} money /> },
    { key: "visits", header: "Visits", align: "right", hideBelow: "lg", cell: (r) => <Metric actual={r.actual.visits} target={r.target.targetVisits} pct={r.progress.visits} /> },
    { key: "newc", header: "New cust.", align: "right", hideBelow: "lg", cell: (r) => <Metric actual={r.actual.newCustomers} target={r.target.targetNewCustomers} pct={r.progress.newCustomers} /> },
    {
      key: "commission",
      header: "Commission",
      align: "right",
      cell: (r) =>
        r.target.commissionRateBp > 0 ? (
          <div className="flex flex-col items-end">
            <span className="font-medium"><Money cents={r.commissionCents} /></span>
            <span className="text-xs text-content-muted">{(r.target.commissionRateBp / 100).toFixed(1)}% of sales</span>
          </div>
        ) : (
          <span className="text-content-muted">—</span>
        ),
    },
    { key: "actions", header: "", align: "right", cell: (r) => <DeleteTargetButton id={r.target.id} /> },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Sales targets"
        description="Targets and how each rep is tracking against them, with commission earned on sales achieved."
        actions={<TargetDialog reps={reps} />}
      />
      {rows.length === 0 ? (
        <EmptyState title="No targets set" description="Set a rep's monthly target with the button above." />
      ) : (
        <DataTable columns={columns} rows={rows} getRowKey={(r) => r.target.id} caption="Sales targets and achievement" />
      )}
    </div>
  );
}
