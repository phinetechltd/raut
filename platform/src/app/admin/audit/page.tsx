import {
  CellStack,
  DataTable,
  FilterBar,
  FilterSearch,
  FilterSelect,
  SectionHeading,
  type Column,
} from "@/components/ui";
import { db } from "@/lib/db";
import { preserved, tableHref, tableState, toggleSort } from "@/lib/table";

export const dynamic = "force-dynamic";

const PATH = "/admin/audit";

const AUD_SORT: Record<string, (dir: "asc" | "desc") => Record<string, unknown>> = {
  when: (dir) => ({ createdAt: dir }),
  user: (dir) => ({ user: { name: dir } }),
  company: (dir) => ({ company: { name: dir } }),
  action: (dir) => ({ action: dir }),
  entity: (dir) => ({ entity: dir }),
};

/** Platform-wide audit trail — Phase One security deliverable. */
export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const filters = await searchParams;

  const ts = tableState(filters, {
    prefix: "aud",
    allowed: Object.keys(AUD_SORT),
    defaultSort: "when",
    defaultDir: "desc",
    limit: 25,
  });

  const where = {
    ...(filters.action ? { action: filters.action } : {}),
    ...(filters.entity ? { entity: filters.entity } : {}),
    ...(filters.q
      ? {
          OR: [
            { entityId: { contains: filters.q } },
            { user: { name: { contains: filters.q } } },
            { user: { email: { contains: filters.q } } },
            { company: { name: { contains: filters.q } } },
          ],
        }
      : {}),
  };

  const [logs, logCount, byAction, byEntity] = await Promise.all([
    db.auditLog.findMany({
      where,
      include: {
        user: { select: { name: true, email: true } },
        company: { select: { name: true } },
      },
      orderBy: AUD_SORT[ts.sort ?? "when"](ts.dir) as never,
      take: ts.limit,
      skip: (ts.page - 1) * ts.limit,
    }),
    db.auditLog.count({ where }),
    db.auditLog.groupBy({ by: ["action"], _count: true }),
    db.auditLog.groupBy({ by: ["entity"], orderBy: { entity: "asc" } }),
  ]);

  const sortHrefFor = (key: string) => {
    const next = toggleSort(ts, key);
    return tableHref(PATH, filters, { aud_sort: next.sort, aud_dir: next.dir }, "aud");
  };

  type Row = (typeof logs)[number];
  const columns: Array<Column<Row>> = [
    {
      key: "when",
      header: "When",
      sortKey: "when",
      cell: (log) => (
        <span className="text-content-muted text-xs">
          {log.createdAt.toLocaleString("en-KE", {
            day: "2-digit", month: "short",
            hour: "2-digit", minute: "2-digit",
          })}
        </span>
      ),
    },
    {
      key: "company",
      header: "Company",
      hideBelow: "sm",
      sortKey: "company",
      cell: (log) => <span className="text-xs">{log.company?.name ?? "—"}</span>,
    },
    {
      key: "user",
      header: "User",
      sortKey: "user",
      cell: (log) => (
        <CellStack
          primary={<span className="text-xs">{log.user?.name ?? "—"}</span>}
          secondary={log.user?.email ?? ""}
        />
      ),
    },
    {
      key: "action",
      header: "Action",
      sortKey: "action",
      cell: (log) => (
        <span
          className={`badge ${
            log.action.includes("FAILED") ? "bg-danger-bg text-danger" : "bg-surface-sunken"
          }`}
        >
          {log.action.toLowerCase()}
        </span>
      ),
    },
    {
      key: "entity",
      header: "Entity",
      sortKey: "entity",
      cell: (log) => (
        <CellStack
          primary={<span className="text-xs">{log.entity}</span>}
          secondary={log.entityId ? <span className="tabular">{log.entityId}</span> : ""}
        />
      ),
    },
    {
      key: "details",
      header: "Details",
      hideBelow: "md",
      cell: (log) => (
        <span className="text-content-muted block max-w-xs truncate text-xs" title={log.changes ?? ""}>
          {log.changes ?? "—"}
        </span>
      ),
    },
    {
      key: "ip",
      header: "IP",
      hideBelow: "lg",
      cell: (log) => <span className="text-content-muted text-xs tabular">{log.ipAddress ?? "—"}</span>,
    },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Audit Log</h1>
        <p className="text-content-muted text-sm">
          Append-only trail of authentication and state changes across all tenants.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <a href={PATH} className={`badge ${!filters.action ? "bg-accent-subtle text-accent" : "bg-surface-sunken"}`}>
          all ({byAction.reduce((s, a) => s + a._count, 0)})
        </a>
        {byAction
          .sort((a, b) => b._count - a._count)
          .map((a) => (
            <a
              key={a.action}
              href={`${PATH}?action=${a.action}`}
              className={`badge ${
                filters.action === a.action
                  ? "bg-accent-subtle text-accent"
                  : "bg-surface-sunken"
              }`}
            >
              {a.action.toLowerCase()} ({a._count})
            </a>
          ))}
      </div>

      <div>
        <SectionHeading title="Events" description={`${logCount.toLocaleString("en-KE")} match`} />
        <FilterBar action={PATH} preserve={preserved(filters, ["q", "action", "entity", "aud_page"])}>
          <FilterSearch name="q" value={filters.q} placeholder="Search entity id, user, company…" />
          <FilterSelect
            name="action"
            value={filters.action}
            allLabel="All actions"
            options={byAction.map((a) => ({ value: a.action, label: a.action.toLowerCase() }))}
          />
          <FilterSelect
            name="entity"
            value={filters.entity}
            allLabel="All entities"
            options={byEntity.map((e) => ({ value: e.entity, label: e.entity }))}
          />
        </FilterBar>
        <DataTable
          columns={columns}
          rows={logs}
          getRowKey={(log) => log.id}
          caption="Audit events"
          sort={{ key: ts.sort, dir: ts.dir }}
          sortHrefFor={sortHrefFor}
          pagination={{
            page: ts.page,
            pages: Math.max(1, Math.ceil(logCount / ts.limit)),
            total: logCount,
            limit: ts.limit,
            hrefFor: (p) => tableHref(PATH, filters, { aud_page: p }),
          }}
          empty={{ title: "No events match this filter" }}
        />
      </div>
    </div>
  );
}
