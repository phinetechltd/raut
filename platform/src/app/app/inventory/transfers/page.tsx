import {
  CellStack,
  DataTable,
  FilterBar,
  FilterSearch,
  FilterSelect,
  ModuleLocked,
  PageHeader,
  StatusBadge,
  type Column,
} from "@/components/ui";
import { db } from "@/lib/db";
import { can } from "@/lib/rbac";
import { requireTenant } from "@/lib/session";
import { preserved, tableHref, tableState, toggleSort } from "@/lib/table";
import { TRANSFER_STATUSES } from "@/server/inventory";

import { TransferCloseDialog, TransferCreateDialog, TransferStepDialog, type TransferShape } from "./transfer-dialog";

export const dynamic = "force-dynamic";

const SORT: Record<string, string> = {
  created: "createdAt",
  number: "number",
  status: "status",
  dispatched: "dispatchedAt",
  received: "receivedAt",
};

const STATUS_OPTIONS = TRANSFER_STATUSES.map((s) => ({
  value: s,
  label: s.toLowerCase().replaceAll("_", " "),
}));

/** Module 03 · Stock transfers between locations, dispatched and received in parts. */
export default async function TransfersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { companyId, principal } = await requireTenant();
  if (!principal.enabledModules.has("INVENTORY")) return <ModuleLocked module="INVENTORY" />;

  const params = await searchParams;
  const ts = tableState(params, {
    prefix: "trf",
    allowed: Object.keys(SORT),
    defaultSort: "created",
    defaultDir: "desc",
    limit: 15,
  });
  const canWrite = can(principal, "stock:write");

  const where = {
    companyId,
    ...(params.trf_status && (TRANSFER_STATUSES as string[]).includes(params.trf_status)
      ? { status: params.trf_status }
      : {}),
    ...(params.trf_q
      ? {
          OR: [
            { number: { contains: params.trf_q } },
            { note: { contains: params.trf_q } },
            { fromLocation: { name: { contains: params.trf_q } } },
            { toLocation: { name: { contains: params.trf_q } } },
            { lines: { some: { product: { OR: [{ name: { contains: params.trf_q } }, { sku: { contains: params.trf_q } }] } } } },
          ],
        }
      : {}),
  };

  const [transfers, total, locations, inTransit] = await Promise.all([
    db.stockTransfer.findMany({
      where,
      include: {
        fromLocation: { select: { id: true, name: true } },
        toLocation: { select: { id: true, name: true } },
        lines: { include: { product: { select: { name: true, sku: true } } } },
      },
      orderBy: { [SORT[ts.sort ?? "created"]]: ts.dir } as Record<string, "asc" | "desc">,
      take: ts.limit,
      skip: (ts.page - 1) * ts.limit,
    }),
    db.stockTransfer.count({ where }),
    db.stockLocation.findMany({ where: { companyId, active: true }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    db.stockTransfer.count({
      where: { companyId, status: { in: ["PARTIALLY_DISPATCHED", "IN_TRANSIT", "PARTIALLY_RECEIVED"] } },
    }),
  ]);

  const sortHrefFor = (key: string) => {
    const next = toggleSort(ts, key);
    return tableHref("/app/inventory/transfers", params, { trf_sort: next.sort, trf_dir: next.dir }, "trf");
  };

  type Row = (typeof transfers)[number];
  const columns: Array<Column<Row>> = [
    {
      key: "number",
      header: "Transfer",
      sortKey: "number",
      cell: (t) => <CellStack primary={<span className="font-medium">{t.number}</span>} secondary={t.note ?? ""} />,
    },
    {
      key: "route",
      header: "From → To",
      cell: (t) => (
        <span className="text-sm">
          {t.fromLocation.name} <span className="text-content-muted">→</span> {t.toLocation.name}
        </span>
      ),
    },
    {
      key: "lines",
      header: "Lines",
      hideBelow: "md",
      cell: (t) => (
        <ul className="space-y-0.5 text-xs">
          {t.lines.map((l) => (
            <li key={l.id}>
              <span className="font-medium">{l.product.name}</span>{" "}
              <span className="text-content-muted tabular">
                {l.quantity} · sent {l.dispatched} · received {l.received}
              </span>
            </li>
          ))}
        </ul>
      ),
    },
    {
      key: "created",
      header: "Created",
      sortKey: "created",
      hideBelow: "sm",
      cell: (t) => <span className="text-content-muted text-xs">{t.createdAt.toLocaleDateString("en-KE")}</span>,
    },
    {
      key: "dispatched",
      header: "Dispatched",
      sortKey: "dispatched",
      hideBelow: "lg",
      cell: (t) => <span className="text-content-muted text-xs">{t.dispatchedAt?.toLocaleDateString("en-KE") ?? "—"}</span>,
    },
    {
      key: "received",
      header: "Received",
      sortKey: "received",
      hideBelow: "lg",
      cell: (t) => (
        <span className="text-content-muted text-xs">
          {t.receivedAt?.toLocaleDateString("en-KE") ?? "—"}
          {t.shortClosedAt ? " · short" : ""}
        </span>
      ),
    },
    {
      key: "status",
      header: "Status",
      sortKey: "status",
      align: "right",
      cell: (t) => <StatusBadge status={t.status} />,
    },
    ...(canWrite
      ? [
          {
            key: "actions",
            header: "Actions",
            srOnlyHeader: true,
            align: "right" as const,
            cell: (t: Row) => {
              const shape = t as unknown as TransferShape;
              const open = !t.shortClosedAt && t.status !== "CANCELLED" && t.status !== "RECEIVED";
              return (
                <div className="flex flex-wrap justify-end gap-1">
                  {open ? <TransferStepDialog transfer={shape} action="dispatch" /> : null}
                  {open ? <TransferStepDialog transfer={shape} action="receive" /> : null}
                  {t.status === "DRAFT" ? <TransferCloseDialog transfer={shape} action="cancel" /> : null}
                  {open && t.status !== "DRAFT" ? <TransferCloseDialog transfer={shape} action="close-short" /> : null}
                </div>
              );
            },
          } satisfies Column<Row>,
        ]
      : []),
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Stock transfers"
        description={`Goods moving between your locations · ${inTransit} open`}
        breadcrumb={{ href: "/app/inventory", label: "Inventory" }}
        actions={canWrite && locations.length > 1 ? <TransferCreateDialog locations={locations} /> : null}
      />

      <FilterBar action="/app/inventory/transfers" preserve={preserved(params, ["trf_q", "trf_status", "trf_page"])}>
        <FilterSearch name="trf_q" value={params.trf_q} placeholder="Search number, location, product…" />
        <FilterSelect name="trf_status" value={params.trf_status} allLabel="Any status" options={STATUS_OPTIONS} />
      </FilterBar>

      <DataTable
        columns={columns}
        rows={transfers}
        getRowKey={(t) => t.id}
        caption="Stock transfers"
        sort={{ key: ts.sort, dir: ts.dir }}
        sortHrefFor={sortHrefFor}
        pagination={{
          page: ts.page,
          pages: Math.max(1, Math.ceil(total / ts.limit)),
          total,
          limit: ts.limit,
          hrefFor: (pg) => tableHref("/app/inventory/transfers", params, { trf_page: pg }),
        }}
        empty={{
          title: params.trf_q || params.trf_status ? "No transfers match this filter" : "No transfers yet",
          description: locations.length < 2 ? "Add a second stock location under Settings to move goods between them." : undefined,
          action: canWrite && locations.length > 1 ? <TransferCreateDialog locations={locations} /> : undefined,
        }}
      />
    </div>
  );
}
