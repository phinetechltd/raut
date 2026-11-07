import { notFound } from "next/navigation";

import {
  Badge,
  Button,
  ButtonLink,
  DataTable,
  FilterBar,
  FilterSelect,
  ModuleLocked,
  PageHeader,
  SectionHeading,
  StatCard,
  StatGrid,
  TileMap,
  type Column,
  type MapPoint,
  type MapTrack,
} from "@/components/ui";
import { ApiError } from "@/lib/api";
import { toClientConfig } from "@/lib/maps";
import { can } from "@/lib/rbac";
import { requireTenant } from "@/lib/session";
import { pageOf, preserved, sortRows, tableHref, tableState, toggleSort } from "@/lib/table";
import {
  MOVING_SPEED_MPS,
  downsample,
  durationLabel,
  nairobiDay,
  nairobiDayBounds,
  trackColour,
  type TripStop,
} from "@/lib/tracking";
import { mapConfigFor } from "@/server/maps";
import { vehicleTrack, type TrackPoint, type VehicleTrack } from "@/server/trackers";

import { LiveRefresh } from "../../routes/live-refresh";

export const dynamic = "force-dynamic";

const SOURCE_LABELS = { TRACKER: "GPS tracker", PHONE: "driver's phone" } as const;
const MAP_POINTS = 1500;

const timeOf = (d: Date | null | undefined) =>
  d
    ? d.toLocaleTimeString("en-KE", { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "Africa/Nairobi" })
    : "—";

function shiftDay(day: string, by: number): string {
  const { start } = nairobiDayBounds(day)!;
  return nairobiDay(new Date(start.getTime() + by * 86_400_000));
}

function isMoving(p: TrackPoint): boolean {
  return p.speedKmh != null && p.speedKmh > MOVING_SPEED_MPS * 3.6;
}

