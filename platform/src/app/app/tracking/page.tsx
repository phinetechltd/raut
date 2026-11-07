import Link from "next/link";
import { notFound } from "next/navigation";

import {
  Badge,
  ButtonLink,
  Callout,
  CellStack,
  DataTable,
  FilterBar,
  FilterSearch,
  FilterSelect,
  ModuleLocked,
  PageHeader,
  StatCard,
  StatGrid,
  TileMap,
  type Column,
  type MapPoint,
} from "@/components/ui";
import { toClientConfig } from "@/lib/maps";
import { can } from "@/lib/rbac";
import { requireTenant } from "@/lib/session";
import { pageOf, preserved, sortRows, tableHref, tableState, toggleSort } from "@/lib/table";
import {
  VEHICLE_STATUSES,
  VEHICLE_STATUS_LABELS,
  VEHICLE_STATUS_TONES,
  stalenessLabel,
  type VehicleStatus,
} from "@/lib/tracking";
import { mapConfigFor } from "@/server/maps";
import { fleetPositions, type FleetVehicle } from "@/server/trackers";

import { LiveRefresh } from "../routes/live-refresh";

export const dynamic = "force-dynamic";

const PATH = "/app/tracking";

const SOURCE_LABELS = { TRACKER: "Tracker", PHONE: "Driver's phone" } as const;

/** Map pins use the same green/amber/red language as the rest of the console. */
const PIN_TONES: Record<VehicleStatus, MapPoint["tone"]> = {
  MOVING: "success",
  IDLE: "warning",
  PARKED: "neutral",
  OFFLINE: "danger",
  NO_SIGNAL: "neutral",
};

function vehicleName(v: Pick<FleetVehicle, "make" | "model">): string {
  return [v.make, v.model].filter(Boolean).join(" ") || "—";
}

/**
 * Where the fleet is now. Each van shows its tracker's fix, or its driver's
 * phone where it has no tracker; vans with no position at all stay in the list
 * because a vehicle that has dropped off the map is the one to look for.
 */
