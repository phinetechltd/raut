import Link from "next/link";
import { notFound } from "next/navigation";

import {
  Badge,
  DataTable,
  FilterBar,
  FilterSearch,
  FilterSelect,
  ModuleLocked,
  Money,
  PageHeader,
  type Column,
} from "@/components/ui";
import { ACCOUNT_TYPES, ACCOUNT_TYPE_LABELS, type AccountTypeName } from "@/lib/accounting";
import { can } from "@/lib/rbac";
import { requireTenant } from "@/lib/session";
import { pageOf, preserved, sortRows, tableHref, tableState, toggleSort } from "@/lib/table";
import { chartWithBalances } from "@/server/accounting";

import { EditAccountDialog, NewAccountDialog } from "./account-dialog";

export const dynamic = "force-dynamic";

const PATH = "/app/finance/accounts";

/** The chart of accounts with what each account holds today. */
export default async function AccountsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { companyId, principal } = await requireTenant();
  if (!principal.enabledModules.has("FINANCE")) return <ModuleLocked module="FINANCE" />;
  if (!can(principal, "report:financial")) notFound();

  const params = await searchParams;
  const ts = tableState(params, {
    prefix: "ac",
    allowed: ["code", "name", "type", "balance"],
    defaultSort: "code",
    defaultDir: "asc",
    limit: 50,
  });

  const chart = await chartWithBalances(companyId);
  const q = params.q?.trim().toLowerCase();
  const filtered = chart.filter((a) => {
    if (params.type && a.type !== params.type) return false;
    if (params.status === "active" && !a.active) return false;
    if (params.status === "retired" && a.active) return false;
    return !q || a.code.includes(q) || a.name.toLowerCase().includes(q);
  });
  const sorted = sortRows(filtered, ts, {
    code: (a) => a.code,
    name: (a) => a.name,
    type: (a) => a.type,
    balance: (a) => a.balanceCents,
  });

  const canEdit = can(principal, "journal:write");

  type Row = (typeof chart)[number];
  const columns: Array<Column<Row>> = [
    {
      key: "code",
      header: "Code",
      sortKey: "code",
      cell: (a) => (
        <Link href={`/app/report-centre/general-ledger?s_account=${a.id}&range=ytd`} className="font-mono text-xs font-semibold hover:underline">
          {a.code}
        </Link>
      ),
    },
    { key: "name", header: "Account", sortKey: "name", cell: (a) => <span className="text-sm">{a.name}</span> },
    {
      key: "type",
      header: "Type",
      sortKey: "type",
      hideBelow: "sm",
      cell: (a) => <span className="badge bg-surface-sunken">{ACCOUNT_TYPE_LABELS[a.type as AccountTypeName] ?? a.type}</span>,
    },
    {
      key: "kind",
      header: "Used by",
      hideBelow: "lg",
      cell: (a) => <span className="text-xs text-content-muted">{a.systemKey ? "Automatic posting" : "Manual journals"}</span>,
    },
    { key: "balance", header: "Balance", align: "right", numeric: true, sortKey: "balance", cell: (a) => <Money cents={a.balanceCents} exact /> },
    {
      key: "status",
      header: "Status",
      align: "right",
      cell: (a) => <Badge tone={a.active ? "success" : "neutral"}>{a.active ? "Active" : "Retired"}</Badge>,
    },
    ...(canEdit
      ? [
          {
            key: "actions",
            header: <span className="sr-only">Actions</span>,
            align: "right" as const,
            cell: (a: Row) => (
              <EditAccountDialog id={a.id} code={a.code} name={a.name} active={a.active} system={Boolean(a.systemKey)} />
            ),
          } satisfies Column<Row>,
        ]
      : []),
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Chart of accounts"
        description="Select a code to see every line posted to that account."
        breadcrumb={{ href: "/app/finance", label: "Finance" }}
        actions={canEdit ? <NewAccountDialog /> : null}
      />
      <div>
        <FilterBar action={PATH} preserve={preserved(params, ["q", "type", "status", "ac_page"])}>
          <FilterSearch name="q" value={params.q} placeholder="Search code or name…" />
          <FilterSelect
            name="type"
            value={params.type}
            allLabel="All types"
            options={ACCOUNT_TYPES.map((t) => ({ value: t, label: ACCOUNT_TYPE_LABELS[t] }))}
          />
          <FilterSelect
            name="status"
            value={params.status}
            allLabel="Active and retired"
            options={[
              { value: "active", label: "Active" },
              { value: "retired", label: "Retired" },
            ]}
          />
        </FilterBar>
        <DataTable
          columns={columns}
          rows={pageOf(sorted, ts)}
          getRowKey={(a) => a.id}
          caption="Chart of accounts"
          sort={{ key: ts.sort, dir: ts.dir }}
          sortHrefFor={(key) => {
            const next = toggleSort(ts, key);
            return tableHref(PATH, params, { ac_sort: next.sort, ac_dir: next.dir }, "ac");
          }}
          pagination={{
            page: ts.page,
            pages: Math.max(1, Math.ceil(filtered.length / ts.limit)),
            total: filtered.length,
            limit: ts.limit,
            hrefFor: (p) => tableHref(PATH, params, { ac_page: p }, undefined),
          }}
          empty={{ title: "No accounts match", description: "Clear a filter to see more." }}
        />
      </div>
    </div>
  );
}
