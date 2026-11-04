import type { Metadata } from "next";

import {
  BarChart,
  ButtonLink,
  Card,
  CellStack,
  DataTable,
  Meter,
  Money,
  SectionHeading,
  StatCard,
  StatGrid,
  StatusBadge,
  type Column,
} from "@/components/ui";
import { db } from "@/lib/db";
import { FULL_PLATFORM_PRICE_CENTS, MODULE_LIST } from "@/lib/modules";
import { tableHref, tableState, toggleSort } from "@/lib/table";
import { platformOverview } from "@/server/analytics";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Platform Overview" };

const PATH = "/admin";

const CO_SORT: Record<string, (dir: "asc" | "desc") => Record<string, unknown>> = {
  name: (dir) => ({ name: dir }),
  status: (dir) => ({ status: dir }),
  users: (dir) => ({ users: { _count: dir } }),
  created: (dir) => ({ createdAt: dir }),
};
const ACT_SORT: Record<string, (dir: "asc" | "desc") => Record<string, unknown>> = {
  when: (dir) => ({ createdAt: dir }),
  company: (dir) => ({ company: { name: dir } }),
  user: (dir) => ({ user: { name: dir } }),
  action: (dir) => ({ action: dir }),
  entity: (dir) => ({ entity: dir }),
};

/**
 * Super Admin dashboard — proposal page 5.
 *
 * The mockup's "96% Uptime SLA" tile is deliberately absent: there is no uptime
 * probe in this system, and a hard-coded figure on an operations dashboard is a
 * fabricated metric. Licensed platform value replaces it — a number the system
 * can actually derive.
 */
