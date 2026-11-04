import {
  ButtonLink,
  CellStack,
  DataTable,
  ModuleLocked,
  PageHeader,
  SectionHeading,
  StatCard,
  StatGrid,
  StatusBadge,
  TileMap,
  type Column,
  type MapPoint,
  type MapTrack,
} from "@/components/ui";
import { db } from "@/lib/db";
import { parseBoundary } from "@/lib/geo";
import { toClientConfig } from "@/lib/maps";
import { can } from "@/lib/rbac";
import { requireTenant } from "@/lib/session";
import { tableHref, tableState, toggleSort, type TableState } from "@/lib/table";
import {
  chronological,
  distanceVariance,
  downsample,
  dropInaccurate,
  stalenessLabel,
  trackColour,
} from "@/lib/tracking";
import { mapConfigFor } from "@/server/maps";
import { latestPositions, type LivePosition } from "@/server/tracking";

import { LiveRefresh } from "./live-refresh";
import { RoutePlanDialog } from "./route-dialog";

export const dynamic = "force-dynamic";

/** Points per drawn trail. Enough to follow the streets; light enough to ship. */
const TRAIL_POINTS = 1200;

const fmtTime = (d: Date | null | undefined) =>
  d ? d.toLocaleTimeString("en-KE", { hour: "2-digit", minute: "2-digit" }) : "—";
const km = (m: number | null | undefined) => (m == null ? "—" : `${(m / 1000).toFixed(1)} km`);

/** In-memory sort for tables whose rows are already loaded (stops, live). */
function sortRows<T>(
  rows: T[],
  ts: TableState,
  accessors: Record<string, (row: T) => string | number | null | undefined>,
): T[] {
  const get = ts.sort ? accessors[ts.sort] : undefined;
  if (!get) return rows;
  const dir = ts.dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = get(a);
    const y = get(b);
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    if (typeof x === "number" && typeof y === "number") return (x - y) * dir;
    return String(x).localeCompare(String(y)) * dir;
  });
}

function pageOf<T>(rows: T[], ts: TableState): T[] {
  return rows.slice((ts.page - 1) * ts.limit, ts.page * ts.limit);
}

/**
 * Modules 07 & 08 · Smart Routing, Geofencing and vehicle tracking.
 *
 * Combined on one screen because they answer the same question from three
 * sides: where the rep was supposed to go, where the van actually went, and
 * whether the check-ins happened at the customer.
 */
