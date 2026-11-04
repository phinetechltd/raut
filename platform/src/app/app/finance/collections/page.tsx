import {
  Callout,
  CellStack,
  DataTable,
  FilterBar,
  FilterSearch,
  FilterSelect,
  ModuleLocked,
  Money,
  PageHeader,
  StatCard,
  StatGrid,
  StatusBadge,
  type Column,
} from "@/components/ui";
import { db } from "@/lib/db";
import { can } from "@/lib/rbac";
import { requireTenant } from "@/lib/session";
import { preserved, tableHref, tableState, toggleSort } from "@/lib/table";

import { RecheckButton } from "./recheck-button";

export const dynamic = "force-dynamic";

const SORT: Record<string, "createdAt" | "amountCents" | "status" | "provider" | "completedAt"> = {
  created: "createdAt",
  amount: "amountCents",
  status: "status",
  provider: "provider",
  completed: "completedAt",
};

const STATUSES = ["PENDING", "PROCESSING", "SETTLING", "SUCCEEDED", "FAILED", "EXPIRED", "REVERSED", "CANCELLED"];

const PROVIDER_LABEL: Record<string, string> = {
  MPESA_DARAJA: "M-Pesa",
  PAYSTACK: "Paystack",
  KCB_BUNI: "KCB Buni",
};

const TERMINAL = new Set(["SUCCEEDED", "FAILED", "EXPIRED", "REVERSED", "CANCELLED"]);

/**
 * Finance → Collections: every gateway collection and where it got to.
 *
 * This is the page an accountant opens when a customer says "I paid on my
 * phone" and the receipt is not on the account. It shows the intent, its
 * provider, the receipt the provider issued, and why a failed one failed, with
 * a Re-check that asks the provider again. A REVERSED row is the one thing on
 * this page that demands a human decision: the money was booked and then taken
 * back, and the ledger has deliberately not been touched.
 */
