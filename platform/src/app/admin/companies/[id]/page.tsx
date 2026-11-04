import Link from "next/link";
import { notFound } from "next/navigation";

import {
  CellStack,
  DataTable,
  FilterBar,
  FilterSearch,
  Money,
  SectionHeading,
  StatCard,
  StatusBadge,
  type Column,
} from "@/components/ui";
import { db } from "@/lib/db";
import {
  CORE_PLATFORM_PRICE_CENTS,
  MODULE_CATALOG,
  MODULE_LIST,
  type ModuleKey,
} from "@/lib/modules";
import { maskKey } from "@/lib/maps";
import { ROLE_LABELS, type Role } from "@/lib/rbac";
import { preserved, tableHref, tableState, toggleSort } from "@/lib/table";
import { daysAgo, tenantDashboard } from "@/server/analytics";
import { mapConfigFor, platformMapDefaults, readStoredMapSettings } from "@/server/maps";

import { MapSettingsControl } from "./map-settings-control";
import { ModuleToggle, StatusControl } from "./module-toggle";

export const dynamic = "force-dynamic";

const USR_SORT: Record<string, string> = {
  name: "name",
  role: "role",
  status: "status",
  lastLogin: "lastLoginAt",
  created: "createdAt",
};
const BR_SORT: Record<string, string> = { name: "name", code: "code", mapped: "latitude" };