export default async function RoutingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { companyId, principal } = await requireTenant();
  if (!principal.enabledModules.has("ROUTING")) return <ModuleLocked module="ROUTING" />;

  const params = await searchParams;
  const geofencing = principal.enabledModules.has("GEOFENCING");

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today.getTime() + 86_400_000);

  const isRep = principal.role === "FIELD_REP";
  const selfScope = isRep ? { repId: principal.userId } : {};
  const selfUser = isRep ? { userId: principal.userId } : {};

  const gfState = tableState(params, {
    prefix: "gf",
    allowed: ["when", "rep", "event", "territory"],
    defaultSort: "when",
    defaultDir: "desc",
    limit: 10,
  });
  const gfOrderBy: Record<string, unknown> =
    gfState.sort === "rep"
      ? { user: { name: gfState.dir } }
      : gfState.sort === "event"
        ? { type: gfState.dir }
        : gfState.sort === "territory"
          ? { territory: { name: gfState.dir } }
          : { occurredAt: gfState.dir };

  const [routes, territories, events, eventCount, pings, pingCount, reps, vehicles, maps, live] =
    await Promise.all([
      db.route.findMany({
        where: { companyId, ...selfScope, routeDate: { gte: today, lt: tomorrow } },
        include: {
          rep: { select: { id: true, name: true } },
          territory: true,
          vehicle: { select: { id: true, plate: true, make: true, model: true } },
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
            where: { companyId, ...selfUser },
            include: {
              user: { select: { name: true } },
              territory: { select: { name: true } },
            },
            orderBy: gfOrderBy,
            take: gfState.limit,
            skip: (gfState.page - 1) * gfState.limit,
          })
        : Promise.resolve([]),
      geofencing ? db.geofenceEvent.count({ where: { companyId, ...selfUser } }) : Promise.resolve(0),
      db.locationPing.findMany({
        where: { companyId, ...selfUser, recordedAt: { gte: today, lt: tomorrow } },
        select: {
          userId: true,
          routeId: true,
          latitude: true,
          longitude: true,
          accuracyM: true,
          recordedAt: true,
        },
        orderBy: { recordedAt: "asc" },
        take: 20_000,
      }),
      db.locationPing.count({ where: { companyId, recordedAt: { gte: today } } }),
      db.user.findMany({
        where: { companyId, status: "ACTIVE", role: "FIELD_REP" },
        select: { id: true, name: true },
        orderBy: { name: "asc" },
      }),
      db.vehicle.findMany({
        where: { companyId, active: true },
        select: { id: true, plate: true, make: true, model: true, defaultRepId: true },
        orderBy: { plate: "asc" },
      }),
      mapConfigFor(companyId),
      geofencing ? latestPositions(principal) : Promise.resolve([] as LivePosition[]),
    ]);

  // ── trails ───────────────────────────────────────────────────────────
  const usable = chronological(dropInaccurate(pings));
  const byRep = new Map<string, Array<[number, number]>>();
  const byRoute = new Map<string, Array<[number, number]>>();
  for (const p of usable) {
    const coord: [number, number] = [p.latitude, p.longitude];
    byRep.set(p.userId, [...(byRep.get(p.userId) ?? []), coord]);
    if (p.routeId) byRoute.set(p.routeId, [...(byRoute.get(p.routeId) ?? []), coord]);
  }
  const trailFor = (route: (typeof routes)[number]): MapTrack[] => {
    // Stamped pings first; a route planned after the van left still shows the
    // rep's day as its trail.
    const coords = byRoute.get(route.id) ?? byRep.get(route.repId) ?? [];
    return coords.length > 1
      ? [{ id: route.id, colour: trackColour(route.repId), coords: downsample(coords, TRAIL_POINTS) }]
      : [];
  };

  // ── headline numbers ─────────────────────────────────────────────────
  const totalDistanceM = routes.reduce((s, r) => s + r.totalDistanceM, 0);
  const totalStops = routes.reduce((s, r) => s + r.stops.length, 0);
  const doneStops = routes.reduce((s, r) => s + r.stops.filter((x) => x.status === "DONE").length, 0);
  const rejected = events.filter((e) => e.type === "VISIT_REJECTED" || e.type === "OUT_OF_ZONE").length;

  // ── live tracking table ──────────────────────────────────────────────
  const liveState = tableState(params, {
    prefix: "live",
    allowed: ["rep", "vehicle", "seen", "speed", "battery", "progress"],
    defaultSort: "rep",
    defaultDir: "asc",
    limit: 10,
  });
  const liveSorted = sortRows(live, liveState, {
    rep: (p) => p.repName,
    vehicle: (p) => p.vehicle?.plate ?? null,
    seen: (p) => -p.stalenessS,
    speed: (p) => p.speedKmh,
    battery: (p) => p.batteryPct,
    progress: (p) => (p.route && p.route.total > 0 ? p.route.done / p.route.total : null),
  });
  const liveRows = pageOf(liveSorted, liveState);
  const liveHref = (key: string) => {
    const next = toggleSort(liveState, key);
    return tableHref("/app/routes", params, { live_sort: next.sort, live_dir: next.dir }, "live");
  };

  const liveColumns: Array<Column<LivePosition>> = [
    {
      key: "rep",
      header: "Rep",
      sortKey: "rep",
      cell: (p) => (
        <CellStack
          primary={
            <span className="inline-flex items-center gap-2">
              <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: trackColour(p.userId) }} />
              {p.repName}
            </span>
          }
          secondary={p.route ? p.route.name : "No route today"}
        />
      ),
    },
    {
      key: "vehicle",
      header: "Vehicle",
      hideBelow: "sm",
      sortKey: "vehicle",
      cell: (p) =>
        p.vehicle ? (
          <CellStack
            primary={<span className="font-mono text-sm tracking-wide">{p.vehicle.plate}</span>}
            secondary={[p.vehicle.make, p.vehicle.model].filter(Boolean).join(" ")}
          />
        ) : (
          <span className="text-content-muted text-xs">On foot / unassigned</span>
        ),
    },
    {
      key: "seen",
      header: "Last seen",
      sortKey: "seen",
      cell: (p) => (
        <CellStack
          primary={
            <span className={p.tone === "success" ? "text-success" : p.tone === "warning" ? "text-warning" : "text-danger"}>
              {stalenessLabel(p.stalenessS)}
            </span>
          }
          secondary={fmtTime(p.recordedAt)}
        />
      ),
    },
    {
      key: "speed",
      header: "Speed",
      align: "right",
      numeric: true,
      hideBelow: "md",
      sortKey: "speed",
      cell: (p) => (
        <span className={p.speedKmh == null ? "text-content-muted" : ""}>
          {p.speedKmh == null ? "—" : p.isMoving ? `${p.speedKmh} km/h` : "stopped"}
        </span>
      ),
    },
    {
      key: "battery",
      header: "Battery",
      align: "right",
      numeric: true,
      hideBelow: "md",
      sortKey: "battery",
      cell: (p) => (
        <span className={p.batteryPct == null ? "text-content-muted" : p.batteryPct < 20 ? "text-danger font-medium" : ""}>
          {p.batteryPct == null ? "—" : `${p.batteryPct}%`}
        </span>
      ),
    },
    {
      key: "progress",
      header: "Route progress",
      align: "right",
      sortKey: "progress",
      cell: (p) =>
        p.route ? (
          <CellStack
            primary={`${p.route.done} / ${p.route.total} stops`}
            secondary={p.route.skipped ? `${p.route.skipped} skipped` : <StatusBadge status={p.route.status} />}
          />
        ) : (
          <span className="text-content-muted text-xs">—</span>
        ),
    },
  ];

  const livePoints: MapPoint[] = live.map((p) => ({
    id: `live-${p.userId}`,
    lat: p.latitude,
    lng: p.longitude,
    label: p.repName,
    kind: "vehicle",
    tone: p.tone,
    detail: `${p.vehicle ? `${p.vehicle.plate} · ` : ""}${stalenessLabel(p.stalenessS)}${
      p.speedKmh != null && p.isMoving ? ` · ${p.speedKmh} km/h` : ""
    }`,
  }));
  const liveTracks: MapTrack[] = [...byRep.entries()]
    .filter(([, coords]) => coords.length > 1)
    .map(([userId, coords]) => ({ id: `trail-${userId}`, colour: trackColour(userId), coords: downsample(coords, TRAIL_POINTS) }));

  // ── geofence events table ────────────────────────────────────────────
  const gfHref = (key: string) => {
    const next = toggleSort(gfState, key);
    return tableHref("/app/routes", params, { gf_sort: next.sort, gf_dir: next.dir }, "gf");
  };
  type EventRow = (typeof events)[number];
  const gfColumns: Array<Column<EventRow>> = [
    {
      key: "when",
      header: "When",
      sortKey: "when",
      cell: (e) => (
        <span className="text-content-muted text-xs">
          {e.occurredAt.toLocaleString("en-KE", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}
        </span>
      ),
    },
    { key: "rep", header: "Rep", sortKey: "rep", cell: (e) => <span className="text-xs">{e.user.name}</span> },
    { key: "event", header: "Event", sortKey: "event", cell: (e) => <StatusBadge status={e.type} /> },
    {
      key: "territory",
      header: "Territory",
      hideBelow: "sm",
      sortKey: "territory",
      cell: (e) => <span className="text-xs">{e.territory?.name ?? "—"}</span>,
    },
    {
      key: "detail",
      header: "Detail",
      hideBelow: "md",
      cell: (e) => <span className="text-content-muted text-xs">{e.detail ?? "—"}</span>,
    },
    {
      key: "position",
      header: "Position",
      align: "right",
      hideBelow: "lg",
      cell: (e) => (
        <span className="text-content-muted font-mono text-[11px]">
          {e.latitude.toFixed(4)}, {e.longitude.toFixed(4)}
        </span>
      ),
    },
  ];

  return (
    <div className="space-y-8">
      <PageHeader
        title="Routing & Geofencing"
        description="Distance-based route sequencing, live vehicle tracking, daily itineraries and territory verification."
        actions={
          <>
            {can(principal, "vehicle:read") ? (
              <ButtonLink href="/app/settings/vehicles" variant="secondary" size="sm">
                Vehicles
              </ButtonLink>
            ) : null}
            {can(principal, "route:write") ? (
              <RoutePlanDialog
                reps={reps}
                territories={territories.map((t) => ({ id: t.id, name: t.name }))}
                vehicles={vehicles.map((v) => ({
                  id: v.id,
                  name: [v.plate, v.make, v.model].filter(Boolean).join(" "),
                  defaultRepId: v.defaultRepId,
                }))}
              />
            ) : null}
          </>
        }
      />

      <StatGrid>
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
          value={String(geofencing ? rejected : pingCount)}
          hint={geofencing ? "Rejected check-ins or out-of-zone" : "Background breadcrumbs"}
          tone={geofencing && rejected > 0 ? "warning" : "neutral"}
        />
      </StatGrid>

      {geofencing ? (
        <div>
          <SectionHeading
            title="Live tracking"
            description={`${live.length} rep${live.length === 1 ? "" : "s"} reporting today · ${pingCount.toLocaleString("en-KE")} breadcrumbs`}
            actions={<LiveRefresh />}
          />
          <div className="grid gap-6 lg:grid-cols-5">
            <div className="lg:col-span-3">
              <TileMap
                map={toClientConfig(maps)}
                points={livePoints}
                tracks={liveTracks}
                polygons={territories
                  .map((t) => ({
                    id: t.id,
                    colour: t.colour,
                    vertices: parseBoundary(t.boundary).map((v) => [v.lat, v.lng] as [number, number]),
                  }))
                  .filter((p) => p.vertices.length >= 3)}
                height={400}
              />
              <p className="text-content-muted mt-1.5 text-xs">
                Van pins are green under 15 minutes old, amber under an hour, red beyond. Solid lines
                are today&apos;s driven trails; fixes worse than 100 m are left out.
              </p>
            </div>
            <div className="lg:col-span-2">
              <DataTable
                columns={liveColumns}
                rows={liveRows}
                getRowKey={(p) => p.userId}
                caption="Reps reporting location today"
                dense
                sort={{ key: liveState.sort, dir: liveState.dir }}
                sortHrefFor={liveHref}
                pagination={{
                  page: liveState.page,
                  pages: Math.max(1, Math.ceil(live.length / liveState.limit)),
                  total: live.length,
                  limit: liveState.limit,
                  hrefFor: (p) => tableHref("/app/routes", params, { live_page: p }, undefined),
                }}
                empty={{
                  title: "No positions yet today",
                  description:
                    "Reps appear here once their handset starts sending breadcrumbs — tracking begins when the app opens for the day.",
                }}
              />
            </div>
          </div>
        </div>
      ) : null}

      {routes.length === 0 ? (
        <div className="rounded-lg border border-border bg-surface shadow-sm p-10 text-center">
          <p className="text-content-muted text-sm">
            No routes planned for today. Routes are built from customers with GPS
            pins, sequenced by distance.
          </p>
        </div>
      ) : (
        routes.map((route, index) => {
          const stopState = tableState(params, {
            prefix: `stop${index + 1}`,
            allowed: ["seq", "stop", "planned", "leg", "status"],
            defaultSort: "seq",
            defaultDir: "asc",
            limit: 10,
          });
          const stopsSorted = sortRows(route.stops, stopState, {
            seq: (s) => s.sequence,
            stop: (s) => s.customer.name,
            planned: (s) => s.plannedAt?.getTime() ?? null,
            leg: (s) => s.legDistanceM,
            status: (s) => s.status,
          });
          const stopRows = pageOf(stopsSorted, stopState);
          const stopHref = (key: string) => {
            const next = toggleSort(stopState, key);
            return tableHref(
              "/app/routes",
              params,
              { [`stop${index + 1}_sort`]: next.sort, [`stop${index + 1}_dir`]: next.dir },
              `stop${index + 1}`,
            );
          };
          type StopRow = (typeof route.stops)[number];
          const stopColumns: Array<Column<StopRow>> = [
            { key: "seq", header: "#", sortKey: "seq", width: "3rem", cell: (s) => <span className="font-semibold">{s.sequence}</span> },
            {
              key: "stop",
              header: "Stop",
              sortKey: "stop",
              cell: (s) => (
                <CellStack
                  primary={s.customer.name}
                  secondary={s.status === "SKIPPED" && s.skipReason ? `Skipped: ${s.skipReason}` : undefined}
                />
              ),
            },
            {
              key: "planned",
              header: "Planned",
              sortKey: "planned",
              hideBelow: "sm",
              cell: (s) => <span className="text-content-muted text-xs">{fmtTime(s.plannedAt)}</span>,
            },
            {
              key: "leg",
              header: "Leg",
              sortKey: "leg",
              align: "right",
              numeric: true,
              hideBelow: "md",
              cell: (s) => (
                <span className="text-content-muted text-xs">
                  {(s.legDistanceM / 1000).toFixed(1)} km · {s.legMin}m
                </span>
              ),
            },
            { key: "status", header: "Status", sortKey: "status", align: "right", cell: (s) => <StatusBadge status={s.status} /> },
          ];

          const variance = distanceVariance(route.totalDistanceM, route.actualDistanceM);
          const vehicleBits = route.vehicle
            ? [
                route.vehicle.plate,
                route.odometerStartKm != null || route.odometerEndKm != null
                  ? `odometer ${route.odometerStartKm?.toLocaleString("en-KE") ?? "?"} → ${route.odometerEndKm?.toLocaleString("en-KE") ?? "…"} km`
                  : null,
              ].filter(Boolean)
            : ["no vehicle"];
          const actualBits =
            route.actualDistanceM != null
              ? `driven ${km(route.actualDistanceM)} vs ${km(route.totalDistanceM)} planned${
                  variance ? ` (${variance.pct >= 0 ? "+" : ""}${variance.pct}%)` : ""
                }`
              : null;

          return (
            <div key={route.id}>
              <SectionHeading
                title={`${route.name} — ${route.rep.name}`}
                description={[
                  `${route.stops.length} stops · ${km(route.totalDistanceM)} · ~${route.estimatedMin} min driving`,
                  vehicleBits.join(" · "),
                  actualBits,
                ]
                  .filter(Boolean)
                  .join(" — ")}
                actions={
                  <>
                    <ButtonLink href={`/print/route-sheet/${route.id}`} target="_blank" variant="ghost" size="sm">
                      Route sheet
                    </ButtonLink>
                    <StatusBadge status={route.status} />
                  </>
                }
              />

              <div className="grid gap-6 lg:grid-cols-5">
                <div className="lg:col-span-3">
                  <TileMap
                    map={toClientConfig(maps)}
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
                            ? ("success" as const)
                            : s.status === "ARRIVED"
                              ? ("warning" as const)
                              : s.status === "SKIPPED"
                                ? ("danger" as const)
                                : ("neutral" as const),
                      }))}
                    path={route.stops.filter((s) => s.status !== "SKIPPED").map((s) => s.customerId)}
                    tracks={trailFor(route)}
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

                <div className="lg:col-span-2">
                  <DataTable
                    columns={stopColumns}
                    rows={stopRows}
                    getRowKey={(s) => s.id}
                    caption={`Stops on ${route.name}`}
                    dense
                    sort={{ key: stopState.sort, dir: stopState.dir }}
                    sortHrefFor={stopHref}
                    pagination={{
                      page: stopState.page,
                      pages: Math.max(1, Math.ceil(route.stops.length / stopState.limit)),
                      total: route.stops.length,
                      limit: stopState.limit,
                      hrefFor: (p) => tableHref("/app/routes", params, { [`stop${index + 1}_page`]: p }, undefined),
                    }}
                    empty={{ title: "No stops on this route" }}
                  />
                </div>
              </div>
            </div>
          );
        })
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
          <DataTable
            columns={gfColumns}
            rows={events}
            getRowKey={(e) => e.id}
            caption="Geofence events"
            sort={{ key: gfState.sort, dir: gfState.dir }}
            sortHrefFor={gfHref}
            pagination={{
              page: gfState.page,
              pages: Math.max(1, Math.ceil(eventCount / gfState.limit)),
              total: eventCount,
              limit: gfState.limit,
              hrefFor: (p) => tableHref("/app/routes", params, { gf_page: p }, undefined),
            }}
            empty={{ title: "No geofence events recorded yet" }}
          />
        </div>
      ) : (
        <div className="rounded-lg border border-border bg-surface p-6 shadow-sm">
          <p className="text-content-muted text-sm">
            Territory zones, alerts, live vehicle tracking and verified-visit reporting are part of{" "}
            <strong>Module 08 · Geofencing &amp; Location Intel</strong>, which is
            not included in this subscription. Routes are still planned and
            sequenced; check-in positions are recorded but not verified.
          </p>
        </div>
      )}
    </div>
  );
}
