import Link from "next/link";
import { notFound } from "next/navigation";

import { Money, SectionHeading, StatCard, StatusBadge } from "@/components/ui";
import { db } from "@/lib/db";
import {
  CORE_PLATFORM_PRICE_CENTS,
  MODULE_CATALOG,
  MODULE_LIST,
  type ModuleKey,
} from "@/lib/modules";
import { ROLE_LABELS, type Role } from "@/lib/rbac";
import { tenantDashboard } from "@/server/analytics";

import { ModuleToggle, StatusControl } from "./module-toggle";

export const dynamic = "force-dynamic";

export default async function CompanyDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const company = await db.company.findUnique({
    where: { id },
    include: {
      modules: true,
      branches: true,
      users: {
        select: {
          id: true, name: true, email: true, role: true,
          status: true, lastLoginAt: true,
        },
        orderBy: { createdAt: "asc" },
      },
      _count: { select: { customers: true, products: true, invoices: true, visits: true } },
    },
  });

  if (!company) notFound();

  const enabledKeys = new Set(company.modules.filter((m) => m.enabled).map((m) => m.moduleKey));
  const moduleValue = company.modules
    .filter((m) => m.enabled)
    .reduce((sum, m) => sum + m.priceCents, 0);

  // Cross-tenant read, permitted because the layout restricts this route to
  // SUPER_ADMIN. Shown so the operator can see whether a tenant is actually
  // using what they bought.
  const metrics = await tenantDashboard(company.id, 30);

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link href="/admin/companies" className="text-content-muted text-xs hover:underline">
            ← All companies
          </Link>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">{company.name}</h1>
          <p className="text-content-muted text-sm">
            /{company.slug} · {company.email ?? "no email"} ·{" "}
            {company.taxPin ?? "no KRA PIN"}
          </p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <StatusBadge status={company.status} />
          <StatusControl companyId={company.id} status={company.status} />
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Licence value"
          value={<Money cents={CORE_PLATFORM_PRICE_CENTS + moduleValue} />}
          hint={`Core + ${enabledKeys.size} module(s)`}
        />
        <StatCard
          label="Seats"
          value={`${company.users.length} / ${company.seatLimit}`}
          hint="Users against licence"
          tone={company.users.length >= company.seatLimit ? "warning" : "neutral"}
        />
        <StatCard
          label="30-day sales"
          value={<Money cents={metrics.salesCents} compact />}
          hint={`${metrics.ordersCount} invoices`}
        />
        <StatCard
          label="Receivables"
          value={<Money cents={metrics.receivablesCents} compact />}
          hint={<><Money cents={metrics.overdueCents} compact /> overdue</>}
          tone={metrics.overdueCents > 0 ? "warning" : "neutral"}
        />
      </div>

      <div>
        <SectionHeading
          title="Module licences"
          description={`Core platform is always included at ${(CORE_PLATFORM_PRICE_CENTS / 100).toLocaleString("en-KE")} KES. Toggle what this tenant has purchased.`}
        />
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {MODULE_LIST.map((definition) => (
            <ModuleToggle
              key={definition.key}
              companyId={company.id}
              moduleKey={definition.key}
              name={definition.name}
              ordinal={definition.ordinal}
              priceCents={definition.priceCents}
              features={definition.features}
              enabled={enabledKeys.has(definition.key)}
            />
          ))}
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div>
          <SectionHeading title="Users" description={`${company.users.length} accounts`} />
          <div className="scroll-x rounded-lg border border-border bg-surface shadow-sm">
            <table className="w-full border-collapse text-base">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Role</th>
                  <th>Status</th>
                  <th>Last login</th>
                </tr>
              </thead>
              <tbody>
                {company.users.map((u) => (
                  <tr key={u.id}>
                    <td>
                      <p className="font-medium">{u.name}</p>
                      <p className="text-content-muted text-xs">{u.email}</p>
                    </td>
                    <td className="text-xs">{ROLE_LABELS[u.role as Role] ?? u.role}</td>
                    <td>
                      <StatusBadge status={u.status} />
                    </td>
                    <td className="text-content-muted text-xs">
                      {u.lastLoginAt
                        ? u.lastLoginAt.toLocaleDateString("en-KE")
                        : "Never"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="space-y-6">
          <div>
            <SectionHeading title="Branches" description={`${company.branches.length} locations`} />
            <div className="scroll-x rounded-lg border border-border bg-surface shadow-sm">
              <table className="w-full border-collapse text-base">
                <thead>
                  <tr>
                    <th>Branch</th>
                    <th>Code</th>
                    <th>Mapped</th>
                  </tr>
                </thead>
                <tbody>
                  {company.branches.map((b) => (
                    <tr key={b.id}>
                      <td className="font-medium">{b.name}</td>
                      <td className="text-content-text-content-muted">{b.code}</td>
                      <td>
                        {b.latitude != null ? (
                          <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium bg-success-bg text-success">yes</span>
                        ) : (
                          <span className="text-content-muted text-xs">no pin</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="rounded-lg border border-border bg-surface p-5 shadow-sm">
            <SectionHeading title="Data footprint" />
            <dl className="grid grid-cols-2 gap-4 text-sm">
              {[
                ["Customers", company._count.customers],
                ["Products", company._count.products],
                ["Invoices", company._count.invoices],
                ["Visits", company._count.visits],
              ].map(([label, value]) => (
                <div key={String(label)}>
                  <dt className="text-xs font-medium uppercase tracking-wide text-content-text-content-muted">{label}</dt>
                  <dd className="text-lg font-semibold">{String(value)}</dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      </div>

      <p className="text-content-muted text-xs">
        Disabled modules stay listed here rather than being removed, so the
        upgrade path from{" "}
        <Money cents={CORE_PLATFORM_PRICE_CENTS} /> core to{" "}
        <Money cents={CORE_PLATFORM_PRICE_CENTS + MODULE_LIST.reduce((s, m) => s + m.priceCents, 0)} />{" "}
        full platform stays visible.{" "}
        {MODULE_LIST.filter((m) => !enabledKeys.has(m.key)).length > 0
          ? `${MODULE_LIST.filter((m) => !enabledKeys.has(m.key)).length} module(s) still available: ${MODULE_LIST.filter((m) => !enabledKeys.has(m.key))
              .map((m) => MODULE_CATALOG[m.key as ModuleKey].name)
              .join(", ")}.`
          : "All ten modules are licensed."}
      </p>
    </div>
  );
}
