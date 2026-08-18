
import {
  GeoMap,
  Meter,
  ModuleLocked,
  Money,
  SectionHeading,
  StatCard,
  StatusBadge,
} from "@/components/ui";
import { db } from "@/lib/db";
import { requireTenant } from "@/lib/session";
import { repPerformance } from "@/server/field";

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

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Field Sales</h1>
        <p className="text-content-muted text-sm">
          Visit scheduling and check-in, field order capture, targets and performance.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
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
      </div>

      <div>
        <SectionHeading
          title="Today in the field"
          description="Live positions of scheduled and completed visits"
        />
        <GeoMap
          points={todayVisits
            .filter((v) => v.customer.latitude != null)
            .map((v, i) => ({
              id: v.id,
              lat: v.customer.latitude!,
              lng: v.customer.longitude!,
              label: v.customer.name,
              sequence: i + 1,
              tone:
                v.status === "COMPLETED"
                  ? "success"
                  : v.status === "IN_PROGRESS"
                    ? "warning"
                    : v.status === "MISSED"
                      ? "danger"
                      : "neutral",
            }))}
          height={380}
        />
      </div>

      <div>
        <SectionHeading title="Today's visits" />
        <div className="scroll-x rounded-lg border border-border bg-surface shadow-sm">
          <table className="w-full border-collapse text-base">
            <thead>
              <tr>
                <th>Time</th>
                <th>Customer</th>
                <th>Rep</th>
                <th>Status</th>
                <th>Checked in</th>
                <th>Verified</th>
                <th>Distance</th>
                <th>Order</th>
              </tr>
            </thead>
            <tbody>
              {todayVisits.length === 0 ? (
                <tr>
                  <td colSpan={8} className="text-content-muted py-10 text-center">
                    No visits scheduled for today
                  </td>
                </tr>
              ) : (
                todayVisits.map((v) => (
                  <tr key={v.id}>
                    <td className="font-medium">
                      {v.scheduledAt.toLocaleTimeString("en-KE", {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </td>
                    <td>
                      {v.customer.name}
                      <span className="text-content-muted block text-xs">{v.customer.town}</span>
                    </td>
                    <td className="text-xs">{v.rep.name}</td>
                    <td>
                      <StatusBadge status={v.status} />
                    </td>
                    <td className="text-content-muted text-xs">
                      {v.checkInAt
                        ? v.checkInAt.toLocaleTimeString("en-KE", {
                            hour: "2-digit",
                            minute: "2-digit",
                          })
                        : "—"}
                    </td>
                    <td>
                      {v.geofenceVerified ? (
                        <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium bg-success-bg text-success">yes</span>
                      ) : v.checkInAt ? (
                        <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium bg-danger-bg text-danger">no</span>
                      ) : (
                        <span className="text-content-muted text-xs">—</span>
                      )}
                    </td>
                    <td className="text-content-muted text-xs">
                      {v.distanceFromCustomerM != null ? `${v.distanceFromCustomerM}m` : "—"}
                    </td>
                    <td className="text-xs">
                      {v.order ? (
                        <>
                          {v.order.number}
                          <span className="text-content-muted block">
                            <Money cents={v.order.totalCents} compact />
                          </span>
                        </>
                      ) : (
                        <span className="text-content-text-content-muted">—</span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
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
        <div className="scroll-x rounded-lg border border-border bg-surface shadow-sm">
          <table className="w-full border-collapse text-base">
            <thead>
              <tr>
                <th>When</th>
                <th>Rep</th>
                <th>Customer</th>
                <th>Status</th>
                <th>Verified</th>
                <th>Distance from pin</th>
                <th>Duration</th>
              </tr>
            </thead>
            <tbody>
              {recentVisits.map((v) => (
                <tr key={v.id}>
                  <td className="text-content-muted text-xs">
                    {v.checkInAt?.toLocaleString("en-KE", {
                      day: "2-digit", month: "short",
                      hour: "2-digit", minute: "2-digit",
                    })}
                  </td>
                  <td className="text-xs">{v.rep.name}</td>
                  <td>
                    {v.customer.name}
                    <span className="text-content-muted block text-xs">{v.customer.town}</span>
                  </td>
                  <td>
                    <StatusBadge status={v.status} />
                  </td>
                  <td>
                    {v.geofenceVerified ? (
                      <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium bg-success-bg text-success">verified</span>
                    ) : (
                      <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium bg-danger-bg text-danger">unverified</span>
                    )}
                  </td>
                  <td
                    className={
                      (v.distanceFromCustomerM ?? 0) > 200 ? "text-warning" : "muted"
                    }
                  >
                    {v.distanceFromCustomerM != null ? `${v.distanceFromCustomerM}m` : "—"}
                  </td>
                  <td className="text-content-text-content-muted">{v.durationMin != null ? `${v.durationMin}m` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

