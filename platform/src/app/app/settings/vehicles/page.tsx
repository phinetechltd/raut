import {
  ButtonLink,
  CellStack,
  DataTable,
  FilterBar,
  FilterSearch,
  FilterSelect,
  ModuleLocked,
  PageHeader,
  StatCard,
  StatGrid,
  StatusBadge,
  type Column,
} from "@/components/ui";
import { db } from "@/lib/db";
import { can } from "@/lib/rbac";
import { requireTenant } from "@/lib/session";
import { preserved, tableHref, tableState, toggleSort } from "@/lib/table";
import { distanceVariance } from "@/lib/tracking";
import { VEHICLE_TYPE_LABELS, type VehicleType } from "@/lib/vehicles";

import { VehicleDialog } from "./vehicle-dialog";

export const dynamic = "force-dynamic";

const SORT_COLUMNS: Record<string, "plate" | "type" | "odometerKm" | "active" | "updatedAt"> = {
  plate: "plate",
  type: "type",
  odometer: "odometerKm",
  status: "active",
  updated: "updatedAt",
};

/**
 * Settings → Vehicles. The fleet reps drive routes in: plates, usual driver,
 * running odometer, and how each van's last routes ran against plan.
 *
 * Linked from the Routing page header rather than the settings index, which
 * belongs to the platform's core settings; vehicles are a Module 07 concern.
 */
