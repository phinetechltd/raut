import Link from "next/link";

import {
  CellStack,
  DataTable,
  FilterBar,
  FilterSearch,
  FilterSelect,
  Money,
  SectionHeading,
  StatusBadge,
  type Column,
} from "@/components/ui";
import { db } from "@/lib/db";
import { MODULE_LIST } from "@/lib/modules";
import { preserved, tableHref, tableState, toggleSort } from "@/lib/table";

import { NewCompanyForm } from "./new-company-form";

export const dynamic = "force-dynamic";

const PATH = "/admin/companies";

type CompanyRow = {
  id: string;
  name: string;
  slug: string;
  status: string;
  seatLimit: number;
  createdAt: Date;
  users: number;
  customers: number;
  invoices: number;
  modules: number;
  licenceCents: number;
};

const CO_SORT: Record<string, (c: CompanyRow) => string | number> = {
  name: (c) => c.name.toLowerCase(),
  status: (c) => c.status,
  users: (c) => c.users,
  customers: (c) => c.customers,
  invoices: (c) => c.invoices,
  modules: (c) => c.modules,
  licence: (c) => c.licenceCents,
  created: (c) => c.createdAt.getTime(),
};

const STATUSES = [
  { value: "PENDING", label: "Pending" },
  { value: "ACTIVE", label: "Active" },
  { value: "SUSPENDED", label: "Suspended" },
];

export default async function CompaniesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const params = await searchParams;

  const ts = tableState(params, {
    prefix: "co",
    allowed: Object.keys(CO_SORT),
    defaultSort: "created",
    defaultDir: "desc",
    limit: 15,
  });

  const where = {
    ...(params.co_status ? { status: params.co_status } : {}),
    ...(params.co_q
      ? { OR: [{ name: { contains: params.co_q } }, { slug: { contains: params.co_q } }] }
      : {}),
  };

  // A platform has tens of tenants, not millions, and two of the sortable
  // columns (enabled modules, licence value) are derived — so the whole
  // matching set is loaded and ordered here.
  const [companies, totalCount] = await Promise.all([
    db.company.findMany({
      where,
      include: {
        _count: { select: { users: true, customers: true, invoices: true } },
        modules: { where: { enabled: true }, select: { priceCents: true } },
      },
    }),
    db.company.count(),
  ]);

  const rows: CompanyRow[] = companies.map((c) => ({
    id: c.id,
    name: c.name,
    slug: c.slug,
    status: c.status,
    seatLimit: c.seatLimit,
    createdAt: c.createdAt,
    users: c._count.users,
    customers: c._count.customers,
    invoices: c._count.invoices,
    modules: c.modules.length,
    licenceCents: c.modules.reduce((s, m) => s + m.priceCents, 0),
  }));

  const value = CO_SORT[ts.sort ?? "created"];
  const sorted = [...rows].sort((a, b) => {
    const av = value(a);
    const bv = value(b);
    const cmp = typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv));
    return ts.dir === "asc" ? cmp : -cmp;
  });
  const pages = Math.max(1, Math.ceil(sorted.length / ts.limit));
  const page = Math.min(ts.page, pages);
  const paged = sorted.slice((page - 1) * ts.limit, page * ts.limit);

  const sortHrefFor = (key: string) => {
    const next = toggleSort(ts, key);
    return tableHref(PATH, params, { co_sort: next.sort, co_dir: next.dir }, "co");
  };

  const columns: Array<Column<CompanyRow>> = [
    {
      key: "name",
      header: "Company",
      sortKey: "name",
      cell: (c) => <CellStack primary={<span className="font-medium">{c.name}</span>} secondary={`/${c.slug}`} />,
    },
    { key: "status", header: "Status", sortKey: "status", cell: (c) => <StatusBadge status={c.status} /> },
    {
      key: "users",
      header: "Users",
      align: "right",
      numeric: true,
      sortKey: "users",
      cell: (c) => (
        <>
          {c.users}
          <span className="text-content-muted">/{c.seatLimit}</span>
        </>
      ),
    },
    { key: "customers", header: "Customers", align: "right", numeric: true, hideBelow: "md", sortKey: "customers", cell: (c) => c.customers },
    { key: "invoices", header: "Invoices", align: "right", numeric: true, hideBelow: "md", sortKey: "invoices", cell: (c) => c.invoices },
    {
      key: "modules",
      header: "Modules",
      align: "right",
      numeric: true,
      hideBelow: "sm",
      sortKey: "modules",
      cell: (c) => (
        <>
          {c.modules}
          <span className="text-content-muted">/{MODULE_LIST.length}</span>
        </>
      ),
    },
    {
      key: "licence",
      header: "Licence value",
      align: "right",
      numeric: true,
      hideBelow: "lg",
      sortKey: "licence",
      cell: (c) => <Money cents={c.licenceCents} />,
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
      srOnlyHeader: true,
      align: "right",
      cell: (c) => (
        <Link href={`/admin/companies/${c.id}`} className="text-xs text-accent hover:underline">
          Manage
        </Link>
      ),
    },
  ];

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Companies</h1>
        <p className="text-content-muted text-sm">
          Create, activate and license tenants on the shared instance.
        </p>
      </div>

      <div>
        <SectionHeading title="All tenants" description={`${totalCount} on this instance`} />
        <FilterBar action={PATH} preserve={preserved(params, ["co_q", "co_status", "co_page"])}>
          <FilterSearch name="co_q" value={params.co_q} placeholder="Search name, slug…" />
          <FilterSelect name="co_status" value={params.co_status} allLabel="Any status" options={STATUSES} />
        </FilterBar>
        <DataTable
          columns={columns}
          rows={paged}
          getRowKey={(c) => c.id}
          caption="All tenants"
          sort={{ key: ts.sort, dir: ts.dir }}
          sortHrefFor={sortHrefFor}
          pagination={{
            page,
            pages,
            total: sorted.length,
            limit: ts.limit,
            hrefFor: (p) => tableHref(PATH, params, { co_page: p }),
          }}
          empty={{ title: params.co_q || params.co_status ? "No companies match this filter" : "No companies yet" }}
        />
      </div>

      <div>
        <SectionHeading
          title="Onboard a new company"
          description="Creates the tenant, its head office, main store, admin user and licences in one step."
        />
        <NewCompanyForm />
      </div>
    </div>
  );
}
