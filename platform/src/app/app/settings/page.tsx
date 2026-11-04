import {
  ButtonLink,
  Card,
  CellStack,
  DataTable,
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
import { can, ROLE_LABELS, type Role } from "@/lib/rbac";
import { requireTenant } from "@/lib/session";
import { seatUsage } from "@/lib/tenant";

import { BranchDialog } from "./branch-dialog";
import { UserDialog, UserStatusButton, type UserShape } from "./user-dialog";

export const dynamic = "force-dynamic";

/**
 * Company settings: users, branches, licence status and the audit trail.
 *
 * Module toggles are deliberately absent — licensing is a Super Admin action.
 * A tenant admin enabling their own paid modules would make the commercial
 * model unenforceable.
 */
export default async function SettingsPage() {
  const { companyId, principal } = await requireTenant();

  const [company, users, branches, locations, seats, auditLogs] = await Promise.all([
    db.company.findUniqueOrThrow({
      where: { id: companyId },
      include: { modules: { orderBy: { moduleKey: "asc" } } },
    }),
    db.user.findMany({
      where: { companyId },
      include: {
        branch: { select: { name: true } },
        _count: { select: { devices: true, visits: true } },
      },
      orderBy: [{ role: "asc" }, { name: "asc" }],
    }),
    db.branch.findMany({
      where: { companyId },
      include: { _count: { select: { users: true, customers: true } } },
      orderBy: { name: "asc" },
    }),
    db.stockLocation.findMany({ where: { companyId }, orderBy: { name: "asc" } }),
    seatUsage(companyId),
    principal.role === "COMPANY_ADMIN"
      ? db.auditLog.findMany({
          where: { companyId },
          include: { user: { select: { name: true } } },
          orderBy: { createdAt: "desc" },
          take: 30,
        })
      : Promise.resolve([]),
  ]);

  const enabled = company.modules.filter((m) => m.enabled);
  const moduleValue = enabled.reduce((s, m) => s + m.priceCents, 0);
  const devices = users.reduce((s, u) => s + u._count.devices, 0);
  const canUserWrite = can(principal, "user:write");
  const canBranchWrite = can(principal, "branch:write");

  type UserRow = (typeof users)[number];

  return (
    <div className="space-y-8">
      <PageHeader
        title="Settings"
        description="Users, branches, stock locations and subscription status."
        actions={
          <>
            {canBranchWrite ? <BranchDialog mode="create" /> : null}
            {canUserWrite ? (
              <UserDialog mode="create" branches={branches.map((b) => ({ id: b.id, name: b.name }))} canSee={{ seatsUsed: seats.used, seatsLimit: seats.limit }} />
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
        <StatCard label="Branches" value={String(branches.length)} />
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
        <SectionHeading title="Users" description={`${users.length} accounts`} />
        <DataTable
          columns={[
            {
              key: "name",
              header: "Name",
              cell: (u) => <CellStack primary={<span className="font-medium">{u.name}</span>} secondary={u.email} />,
            },
            {
              key: "role",
              header: "Role",
              cell: (u) => <span className="text-xs">{ROLE_LABELS[u.role as Role] ?? u.role}</span>,
            },
            {
              key: "branch",
              header: "Branch",
              hideBelow: "md",
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
                        <UserDialog
                          mode="edit"
                          user={u as unknown as UserShape}
                          branches={branches.map((b) => ({ id: b.id, name: b.name }))}
                        />
                        {u.id !== principal.userId ? (
                          <UserStatusButton user={u as unknown as UserShape & { id: string }} />
                        ) : null}
                      </div>
                    ),
                  } satisfies Column<UserRow>,
                ]
              : []),
          ]}
          rows={users}
          getRowKey={(u) => u.id}
          caption="Users"
          empty={{ title: "No users yet" }}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div>
          <SectionHeading title="Branches" actions={canBranchWrite ? <BranchDialog mode="create" /> : null} />
          <Card padded={false} className="overflow-hidden">
            <div className="scroll-x">
              <table className="w-full border-collapse text-base">
                <thead>
                  <tr className="border-b border-border bg-surface-sunken/60">
                    <th className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-content-muted">Branch</th>
                    <th className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-content-muted">Code</th>
                    <th className="px-4 py-2.5 text-right text-xs font-semibold uppercase tracking-wide text-content-muted">Users</th>
                    <th className="px-4 py-2.5 text-right text-xs font-semibold uppercase tracking-wide text-content-muted">Customers</th>
                    {canBranchWrite ? <th className="px-4 py-2.5" aria-label="Actions" /> : null}
                  </tr>
                </thead>
                <tbody>
                  {branches.map((b) => (
                    <tr key={b.id} className="border-b border-border last:border-0 hover:bg-surface-hover">
                      <td className="px-4 py-2.5 font-medium">
                        {b.name}
                        {b.isPrimary ? (
                          <span className="badge ml-2 bg-accent-subtle text-accent border-info-border">primary</span>
                        ) : null}
                      </td>
                      <td className="px-4 py-2.5 text-content-muted text-xs">{b.code}</td>
                      <td className="px-4 py-2.5 text-right">{b._count.users}</td>
                      <td className="px-4 py-2.5 text-right">{b._count.customers}</td>
                      {canBranchWrite ? (
                        <td className="px-4 py-2.5 text-right">
                          <BranchDialog mode="edit" branch={b} />
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </div>

        <div>
          <SectionHeading title="Stock locations" />
          <div className="scroll-x rounded-lg border border-border bg-surface shadow-sm">
            <table className="w-full border-collapse text-base">
              <thead>
                <tr>
                  <th>Location</th>
                  <th>Code</th>
                  <th>Type</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {locations.map((l) => (
                  <tr key={l.id}>
                    <td className="font-medium">{l.name}</td>
                    <td className="text-content-text-content-muted">{l.code}</td>
                    <td>
                      <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium bg-surface-sunken">
                        {l.type.toLowerCase()}
                      </span>
                    </td>
                    <td>
                      <StatusBadge status={l.active ? "ACTIVE" : "SUSPENDED"} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {auditLogs.length > 0 ? (
        <div>
          <SectionHeading title="Activity log" description="Recent changes in your company" />
          <div className="scroll-x rounded-lg border border-border bg-surface shadow-sm">
            <table className="w-full border-collapse text-base">
              <thead>
                <tr>
                  <th>When</th>
                  <th>User</th>
                  <th>Action</th>
                  <th>Entity</th>
                  <th>Details</th>
                </tr>
              </thead>
              <tbody>
                {auditLogs.map((log) => (
                  <tr key={log.id}>
                    <td className="text-content-muted text-xs">
                      {log.createdAt.toLocaleString("en-KE", {
                        day: "2-digit", month: "short",
                        hour: "2-digit", minute: "2-digit",
                      })}
                    </td>
                    <td className="text-xs">{log.user?.name ?? "—"}</td>
                    <td>
                      <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium bg-surface-sunken">
                        {log.action.toLowerCase()}
                      </span>
                    </td>
                    <td className="text-xs">{log.entity}</td>
                    <td className="text-content-muted max-w-sm truncate text-xs">{log.changes ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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
