import {
  ButtonLink,
  Card,
  CellStack,
  DataTable,
  FilterBar,
  FilterSearch,
  FilterSelect,
  Meter,
  Money,
  PageHeader,
  SectionHeading,
  StatCard,
  StatGrid,
  StatusBadge,
  type Column,
} from "@/components/ui";
import { db } from "@/lib/db";
import { CORE_PLATFORM_PRICE_CENTS, MODULE_CATALOG, MODULE_LIST, type ModuleKey } from "@/lib/modules";
import { can, ROLE_LABELS, ROLES, type Role } from "@/lib/rbac";
import { requireTenant } from "@/lib/session";
import { preserved, tableHref, tableState, toggleSort } from "@/lib/table";
import { seatUsage } from "@/lib/tenant";

import { BranchDialog } from "./branch-dialog";
import { UserDialog, UserStatusButton, type UserShape } from "./user-dialog";

export const dynamic = "force-dynamic";

const PATH = "/app/settings";

const USR_SORT: Record<string, (dir: "asc" | "desc") => Record<string, unknown>> = {
  name: (dir) => ({ name: dir }),
  role: (dir) => ({ role: dir }),
  status: (dir) => ({ status: dir }),
  lastLogin: (dir) => ({ lastLoginAt: dir }),
  branch: (dir) => ({ branch: { name: dir } }),
};
const BR_SORT: Record<string, (dir: "asc" | "desc") => Record<string, unknown>> = {
  name: (dir) => ({ name: dir }),
  code: (dir) => ({ code: dir }),
  users: (dir) => ({ users: { _count: dir } }),
  customers: (dir) => ({ customers: { _count: dir } }),
};
const LOC_SORT: Record<string, string> = { name: "name", code: "code", type: "type", status: "active" };
const LOG_SORT: Record<string, (dir: "asc" | "desc") => Record<string, unknown>> = {
  when: (dir) => ({ createdAt: dir }),
  user: (dir) => ({ user: { name: dir } }),
  action: (dir) => ({ action: dir }),
  entity: (dir) => ({ entity: dir }),
};

const TENANT_ROLES = ROLES.filter((r) => r !== "SUPER_ADMIN");

/**
 * Company settings: users, branches, licence status and the audit trail.
 *
 * Module toggles are deliberately absent — licensing is a Super Admin action.
 * A tenant admin enabling their own paid modules would make the commercial
 * model unenforceable.
 */