/** One vehicle's day: the trail it drove, how far, how long moving, where it stopped. */
export default async function VehicleTrackPage({
  params: routeParams,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { companyId, principal } = await requireTenant();
  if (!principal.enabledModules.has("ROUTING")) return <ModuleLocked module="ROUTING" />;
  if (!can(principal, "vehicle:track")) notFound();

  const { id } = await routeParams;
  const params = await searchParams;
  const today = nairobiDay();
  const requested = params.date && nairobiDayBounds(params.date) ? params.date : today;
  const date = requested > today ? today : requested;

  let track: VehicleTrack;
  try {
    track = await vehicleTrack(principal, id, date);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound();
    throw error;
  }
  const maps = await mapConfigFor(companyId);

  const path = `/app/tracking/${id}`;
  const { summary, points } = track;
  const last = points[points.length - 1];

  const colour = trackColour(id);
  const tracks: MapTrack[] =
    points.length > 1
      ? [
          {
            id: `trail-${id}`,
            colour,
            coords: downsample(points, MAP_POINTS).map((p) => [p.latitude, p.longitude] as [number, number]),
          },
        ]
      : [];
  const mapPoints: MapPoint[] = [
    ...summary.stops.map((s, index) => ({
      id: `stop-${index}`,
      lat: s.lat,
      lng: s.lng,
      label: `Stop ${index + 1}`,
      sequence: index + 1,
      tone: "warning" as const,
      detail: `${timeOf(s.arrivedAt)} to ${timeOf(s.departedAt)} · ${durationLabel(s.durationS)}`,
    })),
    ...(last
      ? [
          {
            id: "last",
            lat: last.latitude,
            lng: last.longitude,
            label: track.vehicle.plate,
            kind: "vehicle" as const,
            tone: "success" as const,
            detail: `Last position ${timeOf(last.recordedAt)}`,
          },
        ]
      : []),
  ];

  // ── stops table ──────────────────────────────────────────────────────
  type StopRow = TripStop & { number: number };
  const stopState = tableState(params, {
    prefix: "stop",
    allowed: ["number", "arrived", "duration"],
    defaultSort: "number",
    defaultDir: "asc",
    limit: 10,
  });
  const stopRows: StopRow[] = summary.stops.map((s, index) => ({ ...s, number: index + 1 }));
  const stopsSorted = sortRows(stopRows, stopState, {
    number: (s) => s.number,
    arrived: (s) => s.arrivedAt.getTime(),
    duration: (s) => s.durationS,
  });
  const stopColumns: Array<Column<StopRow>> = [
    { key: "number", header: "Stop", sortKey: "number", cell: (s) => <span>{s.number}</span> },
    { key: "arrived", header: "Arrived", sortKey: "arrived", cell: (s) => <span>{timeOf(s.arrivedAt)}</span> },
    { key: "departed", header: "Left", cell: (s) => <span>{timeOf(s.departedAt)}</span> },
    {
      key: "duration",
      header: "Stayed",
      align: "right",
      sortKey: "duration",
      cell: (s) => <span>{durationLabel(s.durationS)}</span>,
    },
    {
      key: "where",
      header: "Position",
      align: "right",
      hideBelow: "sm",
      cell: (s) => (
        <span className="font-mono text-xs">
          {s.lat.toFixed(5)}, {s.lng.toFixed(5)}
        </span>
      ),
    },
  ];

  // ── positions table ──────────────────────────────────────────────────
  const fixState = tableState(params, {
    prefix: "fix",
    allowed: ["time", "speed"],
    defaultSort: "time",
    defaultDir: "desc",
    limit: 15,
  });
  const fixesFiltered = points.filter((p) =>
    params.movement === "moving" ? isMoving(p) : params.movement === "stationary" ? !isMoving(p) : true,
  );
  const fixesSorted = sortRows(fixesFiltered, fixState, {
    time: (p) => p.recordedAt.getTime(),
    speed: (p) => p.speedKmh,
  });
  const fixColumns: Array<Column<TrackPoint>> = [
    { key: "time", header: "Time", sortKey: "time", cell: (p) => <span>{timeOf(p.recordedAt)}</span> },
    {
      key: "speed",
      header: "Speed",
      align: "right",
      numeric: true,
      sortKey: "speed",
      cell: (p) => <span>{p.speedKmh != null ? `${p.speedKmh} km/h` : "—"}</span>,
    },
    {
      key: "ignition",
      header: "Ignition",
      hideBelow: "sm",
      cell: (p) =>
        p.ignition === null ? (
          <span className="text-content-muted">—</span>
        ) : (
          <Badge tone={p.ignition ? "success" : "neutral"}>{p.ignition ? "On" : "Off"}</Badge>
        ),
    },
    {
      key: "where",
      header: "Position",
      align: "right",
      cell: (p) => (
        <span className="font-mono text-xs">
          {p.latitude.toFixed(5)}, {p.longitude.toFixed(5)}
        </span>
      ),
    },
  ];

  const name = [track.vehicle.make, track.vehicle.model].filter(Boolean).join(" ");

  return (
    <div className="space-y-8">
      <PageHeader
        title={track.vehicle.plate}
        description={[
          name,
          track.source ? `Trail from the ${SOURCE_LABELS[track.source]}` : "No positions on this day",
        ]
          .filter(Boolean)
          .join(" · ")}
        breadcrumb={{ href: "/app/tracking", label: "Vehicle tracking" }}
        actions={date === today ? <LiveRefresh source="fleet" intervalMs={30_000} /> : null}
      />

      <div className="flex flex-wrap items-center gap-2 print:hidden">
        <ButtonLink href={`${path}?date=${shiftDay(date, -1)}`} variant="secondary" size="sm">
          Previous day
        </ButtonLink>
        <form action={path} method="get" className="flex items-center gap-2">
          <label htmlFor="track-date" className="sr-only">
            Day to show
          </label>
          <input
            id="track-date"
            type="date"
            name="date"
            defaultValue={date}
            max={today}
            className="input h-8 w-auto text-sm"
          />
          <Button type="submit" variant="secondary" size="sm">
            Show
          </Button>
        </form>
        {date < today ? (
          <ButtonLink href={`${path}?date=${shiftDay(date, 1)}`} variant="secondary" size="sm">
            Next day
          </ButtonLink>
        ) : null}
      </div>

      <StatGrid>
        <StatCard label="Distance" value={`${(summary.distanceM / 1000).toFixed(1)} km`} />
        <StatCard label="Time moving" value={durationLabel(summary.movingS)} />
        <StatCard label="Top speed" value={summary.maxSpeedKmh != null ? `${summary.maxSpeedKmh} km/h` : "—"} />
        <StatCard
          label="Stops"
          value={String(summary.stops.length)}
          hint={summary.firstFixAt ? `${timeOf(summary.firstFixAt)} to ${timeOf(summary.lastFixAt)}` : undefined}
        />
      </StatGrid>

      <TileMap map={toClientConfig(maps)} points={mapPoints} tracks={tracks} height={460} />

      <div>
        <SectionHeading title="Stops" description="Five minutes or longer in one place." />
        <DataTable
          columns={stopColumns}
          rows={pageOf(stopsSorted, stopState)}
          getRowKey={(s) => String(s.number)}
          caption="Stops on this day"
          sort={{ key: stopState.sort, dir: stopState.dir }}
          sortHrefFor={(key) => {
            const next = toggleSort(stopState, key);
            return tableHref(path, params, { stop_sort: next.sort, stop_dir: next.dir }, "stop");
          }}
          pagination={{
            page: stopState.page,
            pages: Math.max(1, Math.ceil(stopRows.length / stopState.limit)),
            total: stopRows.length,
            limit: stopState.limit,
            hrefFor: (p) => tableHref(path, params, { stop_page: p }, undefined),
          }}
          empty={{ title: "No stops recorded", description: "No stay of five minutes or more on this day." }}
        />
      </div>

      <div>
        <SectionHeading title="Positions" description={`${summary.fixCount.toLocaleString("en-KE")} usable fixes on this day.`} />
        <FilterBar action={path} preserve={preserved(params, ["movement", "fix_page"])}>
          <FilterSelect
            name="movement"
            value={params.movement}
            allLabel="Moving and stationary"
            options={[
              { value: "moving", label: "Moving" },
              { value: "stationary", label: "Stationary" },
            ]}
          />
        </FilterBar>
        <DataTable
          columns={fixColumns}
          rows={pageOf(fixesSorted, fixState)}
          getRowKey={(p) => String(p.recordedAt.getTime())}
          caption="Positions on this day"
          sort={{ key: fixState.sort, dir: fixState.dir }}
          sortHrefFor={(key) => {
            const next = toggleSort(fixState, key);
            return tableHref(path, params, { fix_sort: next.sort, fix_dir: next.dir }, "fix");
          }}
          pagination={{
            page: fixState.page,
            pages: Math.max(1, Math.ceil(fixesFiltered.length / fixState.limit)),
            total: fixesFiltered.length,
            limit: fixState.limit,
            hrefFor: (p) => tableHref(path, params, { fix_page: p }, undefined),
          }}
          empty={{ title: "No positions", description: "This vehicle did not report on this day." }}
        />
      </div>
    </div>
  );
}
