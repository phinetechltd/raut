import { notFound } from "next/navigation";

import {
  Badge,
  ButtonLink,
  DataTable,
  ModuleLocked,
  Money,
  PageHeader,
  type Column,
} from "@/components/ui";
import { can } from "@/lib/rbac";
import { nairobiDate, nairobiMonth } from "@/lib/report-engine";
import { requireTenant } from "@/lib/session";
import { pageOf, tableHref, tableState } from "@/lib/table";
import { periodsOverview, type PeriodRow } from "@/server/accounting";

import { PeriodAction } from "./period-action";

export const dynamic = "force-dynamic";

const PATH = "/app/finance/periods";

/** Month-end close: once a month is reported on, nothing can slip into it unnoticed. */
export default async function PeriodsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { companyId, principal } = await requireTenant();
  if (!principal.enabledModules.has("FINANCE")) return <ModuleLocked module="FINANCE" />;
  if (!can(principal, "report:financial")) notFound();

  const params = await searchParams;
  const ts = tableState(params, { prefix: "per", limit: 12 });
  const periods = await periodsOverview(companyId);
  const current = nairobiMonth();
  const canClose = can(principal, "period:close");
  const canReopen = can(principal, "period:reopen");

  const columns: Array<Column<PeriodRow>> = [
    { key: "month", header: "Month", cell: (p) => <span className="font-mono font-semibold">{p.month}</span> },
    { key: "entries", header: "Entries", align: "right", numeric: true, cell: (p) => <span>{p.entries}</span> },
    { key: "value", header: "Value posted", align: "right", numeric: true, hideBelow: "sm", cell: (p) => <Money cents={p.debitCents} exact /> },
    {
      key: "state",
      header: "State",
      cell: (p) =>
        p.closedAt ? (
          <Badge tone="neutral">Closed</Badge>
        ) : p.month === current ? (
          <Badge tone="info">Current</Badge>
        ) : (
          <Badge tone="success">Open</Badge>
        ),
    },
    {
      key: "closed",
      header: "Closed",
      hideBelow: "md",
      cell: (p) =>
        p.closedAt ? (
          <span className="text-sm">
            {nairobiDate(p.closedAt)}
            {p.closedByName ? ` by ${p.closedByName}` : ""}
          </span>
        ) : (
          <span className="text-content-muted">—</span>
        ),
    },
    {
      key: "actions",
      header: <span className="sr-only">Actions</span>,
      align: "right",
      cell: (p) => {
        if (p.closedAt) return canReopen ? <PeriodAction month={p.month} action="reopen" /> : null;
        if (p.month >= current) return null;
        return canClose ? <PeriodAction month={p.month} action="close" /> : null;
      },
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Accounting periods"
        description="Close a month once it has been reported on, so nothing can be posted into it afterwards."
        breadcrumb={{ href: "/app/finance", label: "Finance" }}
        actions={
          <ButtonLink href="/app/report-centre/control-reconciliation" variant="secondary" size="sm">
            Check reconciliations first
          </ButtonLink>
        }
      />
      <DataTable
        columns={columns}
        rows={pageOf(periods, ts)}
        getRowKey={(p) => p.month}
        caption="Accounting periods"
        pagination={{
          page: ts.page,
          pages: Math.max(1, Math.ceil(periods.length / ts.limit)),
          total: periods.length,
          limit: ts.limit,
          hrefFor: (p) => tableHref(PATH, params, { per_page: p }, undefined),
        }}
        empty={{ title: "No periods", description: "" }}
      />
    </div>
  );
}
