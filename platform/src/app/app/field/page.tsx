
import {
  CellStack,
  DataTable,
  Meter,
  ModuleLocked,
  Money,
  PageHeader,
  SectionHeading,
  StatCard,
  StatGrid,
  StatusBadge,
  TileMap,
  type Column,
} from "@/components/ui";
import { db } from "@/lib/db";
import { MAP_PROVIDER_LABELS, toClientConfig } from "@/lib/maps";
import { can } from "@/lib/rbac";
import { requireTenant } from "@/lib/session";
import { repPerformance } from "@/server/field";
import { mapConfigFor } from "@/server/maps";

import { VisitDialog } from "./visit-dialog";

export const dynamic = "force-dynamic";

/** Module 06 · Field Sales — visits, check-ins, targets and rep performance. */
export default async function FieldSalesPage() {
  const { companyId, principal } = await requireTenant();
  if (!principal.enabledModules.has("FIELD_SALES")) {
    return <ModuleLocked module="FIELD_SALES" />;
  }

  const geofencing = principal.enabledModules.has("GEOFENCING");

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today.getTime() + 86_400_000);
  const monthAgo = new Date(Date.now() - 30 * 86_400_000);

  const selfScope = principal.role === "FIELD_REP" ? { repId: principal.userId } : {};
  const maps = await mapConfigFor(companyId);

  const [todayVisits, reps, targets, recentVisits] = await Promise.all([
    db.visit.findMany({
      where: { companyId, ...selfScope, scheduledAt: { gte: today, lt: tomorrow } },
      include: {
        customer: {
          select: { id: true, name: true, town: true, latitude: true, longitude: true, balanceCents: true },
        },
        rep: { select: { id: true, name: true } },
        order: { select: { number: true, totalCents: true } },
      },
      orderBy: { scheduledAt: "asc" },
    }),
    repPerformance(companyId, monthAgo, new Date()),
    db.salesTarget.findMany({
      where: { companyId, periodEnd: { gte: new Date() } },
      include: { rep: { select: { id: true, name: true } } },
    }),
    db.visit.findMany({
      where: { companyId, ...selfScope, checkInAt: { not: null } },
      include: {
        customer: { select: { name: true, town: true } },
        rep: { select: { name: true } },
      },
      orderBy: { checkInAt: "desc" },
      take: 25,
    }),
  ]);

  const completedToday = todayVisits.filter((v) => v.status === "COMPLETED").length;
  const verifiedToday = todayVisits.filter((v) => v.geofenceVerified).length;
  const inProgress = todayVisits.filter((v) => v.status === "IN_PROGRESS").length;

  const targetByRep = new Map(targets.filter((t) => t.repId).map((t) => [t.repId!, t]));

  const canVisitWrite = can(principal, "visit:write");
  const repUsers = await db.user.findMany({
    where: { companyId, status: "ACTIVE", role: "FIELD_REP" },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
  const customers = await db.customer.findMany({
    where: { companyId, status: "ACTIVE", ...(principal.role === "FIELD_REP" ? { assignedRepId: principal.userId } : {}) },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
    take: 300,
  });

  return (
    <div className="space-y-8">
      <PageHeader
        title="Field Sales"
        description="Visit scheduling and check-in, field order capture, targets and performance."
        actions={canVisitWrite ? <VisitDialog customers={customers} reps={repUsers} selfIsRep={principal.role === "FIELD_REP"} /> : null}
      />

      <StatGrid>
        <StatCard label="Scheduled today" value={String(todayVisits.length)} />
        <StatCard label="In progress" value={String(inProgress)} tone="warning" />
        <StatCard label="Completed today" value={String(completedToday)} tone="success" />
        <StatCard
          label="GPS-verified today"
          value={String(verifiedToday)}
          hint={
            geofencing
              ? "Check-in fell inside the customer fence"
              : "Geofencing module not licensed — positions recorded, not enforced"
          }
          tone={geofencing ? (verifiedToday === completedToday ? "success" : "warning") : "neutral"}
        />
      </StatGrid>

      <div>
        <SectionHeading
          title="Today in the field"
          description={`Live positions of scheduled and completed visits — pings from the field app, on ${MAP_PROVIDER_LABELS[maps.provider]}`}
        />
        <TileMap
          map={toClientConfig(maps)}
          points={todayVisits
            .filter((v) => v.customer.latitude != null)
            .map((v, i) => ({
              id: v.id,
              lat: v.customer.latitude!,
              lng: v.customer.longitude!,
              label: `${i + 1} — ${v.customer.name} (${v.customer.town ?? ""})`,
              sequence: i + 1,
              tone:
                v.status === "COMPLETED"
                  ? ("success" as const)
                  : v.status === "IN_PROGRESS"
                    ? ("warning" as const)
                    : v.status === "MISSED"
                      ? ("danger" as const)
                      : ("neutral" as const),
            }))}
          height={400}
        />
      </div>

      <div>
        <SectionHeading title="Today's visits" />
        <DataTable
          columns={[
            {
              key: "time",
              header: "Time",
              cell: (v) => (
                <span className="font-medium tabular">
                  {v.scheduledAt.toLocaleTimeString("en-KE", { hour: "2-digit", minute: "2-digit" })}
                </span>
              ),
            },
            {
              key: "customer",
              header: "Customer",
              cell: (v) => (
                <CellStack primary={v.customer.name} secondary={v.customer.town ?? ""} />
              ),
            },
            { key: "rep", header: "Rep", hideBelow: "sm", cell: (v) => <span className="text-xs">{v.rep.name}</span> },
            { key: "status", header: "Status", cell: (v) => <StatusBadge status={v.status} /> },
            {
              key: "checked",
              header: "Checked in",
              hideBelow: "md",
              cell: (v) => (
                <span className="text-content-muted text-xs">
                  {v.checkInAt
                    ? v.checkInAt.toLocaleTimeString("en-KE", { hour: "2-digit", minute: "2-digit" })
                    : "—"}
                </span>
              ),
            },
            {
              key: "verified",
              header: "Verified",
              align: "right",
              cell: (v) =>
                v.geofenceVerified ? (
                  <span className="badge bg-success-bg text-success border-success-border">yes</span>
                ) : v.checkInAt ? (
                  <span className="badge bg-danger-bg text-danger border-danger-border">no</span>
                ) : (
                  <span className="text-content-muted text-xs">—</span>
                ),
            },
            {
              key: "distance",
              header: "Distance",
              align: "right",
              hideBelow: "lg",
              cell: (v) => (
                <span className={(v.distanceFromCustomerM ?? 0) > 200 ? "text-warning" : "text-content-muted"}>
                  {v.distanceFromCustomerM != null ? `${v.distanceFromCustomerM}m` : "—"}
                </span>
              ),
            },
            {
              key: "order",
              header: "Order",
              align: "right",
              cell: (v) =>
                v.order ? (
                  <div className="text-xs">
                    {v.order.number}
                    <span className="text-content-muted block">
                      <Money cents={v.order.totalCents} compact />
                    </span>
                  </div>
                ) : (
                  <span className="text-content-muted text-xs">—</span>
                ),
            },
          ]}
          rows={todayVisits}
          getRowKey={(v) => v.id}
          caption="Visits scheduled today"
          empty={{ title: "No visits scheduled for today" }}
        />
      </div>

      <div>
        <SectionHeading title="Rep performance" description="Last 30 days, against monthly targets" />
        <div className="grid gap-4 sm:grid-cols-2">
          {reps.map((r) => {
            const target = targetByRep.get(r.repId);
            return (
              <article key={r.repId} className="rounded-lg border border-border bg-surface p-5 shadow-sm">
                <div className="flex items-baseline justify-between">
                  <p className="font-medium">{r.repName}</p>
                  <p className="text-content-muted text-xs">
                    {r.ordersCount} orders · {r.visitsCompleted}/{r.visitsPlanned} visits
                  </p>
                </div>

                <div className="mt-4 space-y-3">
                  <div>
                    <div className="mb-1 flex justify-between text-xs">
                      <span className="text-content-text-content-muted">Sales</span>
                      <span>
                        <Money cents={r.salesCents} compact />
                        {target ? (
                          <span className="text-content-text-content-muted">
                            {" "}
                            / <Money cents={target.targetSalesCents} compact />
                          </span>
                        ) : null}
                      </span>
                    </div>
                    <Meter
                      value={r.salesCents}
                      max={target?.targetSalesCents ?? Math.max(r.salesCents, 1)}
                    />
                  </div>

                  <div>
                    <div className="mb-1 flex justify-between text-xs">
                      <span className="text-content-text-content-muted">Collections</span>
                      <span>
                        <Money cents={r.collectionsCents} compact />
                        {target ? (
                          <span className="text-content-text-content-muted">
                            {" "}
                            / <Money cents={target.targetCollectionCents} compact />
                          </span>
                        ) : null}
                      </span>
                    </div>
                    <Meter
                      value={r.collectionsCents}
                      max={target?.targetCollectionCents ?? Math.max(r.collectionsCents, 1)}
                      tone="accent"
                    />
                  </div>

                  <div>
                    <div className="mb-1 flex justify-between text-xs">
                      <span className="text-content-text-content-muted">Visit completion</span>
                      <span>{(r.completionRate * 100).toFixed(0)}%</span>
                    </div>
                    <Meter value={r.visitsCompleted} max={Math.max(r.visitsPlanned, 1)} />
                  </div>

                  {geofencing ? (
                    <div>
                      <div className="mb-1 flex justify-between text-xs">
                        <span className="text-content-text-content-muted">GPS verification</span>
                        <span className={r.verificationRate < 0.8 ? "text-warning" : ""}>
                          {(r.verificationRate * 100).toFixed(0)}%
                        </span>
                      </div>
                      <Meter
                        value={r.visitsVerified}
                        max={Math.max(r.visitsCompleted, 1)}
                        tone={r.verificationRate < 0.8 ? "warning" : "accent"}
                      />
                    </div>
                  ) : null}
                </div>
              </article>
            );
          })}
        </div>
      </div>

      <div>
        <SectionHeading title="Recent check-ins" description="Evidence trail across the team" />
        <DataTable
          columns={[
            {
              key: "when",
              header: "When",
              cell: (v) => (
                <span className="text-content-muted text-xs">
                  {v.checkInAt?.toLocaleString("en-KE", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}
                </span>
              ),
            },
            { key: "rep", header: "Rep", hideBelow: "sm", cell: (v) => <span className="text-xs">{v.rep.name}</span> },
            {
              key: "customer",
              header: "Customer",
              cell: (v) => <CellStack primary={v.customer.name} secondary={v.customer.town ?? ""} />,
            },
            { key: "status", header: "Status", cell: (v) => <StatusBadge status={v.status} /> },
            {
              key: "verified",
              header: "Verified",
              cell: (v) =>
                v.geofenceVerified ? (
                  <span className="badge bg-success-bg text-success border-success-border">verified</span>
                ) : (
                  <span className="badge bg-danger-bg text-danger border-danger-border">unverified</span>
                ),
            },
            {
              key: "distance",
              header: "Distance from pin",
              align: "right",
              hideBelow: "md",
              cell: (v) => (
                <span className={(v.distanceFromCustomerM ?? 0) > 200 ? "text-warning" : "text-content-muted"}>
                  {v.distanceFromCustomerM != null ? `${v.distanceFromCustomerM}m` : "—"}
                </span>
              ),
            },
            {
              key: "duration",
              header: "Duration",
              align: "right",
              hideBelow: "lg",
              cell: (v) => (
                <span className="text-content-muted text-xs">
                  {v.durationMin != null ? `${v.durationMin}m` : "—"}
                </span>
              ),
            },
          ]}
          rows={recentVisits}
          getRowKey={(v) => v.id}
          caption="Recent check-ins"
          empty={{ title: "No check-ins yet" }}
        />
      </div>
    </div>
  );
}

