
import {
  GeoMap,
  ModuleLocked,
  SectionHeading,
  StatCard,
  StatusBadge,
} from "@/components/ui";
import { db } from "@/lib/db";
import { parseBoundary } from "@/lib/geo";
import { requireTenant } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * Modules 07 & 08 · Smart Routing and Geofencing.
 *
 * Combined on one screen because they answer the same question from two sides:
 * where the rep was supposed to go, and where they actually were.
 */
export default async function RoutingPage() {
  const { companyId, principal } = await requireTenant();
  if (!principal.enabledModules.has("ROUTING")) return <ModuleLocked module="ROUTING" />;

  const geofencing = principal.enabledModules.has("GEOFENCING");

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today.getTime() + 86_400_000);

  const selfScope = principal.role === "FIELD_REP" ? { repId: principal.userId } : {};

  const [routes, territories, events, pings] = await Promise.all([
    db.route.findMany({
      where: { companyId, ...selfScope, routeDate: { gte: today, lt: tomorrow } },
      include: {
        rep: { select: { id: true, name: true } },
        territory: true,
        stops: {
          include: {
            customer: { select: { id: true, name: true, latitude: true, longitude: true } },
          },
          orderBy: { sequence: "asc" },
        },
      },
      orderBy: { createdAt: "asc" },
    }),
    db.territory.findMany({ where: { companyId, active: true } }),
    geofencing
      ? db.geofenceEvent.findMany({
          where: { companyId, ...(principal.role === "FIELD_REP" ? { userId: principal.userId } : {}) },
          include: {
            user: { select: { name: true } },
            territory: { select: { name: true } },
          },
          orderBy: { occurredAt: "desc" },
          take: 30,
        })
      : Promise.resolve([]),
    db.locationPing.count({
      where: { companyId, recordedAt: { gte: today } },
    }),
  ]);

  const totalDistanceM = routes.reduce((s, r) => s + r.totalDistanceM, 0);
  const totalStops = routes.reduce((s, r) => s + r.stops.length, 0);
  const doneStops = routes.reduce(
    (s, r) => s + r.stops.filter((x) => x.status === "DONE").length,
    0,
  );

  const rejected = events.filter(
    (e) => e.type === "VISIT_REJECTED" || e.type === "OUT_OF_ZONE",
  ).length;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Routing &amp; Geofencing</h1>
        <p className="text-content-muted text-sm">
          Distance-based route sequencing, daily itineraries and territory verification.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Routes today" value={String(routes.length)} />
        <StatCard
          label="Planned distance"
          value={`${(totalDistanceM / 1000).toFixed(1)} km`}
          hint="Road estimate, 1.35× crow-flight"
        />
        <StatCard
          label="Stops completed"
          value={`${doneStops} / ${totalStops}`}
          tone={doneStops === totalStops && totalStops > 0 ? "success" : "neutral"}
        />
        <StatCard
          label={geofencing ? "Geofence exceptions" : "Location pings today"}
          value={String(geofencing ? rejected : pings)}
          hint={geofencing ? "Rejected check-ins or out-of-zone" : "Background breadcrumbs"}
          tone={geofencing && rejected > 0 ? "warning" : "neutral"}
        />
      </div>

      {routes.length === 0 ? (
        <div className="rounded-lg border border-border bg-surface shadow-sm p-10 text-center">
          <p className="text-content-muted text-sm">
            No routes planned for today. Routes are built from customers with GPS
            pins, sequenced by distance.
          </p>
        </div>
      ) : (
        routes.map((route) => (
          <div key={route.id}>
            <SectionHeading
              title={`${route.name} — ${route.rep.name}`}
              description={`${route.stops.length} stops · ${(route.totalDistanceM / 1000).toFixed(1)} km · ~${route.estimatedMin} min driving`}
              actions={<StatusBadge status={route.status} />}
            />

            <div className="grid gap-6 lg:grid-cols-5">
              <div className="lg:col-span-3">
                <GeoMap
                  points={route.stops
                    .filter((s) => s.customer.latitude != null)
                    .map((s) => ({
                      id: s.customerId,
                      lat: s.customer.latitude!,
                      lng: s.customer.longitude!,
                      label: s.customer.name,
                      sequence: s.sequence,
                      tone:
                        s.status === "DONE"
                          ? "success"
                          : s.status === "ARRIVED"
                            ? "warning"
                            : s.status === "SKIPPED"
                              ? "danger"
                              : "neutral",
                    }))}
                  path={route.stops.map((s) => s.customerId)}
                  polygons={
                    route.territory
                      ? [
                          {
                            id: route.territory.id,
                            colour: route.territory.colour,
                            vertices: parseBoundary(route.territory.boundary).map(
                              (v) => [v.lat, v.lng] as [number, number],
                            ),
                          },
                        ].filter((p) => p.vertices.length >= 3)
                      : []
                  }
                  height={380}
                />
              </div>

              <div className="scroll-x rounded-lg border border-border bg-surface shadow-sm lg:col-span-2">
                <table className="w-full border-collapse text-base">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Stop</th>
                      <th>Planned</th>
                      <th>Leg</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {route.stops.map((s) => (
                      <tr key={s.id}>
                        <td className="font-semibold">{s.sequence}</td>
                        <td>{s.customer.name}</td>
                        <td className="text-content-muted text-xs">
                          {s.plannedAt?.toLocaleTimeString("en-KE", {
                            hour: "2-digit",
                            minute: "2-digit",
                          }) ?? "—"}
                        </td>
                        <td className="text-content-muted text-xs">
                          {(s.legDistanceM / 1000).toFixed(1)} km · {s.legMin}m
                        </td>
                        <td>
                          <StatusBadge status={s.status} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        ))
      )}

      <div>
        <SectionHeading title="Territories" description="Fences used to verify field activity" />
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {territories.map((t) => {
            const polygon = parseBoundary(t.boundary);
            return (
              <div key={t.id} className="rounded-lg border border-border bg-surface p-4 shadow-sm">
                <div className="flex items-center gap-2">
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: t.colour }} />
                  <p className="text-sm font-medium">{t.name}</p>
                </div>
                <p className="text-content-muted mt-1 text-xs">
                  {polygon.length >= 3
                    ? `Polygon fence, ${polygon.length} vertices`
                    : t.centerLat != null
                      ? `Circular fence, ${(t.radiusM / 1000).toFixed(0)} km radius`
                      : "No fence configured"}
                </p>
              </div>
            );
          })}
        </div>
      </div>

      {geofencing ? (
        <div>
          <SectionHeading
            title="Geofence events"
            description="Written by check-in, never by the client — this is the evidence trail"
          />
          <div className="scroll-x rounded-lg border border-border bg-surface shadow-sm">
            <table className="w-full border-collapse text-base">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Rep</th>
                  <th>Event</th>
                  <th>Territory</th>
                  <th>Detail</th>
                  <th>Position</th>
                </tr>
              </thead>
              <tbody>
                {events.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="text-content-muted py-10 text-center">
                      No geofence events recorded yet
                    </td>
                  </tr>
                ) : (
                  events.map((e) => (
                    <tr key={e.id}>
                      <td className="text-content-muted text-xs">
                        {e.occurredAt.toLocaleString("en-KE", {
                          day: "2-digit", month: "short",
                          hour: "2-digit", minute: "2-digit",
                        })}
                      </td>
                      <td className="text-xs">{e.user.name}</td>
                      <td>
                        <StatusBadge status={e.type} />
                      </td>
                      <td className="text-xs">{e.territory?.name ?? "—"}</td>
                      <td className="text-content-muted text-xs">{e.detail ?? "—"}</td>
                      <td className="text-content-muted font-mono text-[11px]">
                        {e.latitude.toFixed(4)}, {e.longitude.toFixed(4)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="rounded-lg border border-border bg-surface p-6 shadow-sm">
          <p className="text-content-muted text-sm">
            Territory zones, alerts and verified-visit reporting are part of{" "}
            <strong>Module 08 · Geofencing &amp; Location Intel</strong>, which is
            not included in this subscription. Routes are still planned and
            sequenced; check-in positions are recorded but not verified.
          </p>
        </div>
      )}
    </div>
  );
}

