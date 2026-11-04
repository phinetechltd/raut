import Link from "next/link";

import {
  CellStack,
  DataTable,
  FilterBar,
  FilterSearch,
  FilterSelect,
  ModuleLocked,
  Money,
  PageHeader,
  SectionHeading,
  StatCard,
  StatGrid,
  StatusBadge,
  TileMap,
  type Column,
} from "@/components/ui";
import { db } from "@/lib/db";
import { parseBoundary } from "@/lib/geo";
import { MAP_PROVIDER_LABELS, toClientConfig } from "@/lib/maps";
import { can } from "@/lib/rbac";
import { requireTenant } from "@/lib/session";
import { preserved, tableHref, tableState, toggleSort } from "@/lib/table";
import { mapConfigFor } from "@/server/maps";

import { CustomerDialog, type CustomerShape } from "./customer-dialog";
import { TerritoryDialog } from "./territory-dialog";

export const dynamic = "force-dynamic";

const SORT_COLUMNS: Record<string, "name" | "code" | "town" | "balanceCents" | "status" | "createdAt"> = {
  name: "name",
  code: "code",
  town: "town",
  balance: "balanceCents",
  status: "status",
  created: "createdAt",
};

/** Module 01 · CRM — the customer list from proposal page 7. */
export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { companyId, principal } = await requireTenant();
  if (!principal.enabledModules.has("CRM")) return <ModuleLocked module="CRM" />;

  const params = await searchParams;
  const filters = params;

  const ts = tableState(params, {
    prefix: "cust",
    allowed: ["name", "code", "town", "balance", "status", "created"],
    defaultSort: "name",
    defaultDir: "asc",
    limit: 15,
  });

  const where = {
    companyId,
    ...(principal.role === "FIELD_REP" ? { assignedRepId: principal.userId } : {}),
    ...(filters.q
      ? {
          OR: [
            { name: { contains: filters.q } },
            { code: { contains: filters.q } },
            { phone: { contains: filters.q } },
            { town: { contains: filters.q } },
          ],
        }
      : {}),
    ...(filters.territory ? { territoryId: filters.territory } : {}),
    ...(filters.status ? { status: filters.status } : {}),
  };

  const orderBy: Record<string, "asc" | "desc"> = ts.sort
    ? { [SORT_COLUMNS[ts.sort]]: ts.dir }
    : { name: "asc" };

  const [customers, customerCount, territories, reps, totals] = await Promise.all([
    db.customer.findMany({
      where,
      include: {
        territory: { select: { id: true, name: true, colour: true } },
        assignedRep: { select: { name: true } },
      },
      orderBy,
      take: ts.limit,
      skip: (ts.page - 1) * ts.limit,
    }),
    db.customer.count({ where }),
    db.territory.findMany({
      where: { companyId, active: true },
      include: { _count: { select: { customers: true } } },
      orderBy: { name: "asc" },
    }),
    principal.role !== "FIELD_REP"
      ? db.user.findMany({
          where: { companyId, status: "ACTIVE", role: { in: ["FIELD_REP", "BRANCH_MANAGER", "SALES_MANAGER"] } },
          select: { id: true, name: true },
          orderBy: { name: "asc" },
        })
      : Promise.resolve([] as Array<{ id: string; name: string }>),
    db.customer.aggregate({
      where: { companyId },
      _sum: { balanceCents: true },
      _count: true,
    }),
  ]);

  const [allMapped, maps] = await Promise.all([
    db.customer.findMany({
      where: { ...where, latitude: { not: null } },
      select: { id: true, name: true, latitude: true, longitude: true, status: true, balanceCents: true },
    }),
    mapConfigFor(companyId),
  ]);

  const mapped = allMapped.filter((c) => c.latitude != null && c.longitude != null);

  const canWrite = can(principal, "customer:write");
  const canTerritory = can(principal, "territory:write");

  const sortHrefFor = (key: string) => {
    const next = toggleSort(ts, key);
    return tableHref("/app/customers", params, { cust_sort: next.sort, cust_dir: next.dir }, "cust");
  };

  type Row = (typeof customers)[number];
  const columns: Array<Column<Row>> = [
    {
      key: "name",
      header: "Customer",
      sortKey: "name",
      cell: (c) => (
        <CellStack
          primary={
            <span className="font-medium">{c.name}</span>
          }
          secondary={`${c.code} · ${c.town ?? "—"}`}
        />
      ),
    },
    {
      key: "territory",
      header: "Territory",
      hideBelow: "md",
      cell: (c) =>
        c.territory ? (
          <span className="inline-flex items-center gap-1.5 text-xs">
            <span className="h-2 w-2 rounded-full" style={{ background: c.territory.colour }} />
            {c.territory.name}
          </span>
        ) : (
          <span className="text-content-muted text-xs">Unassigned</span>
        ),
    },
    {
      key: "rep",
      header: "Rep",
      hideBelow: "lg",
      cell: (c) => <span className="text-xs">{c.assignedRep?.name ?? "—"}</span>,
    },
    {
      key: "segment",
      header: "Segment",
      hideBelow: "sm",
      cell: (c) => (
        <span className="badge bg-surface-sunken">{c.segment}</span>
      ),
    },
    {
      key: "terms",
      header: "Terms",
      hideBelow: "lg",
      cell: (c) => (
        <span className="text-content-muted text-xs">
          {c.paymentTermsDays > 0 ? `${c.paymentTermsDays}d` : "Cash"}
        </span>
      ),
    },
    {
      key: "balance",
      header: "Balance",
      align: "right",
      numeric: true,
      sortKey: "balance",
      cell: (c) => (
        <span className={c.balanceCents > 0 ? "font-medium text-warning" : "text-content-muted"}>
          <Money cents={c.balanceCents} />
        </span>
      ),
    },
    {
      key: "status",
      header: "Status",
      align: "right",
      sortKey: "status",
      cell: (c) => <StatusBadge status={c.status} />,
    },
  ];

  return (
    <div className="space-y-8">
      <PageHeader
        title="Customers"
        description="Advanced profiles, segmentation, territories and GPS pins."
        actions={
          <>
            {canTerritory ? <TerritoryDialog /> : null}
            {canWrite ? (
              <CustomerDialog
                mode="create"
                territories={territories as Array<{ id: string; name: string }>}
                reps={reps}
              />
            ) : null}
          </>
        }
      />

      <StatGrid>
        <StatCard label="Customers" value={String(totals._count)} />
        <StatCard
          label="Total balance"
          value={<Money cents={totals._sum.balanceCents ?? 0} compact />}
          hint="Outstanding across all accounts"
        />
        <StatCard label="Territories" value={String(territories.length)} />
        <StatCard
          label="GPS pins captured"
          value={`${mapped.length} / ${customerCount}`}
          hint="Required for routing and geofencing"
          tone={mapped.length < customerCount ? "warning" : "success"}
        />
      </StatGrid>

      <div>
        <SectionHeading
          title="Customer locations"
          description={`Pinned on ${MAP_PROVIDER_LABELS[maps.provider]}; fences are the territories below`}
        />
        <TileMap
          map={toClientConfig(maps)}
          points={mapped.map((c) => ({
            id: c.id,
            lat: c.latitude!,
            lng: c.longitude!,
            label: c.name,
            tone:
              c.status !== "ACTIVE" ? "danger" : c.balanceCents > 0 ? "warning" : "success",
          }))}
          polygons={territories
            .map((t) => ({
              id: t.id,
              colour: t.colour,
              vertices: parseBoundary(t.boundary).map(
                (v) => [v.lat, v.lng] as [number, number],
              ),
            }))
            .filter((p) => p.vertices.length >= 3)}
          height={420}
        />
      </div>

      <div>
        <SectionHeading title="Territories" />
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {territories.map((t) => (
            <CardLink
              key={t.id}
              href={`/app/customers?territory=${t.id}`}
              active={filters.territory === t.id}
            >
              <div className="flex items-center gap-2">
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: t.colour }} />
                <p className="text-sm font-medium">{t.name}</p>
              </div>
              <p className="text-content-muted mt-1 text-xs">
                {t._count.customers} customers ·{" "}
                {parseBoundary(t.boundary).length >= 3
                  ? "polygon fence"
                  : `${(t.radiusM / 1000).toFixed(0)}km radius`}
              </p>
            </CardLink>
          ))}
        </div>
      </div>

      <div>
        <SectionHeading
          title="All customers"
          description={`${customerCount.toLocaleString("en-KE")} accounts`}
        />
        <FilterBar
          action="/app/customers"
          preserve={preserved(params, ["q", "territory", "status", "cust_page"])}
        >
          <FilterSearch name="q" value={filters.q} placeholder="Search name, code, phone, town…" />
          <FilterSelect
            name="territory"
            value={filters.territory}
            allLabel="All territories"
            options={territories.map((t) => ({ value: t.id, label: t.name }))}
          />
          <FilterSelect
            name="status"
            value={filters.status}
            allLabel="Any status"
            options={[
              { value: "ACTIVE", label: "Active" },
              { value: "DORMANT", label: "Dormant" },
              { value: "BLOCKED", label: "Blocked" },
            ]}
          />
        </FilterBar>

        <DataTable
          columns={columns}
          rows={customers}
          getRowKey={(c) => c.id}
          caption="Customer list"
          sort={{ key: ts.sort, dir: ts.dir }}
          sortHrefFor={sortHrefFor}
          pagination={{
            page: ts.page,
            pages: Math.max(1, Math.ceil(customerCount / ts.limit)),
            total: customerCount,
            limit: ts.limit,
            hrefFor: (p) => tableHref("/app/customers", params, { cust_page: p }, undefined),
          }}
          empty={{
            title: "No customers match this filter",
            description: "Adjust the search or add a customer.",
            action: canWrite ? (
              <CustomerDialog
                mode="create"
                territories={territories as Array<{ id: string; name: string }>}
                reps={reps}
              />
            ) : undefined,
          }}
          onRowHref={(c) => `/app/customers/${c.id}`}
        />
      </div>
    </div>
  );
}

function CardLink({
  href,
  active,
  children,
}: {
  href: string;
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className={`card p-4 transition-[border-color,box-shadow] hover:border-border-strong hover:shadow-md ${
        active ? "border-accent" : ""
      }`}
    >
      {children}
    </Link>
  );
}
