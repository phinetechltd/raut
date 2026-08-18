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
import { platformOverview, type PlatformOverview } from "@/server/analytics";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Platform Overview" };

type CompanyRow = PlatformOverview["recentCompanies"][number];

async function recentAudit() {
  return db.auditLog.findMany({
    orderBy: { createdAt: "desc" },
    take: 10,
    include: {
      user: { select: { name: true } },
      company: { select: { name: true } },
    },
  });
}

type AuditRow = Awaited<ReturnType<typeof recentAudit>>[number];

/**
 * Super Admin dashboard — proposal page 5.
 *
 * The mockup's "96% Uptime SLA" tile is deliberately absent: there is no uptime
 * probe in this system, and a hard-coded figure on an operations dashboard is a
 * fabricated metric. Licensed platform value replaces it — a number the system
 * can actually derive.
 */
export default async function PlatformOverviewPage() {
  const [overview, audit] = await Promise.all([platformOverview(), recentAudit()]);

  const adoption = new Map(overview.moduleCounts.map((m) => [m.moduleKey, m.companies]));
  const slots = overview.companies * MODULE_LIST.length;
  const sold = overview.moduleCounts.reduce((s, m) => s + m.companies, 0);

  const companyColumns: Array<Column<CompanyRow>> = [
    {
      key: "name",
      header: "Company",
      cell: (c) => (
        <CellStack
          primary={c.name}
          secondary={`Onboarded ${c.createdAt.toLocaleDateString("en-KE")}`}
        />
      ),
    },
    { key: "status", header: "Status", cell: (c) => <StatusBadge status={c.status} /> },
    { key: "users", header: "Users", align: "right", numeric: true, cell: (c) => c.users },
    {
      key: "modules",
      header: "Modules",
      align: "right",
      numeric: true,
      hideBelow: "sm",
      cell: (c) => `${c.modules}/${MODULE_LIST.length}`,
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

  const auditColumns: Array<Column<AuditRow>> = [
    {
      key: "when",
      header: "When",
      cell: (l) => (
        <span className="text-sm text-content-muted">
          {l.createdAt.toLocaleString("en-KE", {
            day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
          })}
        </span>
      ),
    },
    { key: "company", header: "Company", hideBelow: "sm", cell: (l) => l.company?.name ?? "—" },
    { key: "user", header: "User", cell: (l) => l.user?.name ?? "—" },
    { key: "action", header: "Action", cell: (l) => <StatusBadge status={l.action} /> },
    {
      key: "entity",
      header: "Entity",
      align: "right",
      hideBelow: "md",
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
          rows={overview.recentCompanies}
          getRowKey={(c) => c.id}
          caption="Most recently onboarded companies"
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
          empty={{ title: "No activity recorded yet" }}
          footer={
            <span>
              Showing the {audit.length} most recent events ·{" "}
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