export default async function VehiclesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { companyId, principal } = await requireTenant();
  if (!principal.enabledModules.has("ROUTING")) return <ModuleLocked module="ROUTING" />;

  const params = await searchParams;
  const ts = tableState(params, {
    prefix: "veh",
    allowed: Object.keys(SORT_COLUMNS),
    defaultSort: "plate",
    defaultDir: "asc",
    limit: 15,
  });

  const where = {
    companyId,
    ...(params.q
      ? {
          OR: [
            { plate: { contains: params.q } },
            { make: { contains: params.q } },
            { model: { contains: params.q } },
          ],
        }
      : {}),
    ...(params.status === "active" ? { active: true } : params.status === "retired" ? { active: false } : {}),
  };

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const [vehicles, total, branches, reps, activeCount, routesToday] = await Promise.all([
    db.vehicle.findMany({
      where,
      include: {
        routes: {
          select: { id: true, routeDate: true, status: true, totalDistanceM: true, actualDistanceM: true },
          orderBy: { routeDate: "desc" },
          take: 5,
        },
        _count: { select: { routes: true } },
        tracker: { select: { externalId: true, active: true, lastSeenAt: true } },
      },
      orderBy: ts.sort ? { [SORT_COLUMNS[ts.sort]]: ts.dir } : { plate: "asc" },
      take: ts.limit,
      skip: (ts.page - 1) * ts.limit,
    }),
    db.vehicle.count({ where }),
    db.branch.findMany({ where: { companyId, active: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    db.user.findMany({
      where: { companyId, status: "ACTIVE", role: { in: ["FIELD_REP", "SALES_MANAGER", "BRANCH_MANAGER"] } },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
    db.vehicle.count({ where: { companyId, active: true } }),
    db.route.count({ where: { companyId, vehicleId: { not: null }, routeDate: { gte: today } } }),
  ]);

  const repName = new Map(reps.map((r) => [r.id, r.name]));
  const branchName = new Map(branches.map((b) => [b.id, b.name]));
  const canWrite = can(principal, "vehicle:write");

  const sortHrefFor = (key: string) => {
    const next = toggleSort(ts, key);
    return tableHref("/app/settings/vehicles", params, { veh_sort: next.sort, veh_dir: next.dir }, "veh");
  };

  type Row = (typeof vehicles)[number];
  const columns: Array<Column<Row>> = [
    {
      key: "plate",
      header: "Vehicle",
      sortKey: "plate",
      cell: (v) => (
        <CellStack
          primary={<span className="font-mono font-semibold tracking-wide">{v.plate}</span>}
          secondary={[v.make, v.model].filter(Boolean).join(" ") || "—"}
        />
      ),
    },
    {
      key: "type",
      header: "Type",
      hideBelow: "sm",
      sortKey: "type",
      cell: (v) => (
        <span className="badge bg-surface-sunken">
          {VEHICLE_TYPE_LABELS[v.type as VehicleType] ?? v.type}
        </span>
      ),
    },
    {
      key: "driver",
      header: "Usual driver",
      hideBelow: "md",
      cell: (v) => (
        <CellStack
          primary={<span className="text-sm">{v.defaultRepId ? repName.get(v.defaultRepId) ?? "—" : "Unassigned"}</span>}
          secondary={v.branchId ? branchName.get(v.branchId) ?? "" : ""}
        />
      ),
    },
    {
      key: "odometer",
      header: "Odometer",
      align: "right",
      numeric: true,
      sortKey: "odometer",
      cell: (v) => (
        <span className={v.odometerKm != null ? "" : "text-content-muted"}>
          {v.odometerKm != null ? `${v.odometerKm.toLocaleString("en-KE")} km` : "—"}
        </span>
      ),
    },
    {
      key: "routes",
      header: "Routes",
      align: "right",
      numeric: true,
      hideBelow: "lg",
      cell: (v) => {
        const measured = v.routes.filter((r) => r.actualDistanceM != null);
        const planned = measured.reduce((s, r) => s + r.totalDistanceM, 0);
        const actual = measured.reduce((s, r) => s + (r.actualDistanceM ?? 0), 0);
        const variance = distanceVariance(planned, measured.length ? actual : null);
        return (
          <CellStack
            primary={<span>{v._count.routes}</span>}
            secondary={
              variance
                ? `last ${measured.length}: ${variance.pct >= 0 ? "+" : ""}${variance.pct}% vs plan`
                : "no GPS-measured route yet"
            }
          />
        );
      },
    },
    {
      key: "tracker",
      header: "Tracker",
      hideBelow: "lg",
      cell: (v) =>
        v.tracker?.active ? (
          <CellStack
            primary={<span className="font-mono text-xs">{v.tracker.externalId}</span>}
            secondary={v.tracker.lastSeenAt ? "Reporting" : "Waiting for first report"}
          />
        ) : (
          <span className="text-content-muted text-xs">Driver&apos;s phone only</span>
        ),
    },
    {
      key: "status",
      header: "Status",
      align: "right",
      sortKey: "status",
      cell: (v) => <StatusBadge status={v.active ? "ACTIVE" : "RETIRED"} />,
    },
    ...(canWrite
      ? [
          {
            key: "actions",
            header: <span className="sr-only">Actions</span>,
            align: "right" as const,
            cell: (v: Row) => (
              <VehicleDialog
                mode="edit"
                branches={branches}
                reps={reps}
                vehicle={{
                  id: v.id,
                  plate: v.plate,
                  make: v.make,
                  model: v.model,
                  type: v.type,
                  branchId: v.branchId,
                  defaultRepId: v.defaultRepId,
                  odometerKm: v.odometerKm,
                  active: v.active,
                }}
              />
            ),
          } satisfies Column<Row>,
        ]
      : []),
  ];

  return (
    <div className="space-y-8">
      <PageHeader
        title="Vehicles"
        description="The fleet routes are planned on. Each vehicle's GPS trail and odometer are kept per plate."
        breadcrumb={{ href: "/app/routes", label: "Routing & Geofencing" }}
        actions={
          <>
            {can(principal, "vehicle:track") ? (
              <ButtonLink href="/app/tracking" variant="secondary" size="sm">
                Track vehicles
              </ButtonLink>
            ) : null}
            {can(principal, "tracker:manage") ? (
              <ButtonLink href="/app/settings/trackers" variant="secondary" size="sm">
                Trackers
              </ButtonLink>
            ) : null}
            {canWrite ? <VehicleDialog mode="create" branches={branches} reps={reps} /> : null}
          </>
        }
      />

      <StatGrid>
        <StatCard label="Vehicles" value={String(total)} />
        <StatCard label="Active" value={String(activeCount)} tone={activeCount > 0 ? "success" : "neutral"} />
        <StatCard label="Out on a route today" value={String(routesToday)} hint="Routes planned with a vehicle" />
        <StatCard
          label="Unassigned"
          value={String(vehicles.filter((v) => v.active && !v.defaultRepId).length)}
          hint="Active vehicles with no usual driver"
        />
      </StatGrid>

      <div>
        <FilterBar action="/app/settings/vehicles" preserve={preserved(params, ["q", "status", "veh_page"])}>
          <FilterSearch name="q" value={params.q} placeholder="Search plate, make, model…" />
          <FilterSelect
            name="status"
            value={params.status}
            allLabel="Active and retired"
            options={[
              { value: "active", label: "Active" },
              { value: "retired", label: "Retired" },
            ]}
          />
        </FilterBar>

        <DataTable
          columns={columns}
          rows={vehicles}
          getRowKey={(v) => v.id}
          caption="Vehicle fleet"
          sort={{ key: ts.sort, dir: ts.dir }}
          sortHrefFor={sortHrefFor}
          pagination={{
            page: ts.page,
            pages: Math.max(1, Math.ceil(total / ts.limit)),
            total,
            limit: ts.limit,
            hrefFor: (p) => tableHref("/app/settings/vehicles", params, { veh_page: p }, undefined),
          }}
          empty={{
            title: "No vehicles yet",
            description: "Add the vans and bikes your reps drive; routes can then be planned against them.",
            action: canWrite ? <VehicleDialog mode="create" branches={branches} reps={reps} /> : undefined,
          }}
        />
      </div>
    </div>
  );
}