export default async function CollectionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { companyId, principal } = await requireTenant();
  if (!principal.enabledModules.has("FINANCE")) return <ModuleLocked module="FINANCE" />;
  if (!can(principal, "payment:read")) return <ModuleLocked module="FINANCE" />;

  const params = await searchParams;
  const ts = tableState(params, {
    prefix: "col",
    allowed: Object.keys(SORT),
    defaultSort: "created",
    defaultDir: "desc",
    limit: 20,
  });

  const q = params.col_q?.trim();
  const status = params.col_status && STATUSES.includes(params.col_status) ? params.col_status : undefined;
  const provider = params.col_provider && PROVIDER_LABEL[params.col_provider] ? params.col_provider : undefined;

  const where = {
    companyId,
    ...(status ? { status } : {}),
    ...(provider ? { provider } : {}),
    ...(q
      ? {
          OR: [
            { id: { contains: q } },
            { receiptRef: { contains: q } },
            { providerRef: { contains: q } },
            { payerPhone: { contains: q } },
            { payerEmail: { contains: q } },
            { customer: { name: { contains: q } } },
            { customer: { code: { contains: q } } },
          ],
        }
      : {}),
  };

  const since = new Date(Date.now() - 24 * 3600_000);
  const [rows, total, open, reversed, settledToday] = await Promise.all([
    db.paymentIntent.findMany({
      where,
      include: {
        customer: { select: { id: true, name: true, code: true } },
      },
      orderBy: { [SORT[ts.sort ?? "created"]]: ts.dir },
      take: ts.limit,
      skip: (ts.page - 1) * ts.limit,
    }),
    db.paymentIntent.count({ where }),
    db.paymentIntent.count({ where: { companyId, status: { in: ["PENDING", "PROCESSING", "SETTLING"] } } }),
    db.paymentIntent.count({ where: { companyId, status: "REVERSED" } }),
    db.paymentIntent.aggregate({
      where: { companyId, status: "SUCCEEDED", completedAt: { gte: since } },
      _sum: { amountCents: true },
      _count: true,
    }),
  ]);

  const paymentIds = rows.map((r) => r.paymentId).filter((id): id is string => Boolean(id));
  const payments = paymentIds.length
    ? await db.payment.findMany({ where: { id: { in: paymentIds } }, select: { id: true, number: true } })
    : [];
  const paymentNumber = new Map(payments.map((p) => [p.id, p.number]));

  const sortHrefFor = (key: string) => {
    const next = toggleSort(ts, key);
    return tableHref("/app/finance/collections", params, { col_sort: next.sort, col_dir: next.dir }, "col");
  };

  type Row = (typeof rows)[number];
  const columns: Array<Column<Row>> = [
    {
      key: "created",
      header: "Started",
      sortKey: "created",
      cell: (r) => (
        <CellStack
          primary={<span className="text-sm">{r.createdAt.toLocaleString("en-KE", { dateStyle: "medium", timeStyle: "short" })}</span>}
          secondary={<code className="text-[11px]">{r.id}</code>}
        />
      ),
    },
    {
      key: "customer",
      header: "Customer",
      cell: (r) => (
        <CellStack
          primary={<span className="font-medium">{r.customer.name}</span>}
          secondary={`${r.customer.code} · ${r.payerPhone ?? r.payerEmail ?? "—"}`}
        />
      ),
    },
    {
      key: "provider",
      header: "Provider",
      hideBelow: "sm",
      sortKey: "provider",
      cell: (r) => <span className="badge bg-surface-sunken">{PROVIDER_LABEL[r.provider] ?? r.provider}</span>,
    },
    {
      key: "amount",
      header: "Amount",
      align: "right",
      numeric: true,
      sortKey: "amount",
      cell: (r) => <span className="font-medium"><Money cents={r.amountCents} /></span>,
    },
    {
      key: "status",
      header: "Status",
      sortKey: "status",
      cell: (r) => (
        <CellStack
          primary={<StatusBadge status={r.status} />}
          secondary={
            r.status === "REVERSED"
              ? "Booked, then reversed by the provider — review the ledger"
              : r.failureReason ?? (r.status === "PROCESSING" ? "Waiting on the customer" : undefined)
          }
        />
      ),
    },
    {
      key: "receipt",
      header: "Receipt",
      hideBelow: "md",
      cell: (r) => (
        <CellStack
          primary={<span className="text-sm">{r.receiptRef ?? (r.paymentId ? paymentNumber.get(r.paymentId) ?? "—" : "—")}</span>}
          secondary={r.paymentId ? `Payment ${paymentNumber.get(r.paymentId) ?? r.paymentId}` : r.providerRef?.startsWith("lookup:") ? "Awaiting the provider's reference" : r.providerRef ?? undefined}
        />
      ),
    },
    {
      key: "actions",
      header: "",
      align: "right",
      cell: (r) => <RecheckButton intentId={r.id} terminal={TERMINAL.has(r.status)} />,
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Collections"
        breadcrumb={{ href: "/app/finance", label: "Finance" }}
        description="Every M-Pesa, card and Buni collection requested from the console or the field app, and what the provider said about it."
      />

      <StatGrid>
        <StatCard label="Waiting on customers" value={String(open)} hint="Started, not yet confirmed or failed" />
        <StatCard label="Settled in the last 24h" value={String(settledToday._count)} hint={`KES ${((settledToday._sum.amountCents ?? 0) / 100).toLocaleString("en-KE")}`} />
        <StatCard label="Reversed" value={String(reversed)} hint="Booked, then reversed by the provider" />
      </StatGrid>

      {reversed > 0 && !status ? (
        <Callout tone="warning" title="Reversed collections need a decision">
          {reversed === 1 ? "One collection was" : `${reversed} collections were`} booked as paid and later reversed by the provider. The ledger has not been
          changed automatically — raise a credit note or reverse the payment once you have checked the provider&apos;s statement.
        </Callout>
      ) : null}

      <FilterBar action="/app/finance/collections" preserve={preserved(params, ["col_q", "col_status", "col_provider", "col_page"])}>
        <FilterSearch name="col_q" value={params.col_q} placeholder="Search customer, receipt, phone, reference…" />
        <FilterSelect
          name="col_status"
          value={status}
          allLabel="All statuses"
          options={STATUSES.map((s) => ({ value: s, label: s.charAt(0) + s.slice(1).toLowerCase() }))}
        />
        <FilterSelect
          name="col_provider"
          value={provider}
          allLabel="All providers"
          options={Object.entries(PROVIDER_LABEL).map(([value, label]) => ({ value, label }))}
        />
      </FilterBar>

      <DataTable
        columns={columns}
        rows={rows}
        getRowKey={(r) => r.id}
        sort={{ key: ts.sort, dir: ts.dir }}
        sortHrefFor={sortHrefFor}
        pagination={{
          page: ts.page,
          pages: Math.max(1, Math.ceil(total / ts.limit)),
          total,
          limit: ts.limit,
          hrefFor: (page) => tableHref("/app/finance/collections", params, { col_page: page }, "col"),
        }}
        empty={{
          title: "No collections yet",
          description: "Gateway payments requested from the field app or the console will appear here as soon as they are started.",
        }}
      />
    </div>
  );
}