export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { companyId, principal } = await requireTenant();
  const params = await searchParams;

  const usrTs = tableState(params, {
    prefix: "usr",
    allowed: Object.keys(USR_SORT),
    defaultSort: "name",
    defaultDir: "asc",
    limit: 15,
  });
  const brTs = tableState(params, {
    prefix: "br",
    allowed: Object.keys(BR_SORT),
    defaultSort: "name",
    defaultDir: "asc",
    limit: 10,
  });
  const locTs = tableState(params, {
    prefix: "loc",
    allowed: Object.keys(LOC_SORT),
    defaultSort: "name",
    defaultDir: "asc",
    limit: 10,
  });
  const logTs = tableState(params, {
    prefix: "log",
    allowed: Object.keys(LOG_SORT),
    defaultSort: "when",
    defaultDir: "desc",
    limit: 15,
  });

  const isCompanyAdmin = principal.role === "COMPANY_ADMIN";

  const userWhere = {
    companyId,
    ...(params.usr_role && (TENANT_ROLES as readonly string[]).includes(params.usr_role) ? { role: params.usr_role } : {}),
    ...(params.usr_q
      ? { OR: [{ name: { contains: params.usr_q } }, { email: { contains: params.usr_q } }] }
      : {}),
  };
  const branchWhere = {
    companyId,
    ...(params.br_q ? { OR: [{ name: { contains: params.br_q } }, { code: { contains: params.br_q } }] } : {}),
  };
  const locationWhere = {
    companyId,
    ...(params.loc_q ? { OR: [{ name: { contains: params.loc_q } }, { code: { contains: params.loc_q } }] } : {}),
  };
  const logWhere = {
    companyId,
    ...(params.log_action ? { action: params.log_action } : {}),
    ...(params.log_q
      ? {
          OR: [
            { entity: { contains: params.log_q } },
            { action: { contains: params.log_q } },
            { entityId: { contains: params.log_q } },
            { user: { name: { contains: params.log_q } } },
          ],
        }
      : {}),
  };

  const [
    company,
    users,
    userCount,
    allBranches,
    branches,
    branchCount,
    locations,
    locationCount,
    seats,
    devices,
    auditLogs,
    auditCount,
    auditActions,
  ] = await Promise.all([
    db.company.findUniqueOrThrow({
      where: { id: companyId },
      include: { modules: { orderBy: { moduleKey: "asc" } } },
    }),
    db.user.findMany({
      where: userWhere,
      include: {
        branch: { select: { name: true } },
        _count: { select: { devices: true, visits: true } },
      },
      orderBy: USR_SORT[usrTs.sort ?? "name"](usrTs.dir) as never,
      take: usrTs.limit,
      skip: (usrTs.page - 1) * usrTs.limit,
    }),
    db.user.count({ where: userWhere }),
    db.branch.findMany({ where: { companyId }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    db.branch.findMany({
      where: branchWhere,
      include: { _count: { select: { users: true, customers: true } } },
      orderBy: BR_SORT[brTs.sort ?? "name"](brTs.dir) as never,
      take: brTs.limit,
      skip: (brTs.page - 1) * brTs.limit,
    }),
    db.branch.count({ where: branchWhere }),
    db.stockLocation.findMany({
      where: locationWhere,
      orderBy: { [LOC_SORT[locTs.sort ?? "name"]]: locTs.dir } as Record<string, "asc" | "desc">,
      take: locTs.limit,
      skip: (locTs.page - 1) * locTs.limit,
    }),
    db.stockLocation.count({ where: locationWhere }),
    seatUsage(companyId),
    db.device.count({ where: { user: { companyId } } }),
    isCompanyAdmin
      ? db.auditLog.findMany({
          where: logWhere,
          include: { user: { select: { name: true } } },
          orderBy: LOG_SORT[logTs.sort ?? "when"](logTs.dir) as never,
          take: logTs.limit,
          skip: (logTs.page - 1) * logTs.limit,
        })
      : Promise.resolve([]),
    isCompanyAdmin ? db.auditLog.count({ where: logWhere }) : Promise.resolve(0),
    isCompanyAdmin
      ? db.auditLog.groupBy({ by: ["action"], where: { companyId }, orderBy: { action: "asc" } })
      : Promise.resolve([] as Array<{ action: string }>),
  ]);

  const enabled = company.modules.filter((m) => m.enabled);
  const moduleValue = enabled.reduce((s, m) => s + m.priceCents, 0);
  const canUserWrite = can(principal, "user:write");
  const canBranchWrite = can(principal, "branch:write");

  const sortHref = (ts: typeof usrTs, prefix: string) => (key: string) => {
    const next = toggleSort(ts, key);
    return tableHref(PATH, params, { [`${prefix}_sort`]: next.sort, [`${prefix}_dir`]: next.dir }, prefix);
  };
  const pageHref = (prefix: string) => (p: number) => tableHref(PATH, params, { [`${prefix}_page`]: p });

  type UserRow = (typeof users)[number];
  const userColumns: Array<Column<UserRow>> = [
    {
      key: "name",
      header: "Name",
      sortKey: "name",
      cell: (u) => <CellStack primary={<span className="font-medium">{u.name}</span>} secondary={u.email} />,
    },
    {
      key: "role",
      header: "Role",
      sortKey: "role",
      cell: (u) => <span className="text-xs">{ROLE_LABELS[u.role as Role] ?? u.role}</span>,
    },
    {
      key: "branch",
      header: "Branch",
      hideBelow: "md",
      sortKey: "branch",
      cell: (u) => <span className="text-content-muted text-xs">{u.branch?.name ?? "—"}</span>,
    },
    {
      key: "devices",
      header: "Devices",
      align: "right",
      numeric: true,
      hideBelow: "lg",
      cell: (u) => <>{u._count.devices || "—"}</>,
    },
    {
      key: "visits",
      header: "Visits",
      align: "right",
      numeric: true,
      hideBelow: "lg",
      cell: (u) => <>{u._count.visits || "—"}</>,
    },
    {
      key: "lastLogin",
      header: "Last login",
      hideBelow: "md",
      sortKey: "lastLogin",
      cell: (u) => (
        <span className="text-content-muted text-xs">
          {u.lastLoginAt?.toLocaleDateString("en-KE") ?? "Never"}
        </span>
      ),
    },
    {
      key: "status",
      header: "Status",
      align: "right",
      sortKey: "status",
      cell: (u) => <StatusBadge status={u.status} />,
    },
    ...(canUserWrite
      ? [
          {
            key: "actions",
            header: "",
            srOnlyHeader: true,
            align: "right" as const,
            cell: (u: UserRow) => (
              <div className="flex justify-end gap-1">
                <UserDialog mode="edit" user={u as unknown as UserShape} branches={allBranches} />
                {u.id !== principal.userId ? (
                  <UserStatusButton user={u as unknown as UserShape & { id: string }} />
                ) : null}
              </div>
            ),
          } satisfies Column<UserRow>,
        ]
      : []),
  ];

  type BranchRow = (typeof branches)[number];
  const branchColumns: Array<Column<BranchRow>> = [
    {
      key: "name",
      header: "Branch",
      sortKey: "name",
      cell: (b) => (
        <span className="font-medium">
          {b.name}
          {b.isPrimary ? (
            <span className="badge ml-2 bg-accent-subtle text-accent border-info-border">primary</span>
          ) : null}
        </span>
      ),
    },
    { key: "code", header: "Code", sortKey: "code", cell: (b) => <span className="text-content-muted text-xs">{b.code}</span> },
    { key: "users", header: "Users", align: "right", numeric: true, sortKey: "users", cell: (b) => b._count.users },
    { key: "customers", header: "Customers", align: "right", numeric: true, sortKey: "customers", cell: (b) => b._count.customers },
    ...(canBranchWrite
      ? [
          {
            key: "actions",
            header: "",
            srOnlyHeader: true,
            align: "right" as const,
            cell: (b: BranchRow) => <BranchDialog mode="edit" branch={b} />,
          } satisfies Column<BranchRow>,
        ]
      : []),
  ];

  type LocationRow = (typeof locations)[number];
  const locationColumns: Array<Column<LocationRow>> = [
    { key: "name", header: "Location", sortKey: "name", cell: (l) => <span className="font-medium">{l.name}</span> },
    { key: "code", header: "Code", sortKey: "code", cell: (l) => <span className="text-content-muted text-xs">{l.code}</span> },
    {
      key: "type",
      header: "Type",
      sortKey: "type",
      cell: (l) => <span className="badge bg-surface-sunken">{l.type.toLowerCase()}</span>,
    },
    {
      key: "status",
      header: "Status",
      align: "right",
      sortKey: "status",
      cell: (l) => <StatusBadge status={l.active ? "ACTIVE" : "SUSPENDED"} />,
    },
  ];

  type LogRow = (typeof auditLogs)[number];
  const logColumns: Array<Column<LogRow>> = [
    {
      key: "when",
      header: "When",
      sortKey: "when",
      cell: (log) => (
        <span className="text-content-muted text-xs">
          {log.createdAt.toLocaleString("en-KE", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}
        </span>
      ),
    },
    { key: "user", header: "User", sortKey: "user", cell: (log) => <span className="text-xs">{log.user?.name ?? "—"}</span> },
    {
      key: "action",
      header: "Action",
      sortKey: "action",
      cell: (log) => <span className="badge bg-surface-sunken">{log.action.toLowerCase()}</span>,
    },
    { key: "entity", header: "Entity", sortKey: "entity", hideBelow: "sm", cell: (log) => <span className="text-xs">{log.entity}</span> },
    {
      key: "details",
      header: "Details",
      hideBelow: "md",
      cell: (log) => <span className="text-content-muted block max-w-sm truncate text-xs">{log.changes ?? "—"}</span>,
    },
  ];

  return (
    <div className="space-y-8">
      <PageHeader
        title="Settings"
        description="Users, branches, stock locations and subscription status."
        actions={
          <>
            {canBranchWrite ? <BranchDialog mode="create" /> : null}
            {canUserWrite ? (
              <UserDialog mode="create" branches={allBranches} canSee={{ seatsUsed: seats.used, seatsLimit: seats.limit }} />
            ) : null}
          </>
        }
      />

      <StatGrid>
        <StatCard
          label="Users"
          value={`${seats.used} / ${seats.limit}`}
          hint="Against the licensed seat count"
          tone={seats.used >= seats.limit ? "danger" : seats.used / seats.limit > 0.85 ? "warning" : "success"}
        />
        <StatCard label="Branches" value={String(allBranches.length)} />
        <StatCard label="Registered devices" value={String(devices)} hint="Mobile app installs" />
        <StatCard
          label="Subscription"
          value={<Money cents={CORE_PLATFORM_PRICE_CENTS + moduleValue} />}
          hint={`Core + ${enabled.length} of ${MODULE_LIST.length} modules`}
        />
      </StatGrid>

      {/* These two pages existed with nothing linking to them, so the only way
          in was to know the URL. */}
      <div className="grid gap-4 sm:grid-cols-2">
        {can(principal, "settings:write") && (
          <Card>
            <SectionHeading
              title="Payments"
              description="Paystack, M-Pesa and KCB Buni, under this company's own merchant accounts."
            />
            <ButtonLink href="/app/settings/payments" variant="secondary" size="sm">
              Configure payments
            </ButtonLink>
          </Card>
        )}
        {can(principal, "settings:write") && (
          <Card>
            <SectionHeading
              title="Maps"
              description="OpenStreetMap or Google Maps, for every map in the console and the field app's Directions buttons."
            />
            <ButtonLink href="/app/settings/maps" variant="secondary" size="sm">
              Configure maps
            </ButtonLink>
          </Card>
        )}
        {principal.enabledModules.has("ROUTING") && can(principal, "vehicle:read") && (
          <Card>
            <SectionHeading
              title="Vehicles"
              description="The vans, pick-ups and bikes routes are planned against, with their usual drivers and odometers."
            />
            <ButtonLink href="/app/settings/vehicles" variant="secondary" size="sm">
              Manage vehicles
            </ButtonLink>
          </Card>
        )}
        {principal.enabledModules.has("ROUTING") && can(principal, "tracker:manage") && (
          <Card>
            <SectionHeading
              title="Vehicle trackers"
              description="Connect GPS tracker hardware through the API: issue keys, then match each device to its vehicle."
            />
            <ButtonLink href="/app/settings/trackers" variant="secondary" size="sm">
              Manage trackers
            </ButtonLink>
          </Card>
        )}
        {principal.enabledModules.has("ETIMS") && can(principal, "etims:configure") && (
          <Card>
            <SectionHeading
              title="eTIMS"
              description="Switch KRA transmission on or off and set the classification defaults."
            />
            <ButtonLink href="/app/settings/etims" variant="secondary" size="sm">
              Configure eTIMS
            </ButtonLink>
          </Card>
        )}
      </div>

      <div>
        <SectionHeading
          title="Subscription"
          description="Module licensing is managed by your platform administrator."
        />
        <div className="rounded-lg border border-border bg-surface p-5 shadow-sm">
          <div className="mb-4">
            <div className="mb-1 flex justify-between text-xs">
              <span className="text-content-text-content-muted">Modules licensed</span>
              <span>
                {enabled.length} / {MODULE_LIST.length}
              </span>
            </div>
            <Meter value={enabled.length} max={MODULE_LIST.length} tone="accent" />
          </div>

          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {MODULE_LIST.map((m) => {
              const licence = company.modules.find((x) => x.moduleKey === m.key);
              const on = licence?.enabled ?? false;
              return (
                <div
                  key={m.key}
                  className={`flex items-start justify-between gap-2 rounded-lg border p-3 text-sm ${
                    on ? "border-accent/40 bg-accent/5" : "opacity-60"
                  }`}
                  style={!on ? { borderColor: "var(--border)" } : undefined}
                >
                  <span className="min-w-0">
                    <span className="block truncate font-medium">
                      <span className="text-content-muted mr-1.5">{m.ordinal}</span>
                      {m.name}
                    </span>
                    <span className="text-content-muted block text-xs">
                      {on ? "Included" : `Available — ${(m.priceCents / 100).toLocaleString("en-KE")} KES`}
                    </span>
                  </span>
                  {on ? (
                    <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium shrink-0 bg-success-bg text-success">on</span>
                  ) : (
                    <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium shrink-0 bg-surface-sunken">off</span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div>
        <SectionHeading title="Users" description={`${userCount} accounts`} />
        <FilterBar action={PATH} preserve={preserved(params, ["usr_q", "usr_role", "usr_page"])}>
          <FilterSearch name="usr_q" value={params.usr_q} placeholder="Search name, email…" />
          <FilterSelect
            name="usr_role"
            value={params.usr_role}
            allLabel="All roles"
            options={TENANT_ROLES.map((r) => ({ value: r, label: ROLE_LABELS[r] }))}
          />
        </FilterBar>
        <DataTable
          columns={userColumns}
          rows={users}
          getRowKey={(u) => u.id}
          caption="Users"
          sort={{ key: usrTs.sort, dir: usrTs.dir }}
          sortHrefFor={sortHref(usrTs, "usr")}
          pagination={{
            page: usrTs.page,
            pages: Math.max(1, Math.ceil(userCount / usrTs.limit)),
            total: userCount,
            limit: usrTs.limit,
            hrefFor: pageHref("usr"),
          }}
          empty={{ title: params.usr_q || params.usr_role ? "No users match this filter" : "No users yet" }}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div>
          <SectionHeading
            title="Branches"
            description={`${branchCount} branch(es)`}
            actions={canBranchWrite ? <BranchDialog mode="create" /> : null}
          />
          <FilterBar action={PATH} preserve={preserved(params, ["br_q", "br_page"])}>
            <FilterSearch name="br_q" value={params.br_q} placeholder="Search branch, code…" />
          </FilterBar>
          <DataTable
            columns={branchColumns}
            rows={branches}
            getRowKey={(b) => b.id}
            caption="Branches"
            dense
            sort={{ key: brTs.sort, dir: brTs.dir }}
            sortHrefFor={sortHref(brTs, "br")}
            pagination={{
              page: brTs.page,
              pages: Math.max(1, Math.ceil(branchCount / brTs.limit)),
              total: branchCount,
              limit: brTs.limit,
              hrefFor: pageHref("br"),
            }}
            empty={{ title: params.br_q ? "No branches match" : "No branches yet" }}
          />
        </div>

        <div>
          <SectionHeading title="Stock locations" description={`${locationCount} location(s)`} />
          <FilterBar action={PATH} preserve={preserved(params, ["loc_q", "loc_page"])}>
            <FilterSearch name="loc_q" value={params.loc_q} placeholder="Search location, code…" />
          </FilterBar>
          <DataTable
            columns={locationColumns}
            rows={locations}
            getRowKey={(l) => l.id}
            caption="Stock locations"
            dense
            sort={{ key: locTs.sort, dir: locTs.dir }}
            sortHrefFor={sortHref(locTs, "loc")}
            pagination={{
              page: locTs.page,
              pages: Math.max(1, Math.ceil(locationCount / locTs.limit)),
              total: locationCount,
              limit: locTs.limit,
              hrefFor: pageHref("loc"),
            }}
            empty={{ title: params.loc_q ? "No locations match" : "No stock locations yet" }}
          />
        </div>
      </div>

      {isCompanyAdmin && (auditCount > 0 || params.log_q || params.log_action) ? (
        <div>
          <SectionHeading title="Activity log" description={`${auditCount.toLocaleString("en-KE")} changes in your company`} />
          <FilterBar action={PATH} preserve={preserved(params, ["log_q", "log_action", "log_page"])}>
            <FilterSearch name="log_q" value={params.log_q} placeholder="Search entity, action, user…" />
            <FilterSelect
              name="log_action"
              value={params.log_action}
              allLabel="All actions"
              options={auditActions.map((a) => ({ value: a.action, label: a.action.toLowerCase() }))}
            />
          </FilterBar>
          <DataTable
            columns={logColumns}
            rows={auditLogs}
            getRowKey={(log) => log.id}
            caption="Activity log"
            sort={{ key: logTs.sort, dir: logTs.dir }}
            sortHrefFor={sortHref(logTs, "log")}
            pagination={{
              page: logTs.page,
              pages: Math.max(1, Math.ceil(auditCount / logTs.limit)),
              total: auditCount,
              limit: logTs.limit,
              hrefFor: pageHref("log"),
            }}
            empty={{ title: "No activity matches this filter" }}
          />
        </div>
      ) : null}

      <p className="text-content-muted text-xs">
        Need another module? {MODULE_LIST.filter((m) => !enabled.some((e) => e.moduleKey === m.key)).length}{" "}
        remain available:{" "}
        {MODULE_LIST.filter((m) => !enabled.some((e) => e.moduleKey === m.key))
          .map((m) => MODULE_CATALOG[m.key as ModuleKey].name)
          .join(", ") || "none — all ten are licensed"}
        . Contact your platform administrator.
      </p>
    </div>
  );
}