export default async function CompanyDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const path = `/admin/companies/${id}`;

  const usrTs = tableState(sp, {
    prefix: "usr",
    allowed: Object.keys(USR_SORT),
    defaultSort: "created",
    defaultDir: "asc",
    limit: 10,
  });
  const brTs = tableState(sp, {
    prefix: "br",
    allowed: Object.keys(BR_SORT),
    defaultSort: "name",
    defaultDir: "asc",
    limit: 10,
  });

  const company = await db.company.findUnique({
    where: { id },
    include: {
      modules: true,
      _count: { select: { customers: true, products: true, invoices: true, visits: true, users: true, branches: true } },
    },
  });

  if (!company) notFound();

  const userWhere = {
    companyId: company.id,
    ...(sp.usr_q ? { OR: [{ name: { contains: sp.usr_q } }, { email: { contains: sp.usr_q } }] } : {}),
  };
  const branchWhere = {
    companyId: company.id,
    ...(sp.br_q ? { OR: [{ name: { contains: sp.br_q } }, { code: { contains: sp.br_q } }] } : {}),
  };

  const enabledKeys = new Set(company.modules.filter((m) => m.enabled).map((m) => m.moduleKey));
  const moduleValue = company.modules
    .filter((m) => m.enabled)
    .reduce((sum, m) => sum + m.priceCents, 0);

  // Cross-tenant read, permitted because the layout restricts this route to
  // SUPER_ADMIN. Shown so the operator can see whether a tenant is actually
  // using what they bought.
  const [metrics, mapStored, mapEffective, users, userCount, branches, branchCount] = await Promise.all([
    tenantDashboard(company.id, { from: daysAgo(29), to: new Date() }),
    readStoredMapSettings(company.id),
    mapConfigFor(company.id),
    db.user.findMany({
      where: userWhere,
      select: { id: true, name: true, email: true, role: true, status: true, lastLoginAt: true },
      orderBy: { [USR_SORT[usrTs.sort ?? "created"]]: usrTs.dir } as Record<string, "asc" | "desc">,
      take: usrTs.limit,
      skip: (usrTs.page - 1) * usrTs.limit,
    }),
    db.user.count({ where: userWhere }),
    db.branch.findMany({
      where: branchWhere,
      orderBy: { [BR_SORT[brTs.sort ?? "name"]]: brTs.dir } as Record<string, "asc" | "desc">,
      take: brTs.limit,
      skip: (brTs.page - 1) * brTs.limit,
    }),
    db.branch.count({ where: branchWhere }),
  ]);
  const mapPlatform = platformMapDefaults();

  const usrSortHrefFor = (key: string) => {
    const next = toggleSort(usrTs, key);
    return tableHref(path, sp, { usr_sort: next.sort, usr_dir: next.dir }, "usr");
  };
  const brSortHrefFor = (key: string) => {
    const next = toggleSort(brTs, key);
    return tableHref(path, sp, { br_sort: next.sort, br_dir: next.dir }, "br");
  };

  type UserRow = (typeof users)[number];
  const userColumns: Array<Column<UserRow>> = [
    {
      key: "name",
      header: "Name",
      sortKey: "name",
      cell: (u) => <CellStack primary={<span className="font-medium">{u.name}</span>} secondary={u.email} />,
    },
    { key: "role", header: "Role", sortKey: "role", cell: (u) => <span className="text-xs">{ROLE_LABELS[u.role as Role] ?? u.role}</span> },
    { key: "status", header: "Status", sortKey: "status", cell: (u) => <StatusBadge status={u.status} /> },
    {
      key: "lastLogin",
      header: "Last login",
      hideBelow: "sm",
      sortKey: "lastLogin",
      cell: (u) => (
        <span className="text-content-muted text-xs">
          {u.lastLoginAt ? u.lastLoginAt.toLocaleDateString("en-KE") : "Never"}
        </span>
      ),
    },
  ];

  type BranchRow = (typeof branches)[number];
  const branchColumns: Array<Column<BranchRow>> = [
    { key: "name", header: "Branch", sortKey: "name", cell: (b) => <span className="font-medium">{b.name}</span> },
    { key: "code", header: "Code", sortKey: "code", cell: (b) => <span className="text-content-muted text-xs">{b.code}</span> },
    {
      key: "mapped",
      header: "Mapped",
      align: "right",
      sortKey: "mapped",
      cell: (b) =>
        b.latitude != null ? (
          <span className="badge bg-success-bg text-success border-success-border">yes</span>
        ) : (
          <span className="text-content-muted text-xs">no pin</span>
        ),
    },
  ];

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
          value={`${company._count.users} / ${company.seatLimit}`}
          hint="Users against licence"
          tone={company._count.users >= company.seatLimit ? "warning" : "neutral"}
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

      <div>
        <SectionHeading
          title="Maps"
          description="The basemap behind this company's console maps and the field app's Directions buttons. The company's own admin can change it under Settings → Maps."
        />
        <MapSettingsControl
          companyId={company.id}
          stored={{
            provider: mapStored.provider,
            googleApiKeyHint: maskKey(mapStored.googleApiKey),
            googleMapId: mapStored.googleMapId,
          }}
          effective={{
            provider: mapEffective.provider,
            providerSource: mapEffective.providerSource,
            googleKeySource: mapEffective.google?.keySource ?? null,
            warning: mapEffective.warning,
          }}
          platform={{
            defaultProvider: mapPlatform.provider,
            hasGoogleApiKey: Boolean(mapPlatform.googleApiKey),
          }}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div>
          <SectionHeading title="Users" description={`${userCount} accounts`} />
          <FilterBar action={path} preserve={preserved(sp, ["usr_q", "usr_page"])}>
            <FilterSearch name="usr_q" value={sp.usr_q} placeholder="Search name, email…" />
          </FilterBar>
          <DataTable
            columns={userColumns}
            rows={users}
            getRowKey={(u) => u.id}
            caption="Tenant users"
            dense
            sort={{ key: usrTs.sort, dir: usrTs.dir }}
            sortHrefFor={usrSortHrefFor}
            pagination={{
              page: usrTs.page,
              pages: Math.max(1, Math.ceil(userCount / usrTs.limit)),
              total: userCount,
              limit: usrTs.limit,
              hrefFor: (p) => tableHref(path, sp, { usr_page: p }),
            }}
            empty={{ title: sp.usr_q ? "No users match" : "No users yet" }}
          />
        </div>

        <div className="space-y-6">
          <div>
            <SectionHeading title="Branches" description={`${branchCount} locations`} />
            <FilterBar action={path} preserve={preserved(sp, ["br_q", "br_page"])}>
              <FilterSearch name="br_q" value={sp.br_q} placeholder="Search branch, code…" />
            </FilterBar>
            <DataTable
              columns={branchColumns}
              rows={branches}
              getRowKey={(b) => b.id}
              caption="Tenant branches"
              dense
              sort={{ key: brTs.sort, dir: brTs.dir }}
              sortHrefFor={brSortHrefFor}
              pagination={{
                page: brTs.page,
                pages: Math.max(1, Math.ceil(branchCount / brTs.limit)),
                total: branchCount,
                limit: brTs.limit,
                hrefFor: (p) => tableHref(path, sp, { br_page: p }),
              }}
              empty={{ title: sp.br_q ? "No branches match" : "No branches yet" }}
            />
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