export default async function VehicleTrackingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { companyId, principal } = await requireTenant();
  if (!principal.enabledModules.has("ROUTING")) return <ModuleLocked module="ROUTING" />;
  if (!can(principal, "vehicle:track")) notFound();

  const params = await searchParams;
  const [fleet, maps] = await Promise.all([fleetPositions(principal), mapConfigFor(companyId)]);

  const ts = tableState(params, {
    prefix: "fleet",
    allowed: ["plate", "status", "driver", "seen", "speed"],
    defaultSort: "plate",
    defaultDir: "asc",
    limit: 15,
  });

  const q = params.q?.trim().toLowerCase();
  const filtered = fleet.filter((v) => {
    if (params.status && v.status !== params.status) return false;
    if (params.source === "NONE" ? v.fix !== null : params.source && v.fix?.source !== params.source) return false;
    if (!q) return true;
    return [v.plate, v.make, v.model, v.driver?.name, v.tracker?.externalId]
      .filter(Boolean)
      .some((text) => String(text).toLowerCase().includes(q));
  });
  const sorted = sortRows(filtered, ts, {
    plate: (v) => v.plate,
    status: (v) => VEHICLE_STATUS_LABELS[v.status],
    driver: (v) => v.driver?.name ?? null,
    seen: (v) => (v.stalenessS === null ? null : -v.stalenessS),
    speed: (v) => v.fix?.speedKmh ?? null,
  });
  const rows = pageOf(sorted, ts);

  const count = (...statuses: VehicleStatus[]) => fleet.filter((v) => statuses.includes(v.status)).length;
  const points: MapPoint[] = filtered.flatMap((v) =>
    v.fix
      ? [
          {
            id: v.id,
            lat: v.fix.latitude,
            lng: v.fix.longitude,
            label: v.plate,
            kind: "vehicle" as const,
            tone: PIN_TONES[v.status],
            detail: [
              VEHICLE_STATUS_LABELS[v.status],
              v.fix.speedKmh != null && v.status === "MOVING" ? `${v.fix.speedKmh} km/h` : null,
              v.stalenessS != null ? stalenessLabel(v.stalenessS) : null,
              v.driver?.name,
            ]
              .filter(Boolean)
              .join(" · "),
          },
        ]
      : [],
  );

  const sortHrefFor = (key: string) => {
    const next = toggleSort(ts, key);
    return tableHref(PATH, params, { fleet_sort: next.sort, fleet_dir: next.dir }, "fleet");
  };

  const columns: Array<Column<FleetVehicle>> = [
    {
      key: "plate",
      header: "Vehicle",
      sortKey: "plate",
      cell: (v) => (
        <CellStack
          primary={
            <Link href={`${PATH}/${v.id}`} className="font-mono font-semibold tracking-wide hover:underline">
              {v.plate}
            </Link>
          }
          secondary={vehicleName(v)}
        />
      ),
    },
    {
      key: "status",
      header: "Status",
      sortKey: "status",
      cell: (v) => (
        <Badge tone={VEHICLE_STATUS_TONES[v.status]}>{VEHICLE_STATUS_LABELS[v.status]}</Badge>
      ),
    },
    {
      key: "driver",
      header: "Driver",
      sortKey: "driver",
      hideBelow: "md",
      cell: (v) => (
        <CellStack
          primary={<span className="text-sm">{v.driver?.name ?? "Unassigned"}</span>}
          secondary={v.route ? `${v.route.name} · ${v.route.done}/${v.route.total} stops` : "No route today"}
        />
      ),
    },
    {
      key: "seen",
      header: "Last position",
      sortKey: "seen",
      cell: (v) =>
        v.fix && v.stalenessS !== null ? (
          <CellStack
            primary={<span className="text-sm">{stalenessLabel(v.stalenessS)}</span>}
            secondary={SOURCE_LABELS[v.fix.source]}
          />
        ) : (
          <span className="text-content-muted text-xs">Never reported</span>
        ),
    },
    {
      key: "speed",
      header: "Speed",
      align: "right",
      numeric: true,
      sortKey: "speed",
      hideBelow: "sm",
      cell: (v) =>
        v.fix?.speedKmh != null ? (
          <span>{v.fix.speedKmh} km/h</span>
        ) : (
          <span className="text-content-muted">—</span>
        ),
    },
    {
      key: "actions",
      header: <span className="sr-only">Actions</span>,
      align: "right",
      cell: (v) => (
        <ButtonLink href={`${PATH}/${v.id}`} variant="ghost" size="sm">
          Track
        </ButtonLink>
      ),
    },
  ];

  const canManage = can(principal, "tracker:manage");
  const anyTracker = fleet.some((v) => v.tracker);

  return (
    <div className="space-y-8">
      <PageHeader
        title="Vehicle tracking"
        description="Where each vehicle is now, from its GPS tracker or its driver's phone."
        breadcrumb={{ href: "/app/routes", label: "Routing & Geofencing" }}
        actions={
          <>
            <LiveRefresh source="fleet" intervalMs={30_000} />
            {canManage ? (
              <ButtonLink href="/app/settings/trackers" variant="secondary" size="sm">
                Connect a tracker
              </ButtonLink>
            ) : null}
          </>
        }
      />

      <StatGrid>
        <StatCard label="Moving" value={String(count("MOVING"))} tone={count("MOVING") > 0 ? "success" : "neutral"} />
        <StatCard label="Idling" value={String(count("IDLE"))} hint="Ignition on, not moving" />
        <StatCard label="Parked" value={String(count("PARKED"))} />
        <StatCard
          label="Offline or no signal"
          value={String(count("OFFLINE", "NO_SIGNAL"))}
          tone={count("OFFLINE") > 0 ? "danger" : "neutral"}
          hint={`${fleet.length} vehicle${fleet.length === 1 ? "" : "s"} in all`}
        />
      </StatGrid>

      {canManage && !anyTracker ? (
        <Callout tone="info" title="No GPS trackers connected yet">
          These positions come from drivers&apos; phones, so a van is only visible while its driver is
          reporting. Connect tracker hardware under{" "}
          <Link href="/app/settings/trackers" className="underline">
            Settings → Vehicle trackers
          </Link>{" "}
          to follow the van itself.
        </Callout>
      ) : null}

      <div>
        <TileMap map={toClientConfig(maps)} points={points} height={440} />
        <p className="text-content-muted mt-1.5 text-xs">
          Green is moving, amber is idling, red is offline. Select a vehicle below for its trail and stops.
        </p>
      </div>

      <div>
        <FilterBar action={PATH} preserve={preserved(params, ["q", "status", "source", "fleet_page"])}>
          <FilterSearch name="q" value={params.q} placeholder="Search plate, driver, tracker…" />
          <FilterSelect
            name="status"
            value={params.status}
            allLabel="All statuses"
            options={VEHICLE_STATUSES.map((s) => ({ value: s, label: VEHICLE_STATUS_LABELS[s] }))}
          />
          <FilterSelect
            name="source"
            value={params.source}
            allLabel="All sources"
            options={[
              { value: "TRACKER", label: SOURCE_LABELS.TRACKER },
              { value: "PHONE", label: SOURCE_LABELS.PHONE },
              { value: "NONE", label: "No position" },
            ]}
          />
        </FilterBar>

        <DataTable
          columns={columns}
          rows={rows}
          getRowKey={(v) => v.id}
          caption="Fleet positions"
          sort={{ key: ts.sort, dir: ts.dir }}
          sortHrefFor={sortHrefFor}
          pagination={{
            page: ts.page,
            pages: Math.max(1, Math.ceil(filtered.length / ts.limit)),
            total: filtered.length,
            limit: ts.limit,
            hrefFor: (p) => tableHref(PATH, params, { fleet_page: p }, undefined),
          }}
          empty={{
            title: fleet.length === 0 ? "No vehicles to track" : "No vehicles match these filters",
            description:
              fleet.length === 0
                ? "Vehicles added under Settings → Vehicles appear here."
                : "Clear a filter to see more of the fleet.",
          }}
        />
      </div>
    </div>
  );
}
