import {
  ButtonLink,
  Card,
  Meter,
  Money,
  SectionHeading,
  StatCard,
  StatusBadge,
} from "@/components/ui";
import { db } from "@/lib/db";
import { CORE_PLATFORM_PRICE_CENTS, MODULE_CATALOG, MODULE_LIST, type ModuleKey } from "@/lib/modules";
import { can, ROLE_LABELS, type Role } from "@/lib/rbac";
import { requireTenant } from "@/lib/session";
import { seatUsage } from "@/lib/tenant";

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

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-content-muted text-sm">
          Users, branches, stock locations and subscription status.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
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
      </div>

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
        <div className="scroll-x rounded-lg border border-border bg-surface shadow-sm">
          <table className="w-full border-collapse text-base">
            <thead>
              <tr>
                <th>Name</th>
                <th>Role</th>
                <th>Branch</th>
                <th>Devices</th>
                <th>Visits</th>
                <th>Last login</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td>
                    <p className="font-medium">{u.name}</p>
                    <p className="text-content-muted text-xs">{u.email}</p>
                  </td>
                  <td className="text-xs">{ROLE_LABELS[u.role as Role] ?? u.role}</td>
                  <td className="text-content-muted text-xs">{u.branch?.name ?? "—"}</td>
                  <td>{u._count.devices || "—"}</td>
                  <td className="text-content-text-content-muted">{u._count.visits || "—"}</td>
                  <td className="text-content-muted text-xs">
                    {u.lastLoginAt?.toLocaleDateString("en-KE") ?? "Never"}
                  </td>
                  <td>
                    <StatusBadge status={u.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div>
          <SectionHeading title="Branches" />
          <div className="scroll-x rounded-lg border border-border bg-surface shadow-sm">
            <table className="w-full border-collapse text-base">
              <thead>
                <tr>
                  <th>Branch</th>
                  <th>Code</th>
                  <th>Users</th>
                  <th>Customers</th>
                  <th>Mapped</th>
                </tr>
              </thead>
              <tbody>
                {branches.map((b) => (
                  <tr key={b.id}>
                    <td className="font-medium">
                      {b.name}
                      {b.isPrimary ? (
                        <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ml-2 bg-accent-subtle text-accent">primary</span>
                      ) : null}
                    </td>
                    <td className="text-content-text-content-muted">{b.code}</td>
                    <td>{b._count.users}</td>
                    <td>{b._count.customers}</td>
                    <td>
                      {b.latitude != null ? (
                        <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium bg-success-bg text-success">yes</span>
                      ) : (
                        <span className="text-content-muted text-xs">no</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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
