import Link from "next/link";
import { notFound } from "next/navigation";

import {
  ButtonLink,
  CellStack,
  DataTable,
  FilterBar,
  FilterSearch,
  FilterSelect,
  ModuleLocked,
  Money,
  PageHeader,
  StatusBadge,
  type Column,
} from "@/components/ui";
import { isJournalLocked } from "@/lib/accounting";
import { db } from "@/lib/db";
import { can } from "@/lib/rbac";
import { nairobiDate } from "@/lib/report-engine";
import { requireTenant } from "@/lib/session";
import { preserved, tableHref, tableState, toggleSort } from "@/lib/table";
import { ensureChartOfAccounts } from "@/server/ledger";

import { JournalDialog } from "./journal-dialog";

export const dynamic = "force-dynamic";

const PATH = "/app/finance/journal";

const SORTS: Record<string, "date" | "number" | "sourceKind"> = {
  date: "date",
  number: "number",
  source: "sourceKind",
};

/** Every journal in the books, posted by a document or by hand, and the form for new ones. */
export default async function JournalPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { companyId, principal } = await requireTenant();
  if (!principal.enabledModules.has("FINANCE")) return <ModuleLocked module="FINANCE" />;
  if (!can(principal, "report:financial")) notFound();

  const params = await searchParams;
  const ts = tableState(params, {
    prefix: "jv",
    allowed: Object.keys(SORTS),
    defaultSort: "date",
    defaultDir: "desc",
    limit: 20,
  });

  await ensureChartOfAccounts(companyId);

  const where = {
    companyId,
    ...(params.source ? { sourceKind: params.source } : {}),
    ...(params.q
      ? {
          OR: [
            { number: { contains: params.q } },
            { memo: { contains: params.q } },
          ],
        }
      : {}),
  };

  const [entries, total, sources, accounts] = await Promise.all([
    db.journalEntry.findMany({
      where,
      select: {
        id: true,
        number: true,
        date: true,
        memo: true,
        sourceKind: true,
        reversedById: true,
        lines: { select: { debitCents: true } },
      },
      orderBy: ts.sort ? [{ [SORTS[ts.sort]]: ts.dir }, { number: "desc" }] : [{ date: "desc" }],
      take: ts.limit,
      skip: (ts.page - 1) * ts.limit,
    }),
    db.journalEntry.count({ where }),
    db.journalEntry.groupBy({ by: ["sourceKind"], where: { companyId } }),
    db.account.findMany({
      where: { companyId, active: true, isPostable: true },
      select: { id: true, code: true, name: true, systemKey: true },
      orderBy: { code: "asc" },
    }),
  ]);

  type Row = (typeof entries)[number];
  const columns: Array<Column<Row>> = [
    { key: "date", header: "Date", sortKey: "date", cell: (e) => <span>{nairobiDate(e.date)}</span> },
    {
      key: "number",
      header: "Journal",
      sortKey: "number",
      cell: (e) => (
        <Link href={`${PATH}/${e.id}`} className="font-mono text-xs font-semibold hover:underline">
          {e.number}
        </Link>
      ),
    },
    {
      key: "memo",
      header: "Narration",
      cell: (e) => <CellStack primary={<span className="text-sm">{e.memo ?? "—"}</span>} secondary={e.reversedById ? "Reversed" : ""} />,
    },
    {
      key: "source",
      header: "Source",
      sortKey: "source",
      hideBelow: "md",
      cell: (e) => <StatusBadge status={e.sourceKind.replace("REVERSAL:", "REVERSAL_")} />,
    },
    {
      key: "amount",
      header: "Amount",
      align: "right",
      numeric: true,
      cell: (e) => <Money cents={e.lines.reduce((n, l) => n + l.debitCents, 0)} exact />,
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Journal entries"
        description="Every entry in the books. Nothing here can be edited or deleted; a correction is a reversing entry."
        breadcrumb={{ href: "/app/finance", label: "Finance" }}
        actions={
          <>
            <ButtonLink href="/app/finance/accounts" variant="secondary" size="sm">
              Chart of accounts
            </ButtonLink>
            <ButtonLink href="/app/finance/periods" variant="secondary" size="sm">
              Close a month
            </ButtonLink>
            {can(principal, "journal:write") ? (
              <JournalDialog
                today={nairobiDate()}
                accounts={accounts
                  .filter((a) => !isJournalLocked(a.systemKey))
                  .map((a) => ({ id: a.id, label: `${a.code} ${a.name}` }))}
              />
            ) : null}
          </>
        }
      />

      <div>
        <FilterBar action={PATH} preserve={preserved(params, ["q", "source", "jv_page"])}>
          <FilterSearch name="q" value={params.q} placeholder="Search number or narration…" />
          <FilterSelect
            name="source"
            value={params.source}
            allLabel="All sources"
            options={sources.map((s) => ({ value: s.sourceKind, label: s.sourceKind.replaceAll("_", " ").toLowerCase() }))}
          />
        </FilterBar>
        <DataTable
          columns={columns}
          rows={entries}
          getRowKey={(e) => e.id}
          caption="Journal entries"
          sort={{ key: ts.sort, dir: ts.dir }}
          sortHrefFor={(key) => {
            const next = toggleSort(ts, key);
            return tableHref(PATH, params, { jv_sort: next.sort, jv_dir: next.dir }, "jv");
          }}
          pagination={{
            page: ts.page,
            pages: Math.max(1, Math.ceil(total / ts.limit)),
            total,
            limit: ts.limit,
            hrefFor: (p) => tableHref(PATH, params, { jv_page: p }, undefined),
          }}
          empty={{ title: "No journal entries", description: "Entries appear as documents are posted, or when one is added by hand." }}
        />
      </div>
    </div>
  );
}
