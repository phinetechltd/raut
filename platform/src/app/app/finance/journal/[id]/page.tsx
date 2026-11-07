import Link from "next/link";
import { notFound } from "next/navigation";

import { Callout, Card, DataTable, ModuleLocked, Money, PageHeader, StatusBadge, type Column } from "@/components/ui";
import { isManualJournal } from "@/lib/accounting";
import { db } from "@/lib/db";
import { can } from "@/lib/rbac";
import { nairobiDate } from "@/lib/report-engine";
import { requireTenant } from "@/lib/session";

import { ReverseJournalDialog } from "../journal-dialog";

export const dynamic = "force-dynamic";

export default async function JournalEntryPage({ params }: { params: Promise<{ id: string }> }) {
  const { companyId, principal } = await requireTenant();
  if (!principal.enabledModules.has("FINANCE")) return <ModuleLocked module="FINANCE" />;
  if (!can(principal, "report:financial")) notFound();

  const { id } = await params;
  const entry = await db.journalEntry.findFirst({
    where: { id, companyId },
    include: {
      lines: { include: { account: { select: { id: true, code: true, name: true } } } },
      reversedBy: { select: { id: true, number: true } },
      reverses: { select: { id: true, number: true } },
    },
  });
  if (!entry) notFound();

  const postedBy = entry.postedById
    ? await db.user.findFirst({ where: { id: entry.postedById, companyId }, select: { name: true } })
    : null;

  type Line = (typeof entry.lines)[number];
  const columns: Array<Column<Line>> = [
    {
      key: "account",
      header: "Account",
      cell: (l) => (
        <Link href={`/app/report-centre/general-ledger?s_account=${l.account.id}`} className="hover:underline">
          <span className="font-mono text-xs">{l.account.code}</span> {l.account.name}
        </Link>
      ),
    },
    { key: "memo", header: "Note", hideBelow: "md", cell: (l) => <span className="text-sm">{l.memo ?? "—"}</span> },
    { key: "debit", header: "Debit", align: "right", numeric: true, cell: (l) => (l.debitCents ? <Money cents={l.debitCents} exact /> : "—") },
    { key: "credit", header: "Credit", align: "right", numeric: true, cell: (l) => (l.creditCents ? <Money cents={l.creditCents} exact /> : "—") },
  ];
  const debit = entry.lines.reduce((n, l) => n + l.debitCents, 0);
  const credit = entry.lines.reduce((n, l) => n + l.creditCents, 0);

  const reversible = isManualJournal(entry.sourceKind) && !entry.reversedById && can(principal, "journal:write");

  return (
    <div className="space-y-6">
      <PageHeader
        title={entry.number}
        description={entry.memo ?? undefined}
        breadcrumb={{ href: "/app/finance/journal", label: "Journal entries" }}
        actions={reversible ? <ReverseJournalDialog id={entry.id} number={entry.number} /> : null}
      />

      {entry.reversedBy ? (
        <Callout tone="warning" title="This entry has been reversed">
          <Link href={`/app/finance/journal/${entry.reversedBy.id}`} className="underline">
            {entry.reversedBy.number}
          </Link>{" "}
          cancels it out.
        </Callout>
      ) : null}
      {entry.reverses ? (
        <Callout tone="info" title="This entry is a reversal">
          It cancels{" "}
          <Link href={`/app/finance/journal/${entry.reverses.id}`} className="underline">
            {entry.reverses.number}
          </Link>
          .
        </Callout>
      ) : null}

      <Card>
        <dl className="grid gap-4 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-xs text-content-muted">Date</dt>
            <dd className="font-medium">{nairobiDate(entry.date)}</dd>
          </div>
          <div>
            <dt className="text-xs text-content-muted">Source</dt>
            <dd>
              <StatusBadge status={entry.sourceKind.replace("REVERSAL:", "REVERSAL_")} />
            </dd>
          </div>
          <div>
            <dt className="text-xs text-content-muted">Posted by</dt>
            <dd className="font-medium">{postedBy?.name ?? "Automatic posting"}</dd>
          </div>
        </dl>
      </Card>

      <DataTable
        columns={columns}
        rows={entry.lines}
        getRowKey={(l) => l.id}
        caption={`Lines of ${entry.number}`}
        totals={
          <tr className="border-t-2 border-border font-semibold">
            <td className="px-4 py-2.5 text-sm">Total</td>
            <td className="hidden px-4 py-2.5 md:table-cell" />
            <td className="tabular px-4 py-2.5 text-right text-sm">
              <Money cents={debit} exact />
            </td>
            <td className="tabular px-4 py-2.5 text-right text-sm">
              <Money cents={credit} exact />
            </td>
          </tr>
        }
        empty={{ title: "No lines", description: "" }}
      />
    </div>
  );
}
