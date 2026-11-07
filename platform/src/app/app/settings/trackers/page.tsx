import { headers } from "next/headers";
import { notFound } from "next/navigation";

import {
  Badge,
  ButtonLink,
  Card,
  CellStack,
  DataTable,
  FilterBar,
  FilterSearch,
  FilterSelect,
  ModuleLocked,
  PageHeader,
  SectionHeading,
  StatCard,
  StatGrid,
  type Column,
} from "@/components/ui";
import { db } from "@/lib/db";
import { can } from "@/lib/rbac";
import { requireTenant } from "@/lib/session";
import { preserved, tableHref, tableState, toggleSort } from "@/lib/table";
import { stalenessLabel, stalenessSeconds } from "@/lib/tracking";

import { DeviceDialog, IntegrationActions, NewIntegrationDialog } from "./tracker-dialogs";

export const dynamic = "force-dynamic";

const PATH = "/app/settings/trackers";

const PROVIDER_LABELS: Record<string, string> = {
  GENERIC: "Raut format",
  TRACCAR: "Traccar forwarding",
};

const INTEGRATION_SORTS: Record<string, "name" | "lastUsedAt" | "createdAt" | "active"> = {
  name: "name",
  used: "lastUsedAt",
  created: "createdAt",
  status: "active",
};

const DEVICE_SORTS: Record<string, "externalId" | "label" | "lastSeenAt"> = {
  id: "externalId",
  label: "label",
  seen: "lastSeenAt",
};

function seen(at: Date | null): string {
  return at ? stalenessLabel(stalenessSeconds(at)) : "Never";
}

function CodeBlock({ children }: { children: string }) {
  return (
    <pre className="overflow-x-auto rounded-lg border border-border bg-surface-sunken p-3 font-mono text-xs">
      {children}
    </pre>
  );
}

/**
 * Settings → Vehicle trackers. Where an admin connects GPS hardware: issue a key,
 * point the tracker platform at the endpoint, and match devices to vehicles.
 * Devices register themselves on first report, so nobody has to type an IMEI.
 *
 * Admin only, and 404s for anyone else: API keys can post a company's data.
 */