export default async function PlatformOverviewPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const params = await searchParams;

  const coTs = tableState(params, {
    prefix: "co",
    allowed: Object.keys(CO_SORT),
    defaultSort: "created",
    defaultDir: "desc",
    limit: 8,
  });
  const actTs = tableState(params, {
    prefix: "act",
    allowed: Object.keys(ACT_SORT),
    defaultSort: "when",
    defaultDir: "desc",
    limit: 10,
  });

  const [overview, companies, companyCount, audit, auditCount] = await Promise.all([
    platformOverview(),
    db.company.findMany({
      orderBy: CO_SORT[coTs.sort ?? "created"](coTs.dir) as never,
      take: coTs.limit,
      skip: (coTs.page - 1) * coTs.limit,
      select: {
        id: true,
        name: true,
        status: true,
        createdAt: true,
        _count: { select: { users: true } },
        modules: { where: { enabled: true }, select: { id: true } },
      },
    }),
    db.company.count(),
    db.auditLog.findMany({
      orderBy: ACT_SORT[actTs.sort ?? "when"](actTs.dir) as never,
      take: actTs.limit,
      skip: (actTs.page - 1) * actTs.limit,
      include: {
        user: { select: { name: true } },
        company: { select: { name: true } },
      },
    }),
    db.auditLog.count(),
  ]);

  const adoption = new Map(overview.moduleCounts.map((m) => [m.moduleKey, m.companies]));
  const slots = overview.companies * MODULE_LIST.length;
  const sold = overview.moduleCounts.reduce((s, m) => s + m.companies, 0);

  const sortHref = (ts: typeof coTs, prefix: string) => (key: string) => {
    const next = toggleSort(ts, key);
    return tableHref(PATH, params, { [`${prefix}_sort`]: next.sort, [`${prefix}_dir`]: next.dir }, prefix);
  };
  const pageHref = (prefix: string) => (p: number) => tableHref(PATH, params, { [`${prefix}_page`]: p });

  type CompanyRow = (typeof companies)[number];
  const companyColumns: Array<Column<CompanyRow>> = [
    {
      key: "name",
      header: "Company",
      sortKey: "name",
      cell: (c) => (
        <CellStack
          primary={c.name}
          secondary={`Onboarded ${c.createdAt.toLocaleDateString("en-KE")}`}
        />
      ),
    },
    { key: "status", header: "Status", sortKey: "status", cell: (c) => <StatusBadge status={c.status} /> },
    { key: "users", header: "Users", align: "right", numeric: true, sortKey: "users", cell: (c) => c._count.users },
    {
      key: "modules",
      header: "Modules",
      align: "right",
      numeric: true,
      hideBelow: "sm",
      cell: (c) => `${c.modules.length}/${MODULE_LIST.length}`,
    },
    {
      key: "created",
      header: "Onboarded",
      hideBelow: "lg",
      sortKey: "created",
      cell: (c) => <span className="text-content-muted text-xs">{c.createdAt.toLocaleDateString("en-KE")}</span>,
    },
    {
      key: "manage",
      header: "Manage",
      align: "right",
      srOnlyHeader: true,
      cell: (c) => (
        <ButtonLink href={`/admin/companies/${c.id}`} size="sm" variant="ghost">
          Manage
        </ButtonLink>
      ),
    },
  ];

  type AuditRow = (typeof audit)[number];
  const auditColumns: Array<Column<AuditRow>> = [
    {
      key: "when",
      header: "When",
      sortKey: "when",
      cell: (l) => (
        <span className="text-sm text-content-muted">
          {l.createdAt.toLocaleString("en-KE", {
            day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
          })}
        </span>
      ),
    },
    { key: "company", header: "Company", hideBelow: "sm", sortKey: "company", cell: (l) => l.company?.name ?? "—" },
    { key: "user", header: "User", sortKey: "user", cell: (l) => l.user?.name ?? "—" },
    { key: "action", header: "Action", sortKey: "action", cell: (l) => <StatusBadge status={l.action} /> },
    {
      key: "entity",
      header: "Entity",
      align: "right",
      hideBelow: "md",
      sortKey: "entity",
      cell: (l) => <span className="text-content-muted">{l.entity}</span>,
    },
  ];

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Platform Overview</h1>
        <p className="mt-1 text-base text-content-secondary">All companies · Last 30 days</p>
      </header>

      <StatGrid>
        <StatCard
          label="Companies"
          value={overview.companies}
          hint={`${overview.companiesActive} active`}
        />
        <StatCard
          label="Active users"
          value={overview.activeUsers.toLocaleString("en-KE")}
          hint="Across all tenants"
        />
        <StatCard
          label="Monthly GMV"
          value={<Money cents={overview.monthlyGmvCents} compact />}
          hint="Invoiced, last 30 days"
        />
        <StatCard
          label="Licensed value"
          value={<Money cents={overview.licensedValueCents} compact />}
          tone="success"
          hint={
            <>
              of <Money cents={FULL_PLATFORM_PRICE_CENTS * overview.companies} compact />{" "}
              full-platform ceiling
            </>
          }
        />
      </StatGrid>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <SectionHeading
            title="Company activity"
            description="Weekly orders across the platform"
          />
          <BarChart
            data={overview.weeklyOrders.map((w) => ({ label: w.label, value: w.count }))}
            format="count"
          />
        </Card>

        <Card>
          <SectionHeading
            title="Module adoption"
            description={`${sold} of ${slots} licence slots sold`}
          />
          <ul className="space-y-2.5">
            {MODULE_LIST.map((m) => {
              const count = adoption.get(m.key) ?? 0;
              return (
                <li key={m.key}>
                  <Meter
                    value={count}
                    max={Math.max(overview.companies, 1)}
                    label={`${m.ordinal} ${m.name}`}
                    tone={count > 0 ? "accent" : "warning"}
                  />
                  <p className="mt-0.5 text-right text-xs tabular text-content-muted">
                    {count}/{overview.companies}
                  </p>
                </li>
              );
            })}
          </ul>
        </Card>
      </div>

      <section>
        <SectionHeading
          title="Companies"
          description="Newest tenants on the instance"
          actions={
            <ButtonLink href="/admin/companies" size="sm">
              View all
            </ButtonLink>
          }
        />
        <DataTable
          columns={companyColumns}
          rows={companies}
          getRowKey={(c) => c.id}
          caption="Most recently onboarded companies"
          sort={{ key: coTs.sort, dir: coTs.dir }}
          sortHrefFor={sortHref(coTs, "co")}
          pagination={{
            page: coTs.page,
            pages: Math.max(1, Math.ceil(companyCount / coTs.limit)),
            total: companyCount,
            limit: coTs.limit,
            hrefFor: pageHref("co"),
          }}
          empty={{
            title: "No companies yet",
            description: "Onboard the first tenant to get started.",
          }}
        />
      </section>

      <section>
        <SectionHeading title="Platform activity" description="Most recent audited events" />
        <DataTable
          columns={auditColumns}
          rows={audit}
          getRowKey={(l) => l.id}
          caption="Recent audit log entries"
          sort={{ key: actTs.sort, dir: actTs.dir }}
          sortHrefFor={sortHref(actTs, "act")}
          pagination={{
            page: actTs.page,
            pages: Math.max(1, Math.ceil(auditCount / actTs.limit)),
            total: auditCount,
            limit: actTs.limit,
            hrefFor: pageHref("act"),
          }}
          empty={{ title: "No activity recorded yet" }}
          footer={
            <span>
              {auditCount.toLocaleString("en-KE")} audited events ·{" "}
              <a href="/admin/audit" className="text-accent hover:underline">
                full audit log
              </a>
            </span>
          }
        />
      </section>
    </div>
  );
}