export default async function TrackerSettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { companyId, principal } = await requireTenant();
  if (!principal.enabledModules.has("ROUTING")) return <ModuleLocked module="ROUTING" />;
  if (!can(principal, "tracker:manage")) notFound();

  const params = await searchParams;
  const keyState = tableState(params, {
    prefix: "key",
    allowed: Object.keys(INTEGRATION_SORTS),
    defaultSort: "created",
    defaultDir: "desc",
    limit: 10,
  });
  const deviceState = tableState(params, {
    prefix: "dev",
    allowed: Object.keys(DEVICE_SORTS),
    defaultSort: "seen",
    defaultDir: "desc",
    limit: 15,
  });

  const keyWhere = {
    companyId,
    ...(params.key_q ? { name: { contains: params.key_q } } : {}),
    ...(params.key_status === "active" ? { active: true } : params.key_status === "revoked" ? { active: false } : {}),
  };
  const deviceWhere = {
    companyId,
    ...(params.dev_q
      ? {
          OR: [
            { externalId: { contains: params.dev_q } },
            { label: { contains: params.dev_q } },
            { vehicle: { plate: { contains: params.dev_q } } },
          ],
        }
      : {}),
    ...(params.dev_assigned === "yes"
      ? { vehicleId: { not: null } }
      : params.dev_assigned === "no"
        ? { vehicleId: null }
        : {}),
  };

  const [integrations, integrationTotal, devices, deviceTotal, vehicles, activeKeys, deviceCount, waiting, reporting] =
    await Promise.all([
      db.trackerIntegration.findMany({
        where: keyWhere,
        select: {
          id: true,
          name: true,
          provider: true,
          keyPrefix: true,
          active: true,
          lastUsedAt: true,
          _count: { select: { devices: true } },
        },
        orderBy: keyState.sort ? { [INTEGRATION_SORTS[keyState.sort]]: keyState.dir } : { createdAt: "desc" },
        take: keyState.limit,
        skip: (keyState.page - 1) * keyState.limit,
      }),
      db.trackerIntegration.count({ where: keyWhere }),
      db.trackerDevice.findMany({
        where: deviceWhere,
        include: {
          vehicle: { select: { id: true, plate: true } },
          integration: { select: { name: true } },
        },
        orderBy: deviceState.sort ? { [DEVICE_SORTS[deviceState.sort]]: deviceState.dir } : { lastSeenAt: "desc" },
        take: deviceState.limit,
        skip: (deviceState.page - 1) * deviceState.limit,
      }),
      db.trackerDevice.count({ where: deviceWhere }),
      db.vehicle.findMany({
        where: { companyId, active: true },
        select: { id: true, plate: true, make: true, model: true, tracker: { select: { id: true } } },
        orderBy: { plate: "asc" },
      }),
      db.trackerIntegration.count({ where: { companyId, active: true } }),
      db.trackerDevice.count({ where: { companyId } }),
      db.trackerDevice.count({ where: { companyId, vehicleId: null, active: true } }),
      db.trackerDevice.count({
        where: { companyId, vehicleId: { not: null }, lastSeenAt: { gte: new Date(Date.now() - 3_600_000) } },
      }),
    ]);

  // The address the admin is looking at is the address trackers should use.
  const head = await headers();
  const host = head.get("x-forwarded-host") ?? head.get("host") ?? "your-raut-address";
  const scheme = head.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const endpoint = `${scheme}://${host}/api/v1/tracking/ingest`;

  // A van already taken cannot be offered, except to the device that holds it.
  const vehicleOptionsFor = (deviceId?: string) =>
    vehicles
      .filter((v) => !v.tracker || v.tracker.id === deviceId)
      .map((v) => ({ id: v.id, name: [v.plate, v.make, v.model].filter(Boolean).join(" ") }));

  type IntegrationRow = (typeof integrations)[number];
  const integrationColumns: Array<Column<IntegrationRow>> = [
    {
      key: "name",
      header: "Name",
      sortKey: "name",
      cell: (i) => <CellStack primary={<span className="font-medium">{i.name}</span>} secondary={PROVIDER_LABELS[i.provider] ?? i.provider} />,
    },
    {
      key: "key",
      header: "Key",
      hideBelow: "sm",
      cell: (i) => <span className="font-mono text-xs">{i.keyPrefix}…</span>,
    },
    { key: "devices", header: "Devices", align: "right", numeric: true, hideBelow: "md", cell: (i) => <span>{i._count.devices}</span> },
    { key: "used", header: "Last report", sortKey: "used", cell: (i) => <span className="text-sm">{seen(i.lastUsedAt)}</span> },
    {
      key: "status",
      header: "Status",
      sortKey: "status",
      cell: (i) => <Badge tone={i.active ? "success" : "danger"}>{i.active ? "Active" : "Revoked"}</Badge>,
    },
    {
      key: "actions",
      header: <span className="sr-only">Actions</span>,
      align: "right",
      cell: (i) => <IntegrationActions id={i.id} name={i.name} active={i.active} />,
    },
  ];

  type DeviceRow = (typeof devices)[number];
  const deviceColumns: Array<Column<DeviceRow>> = [
    {
      key: "id",
      header: "Device",
      sortKey: "id",
      cell: (d) => (
        <CellStack
          primary={<span className="font-mono text-xs font-semibold">{d.externalId}</span>}
          secondary={d.label ?? d.integration?.name ?? "Added by hand"}
        />
      ),
    },
    {
      key: "vehicle",
      header: "Vehicle",
      cell: (d) =>
        d.vehicle ? (
          <span className="font-mono text-sm font-semibold tracking-wide">{d.vehicle.plate}</span>
        ) : (
          <Badge tone="warning">Needs a vehicle</Badge>
        ),
    },
    { key: "seen", header: "Last report", sortKey: "seen", cell: (d) => <span className="text-sm">{seen(d.lastSeenAt)}</span> },
    {
      key: "position",
      header: "Last position",
      hideBelow: "md",
      cell: (d) =>
        d.lastLatitude != null && d.lastLongitude != null ? (
          <span className="font-mono text-xs">
            {d.lastLatitude.toFixed(5)}, {d.lastLongitude.toFixed(5)}
          </span>
        ) : (
          <span className="text-content-muted">—</span>
        ),
    },
    {
      key: "status",
      header: "Status",
      cell: (d) => <Badge tone={d.active ? "success" : "neutral"}>{d.active ? "Active" : "Off"}</Badge>,
    },
    {
      key: "actions",
      header: <span className="sr-only">Actions</span>,
      align: "right",
      cell: (d) => (
        <DeviceDialog
          mode="edit"
          device={{ id: d.id, externalId: d.externalId, label: d.label, vehicleId: d.vehicleId, active: d.active }}
          vehicles={vehicleOptionsFor(d.id)}
        />
      ),
    },
  ];

  const sampleBody = `curl -X POST ${endpoint} \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "positions": [{
      "deviceId": "356307042441013",
      "latitude": -1.2864,
      "longitude": 36.8172,
      "recordedAt": "2026-11-06T09:30:00Z",
      "speedKmh": 42,
      "heading": 180,
      "ignition": true,
      "odometerKm": 84210,
      "batteryPct": 96,
      "accuracyM": 6
    }]
  }'`;

  const traccarConfig = `<entry key='forward.enable'>true</entry>
<entry key='forward.json'>true</entry>
<entry key='forward.url'>${endpoint}</entry>
<entry key='forward.header'>Authorization: Bearer YOUR_API_KEY</entry>`;

  return (
    <div className="space-y-8">
      <PageHeader
        title="Vehicle trackers"
        description="Connect GPS tracker hardware through the API, then match each device to its vehicle."
        breadcrumb={{ href: "/app/settings", label: "Settings" }}
        actions={
          <>
            <ButtonLink href="/app/tracking" variant="secondary" size="sm">
              Track vehicles
            </ButtonLink>
            <NewIntegrationDialog />
          </>
        }
      />

      <StatGrid>
        <StatCard label="Active API keys" value={String(activeKeys)} />
        <StatCard label="Devices" value={String(deviceCount)} />
        <StatCard label="Reporting" value={String(reporting)} hint="Assigned, heard from in the last hour" tone={reporting > 0 ? "success" : "neutral"} />
        <StatCard
          label="Waiting for a vehicle"
          value={String(waiting)}
          hint="Reporting, but their positions are not being kept"
          tone={waiting > 0 ? "warning" : "neutral"}
        />
      </StatGrid>

      <div>
        <SectionHeading title="API keys" description="Each key belongs to this company. Revoking one cuts off only the devices using it." />
        <FilterBar action={PATH} preserve={preserved(params, ["key_q", "key_status", "key_page"])}>
          <FilterSearch name="key_q" value={params.key_q} placeholder="Search keys…" />
          <FilterSelect
            name="key_status"
            value={params.key_status}
            allLabel="Active and revoked"
            options={[
              { value: "active", label: "Active" },
              { value: "revoked", label: "Revoked" },
            ]}
          />
        </FilterBar>
        <DataTable
          columns={integrationColumns}
          rows={integrations}
          getRowKey={(i) => i.id}
          caption="Tracker API keys"
          sort={{ key: keyState.sort, dir: keyState.dir }}
          sortHrefFor={(key) => {
            const next = toggleSort(keyState, key);
            return tableHref(PATH, params, { key_sort: next.sort, key_dir: next.dir }, "key");
          }}
          pagination={{
            page: keyState.page,
            pages: Math.max(1, Math.ceil(integrationTotal / keyState.limit)),
            total: integrationTotal,
            limit: keyState.limit,
            hrefFor: (p) => tableHref(PATH, params, { key_page: p }, undefined),
          }}
          empty={{
            title: "No API keys yet",
            description: "Issue a key, then give it to your tracker platform along with the address below.",
            action: <NewIntegrationDialog />,
          }}
        />
      </div>

      <div>
        <SectionHeading
          title="Devices"
          description="A device appears here on its first report. Assign it a vehicle to start keeping its positions."
          actions={<DeviceDialog mode="create" vehicles={vehicleOptionsFor()} />}
        />
        <FilterBar action={PATH} preserve={preserved(params, ["dev_q", "dev_assigned", "dev_page"])}>
          <FilterSearch name="dev_q" value={params.dev_q} placeholder="Search device ID, label, plate…" />
          <FilterSelect
            name="dev_assigned"
            value={params.dev_assigned}
            allLabel="Assigned and unassigned"
            options={[
              { value: "yes", label: "Assigned" },
              { value: "no", label: "Needs a vehicle" },
            ]}
          />
        </FilterBar>
        <DataTable
          columns={deviceColumns}
          rows={devices}
          getRowKey={(d) => d.id}
          caption="Tracker devices"
          sort={{ key: deviceState.sort, dir: deviceState.dir }}
          sortHrefFor={(key) => {
            const next = toggleSort(deviceState, key);
            return tableHref(PATH, params, { dev_sort: next.sort, dev_dir: next.dir }, "dev");
          }}
          pagination={{
            page: deviceState.page,
            pages: Math.max(1, Math.ceil(deviceTotal / deviceState.limit)),
            total: deviceTotal,
            limit: deviceState.limit,
            hrefFor: (p) => tableHref(PATH, params, { dev_page: p }, undefined),
          }}
          empty={{
            title: "No devices yet",
            description: "Send a test position with a key and the device will appear here.",
          }}
        />
      </div>

      <Card>
        <SectionHeading title="Connect through the API" description="Send positions as they happen, or in batches of up to 1,000." />
        <div className="space-y-5 text-sm">
          <div className="space-y-2">
            <p className="font-medium">Address</p>
            <CodeBlock>{`POST ${endpoint}`}</CodeBlock>
            <p className="text-content-muted">
              Send the key as an <code>Authorization: Bearer</code> or <code>X-Api-Key</code> header. A GET to the same
              address with the key tests the connection without sending any data.
            </p>
          </div>
          <div className="space-y-2">
            <p className="font-medium">Raut position format</p>
            <CodeBlock>{sampleBody}</CodeBlock>
            <p className="text-content-muted">
              Only <code>deviceId</code>, <code>latitude</code>, <code>longitude</code> and <code>recordedAt</code> are
              required. <code>recordedAt</code> is ISO 8601 or Unix time. Speed can be <code>speedKmh</code>,{" "}
              <code>speedMps</code> or <code>speedKnots</code>. Resending a position is safe, because duplicates are
              counted and not stored twice.
            </p>
          </div>
          <div className="space-y-2">
            <p className="font-medium">Traccar</p>
            <p className="text-content-muted">
              For hardware that cannot make web requests itself, run it through a Traccar server, which understands most
              tracker protocols. Add this to <code>traccar.xml</code> and restart Traccar:
            </p>
            <CodeBlock>{traccarConfig}</CodeBlock>
          </div>
          <div className="space-y-2">
            <p className="font-medium">Reading positions back</p>
            <p className="text-content-muted">
              Signed-in users can read <code>GET /api/v1/vehicles/live</code> for the whole fleet and{" "}
              <code>GET /api/v1/vehicles/&#123;id&#125;/track?date=YYYY-MM-DD</code> for one vehicle&apos;s day.
            </p>
          </div>
        </div>
      </Card>
    </div>
  );
}
