import Link from "next/link";

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
  type Tone,
} from "@/components/ui";
import { db } from "@/lib/db";
import { can } from "@/lib/rbac";
import { requireTenant } from "@/lib/session";
import { listQuotations } from "@/server/quotations";

import { QuotationDialog } from "../quotation-dialog";
import { ConvertQuotationButton, QuotationStatusButton } from "./quotation-actions";

export const dynamic = "force-dynamic";

const STATUS_TONE: Record<string, Tone> = {
  DRAFT: "neutral", SENT: "info", ACCEPTED: "success",
  REJECTED: "danger", EXPIRED: "warning", CONVERTED: "accent",
};

type QuoteRow = Awaited<ReturnType<typeof listQuotations>>[number];

export default async function QuotationsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const { companyId, principal } = await requireTenant();
  if (!principal.enabledModules.has("SALES_POS")) return <ModuleLocked module="SALES_POS" />;

  const params = await searchParams;
  const quotations = await listQuotations(principal, { status: params.status, q: params.q });
  const canWrite = can(principal, "quotation:write");

  const [customers, products] = canWrite
    ? await Promise.all([
        db.customer.findMany({ where: { companyId, status: "ACTIVE" }, select: { id: true, name: true }, orderBy: { name: "asc" }, take: 500 }),
        db.product.findMany({ where: { companyId, active: true }, select: { id: true, name: true, sellPriceCents: true, taxRateBp: true }, orderBy: { name: "asc" }, take: 1000 }),
      ])
    : [[], []];

  const columns: Array<Column<QuoteRow>> = [
    { key: "number", header: "Number", cell: (q) => <span className="font-medium">{q.number}</span> },
    { key: "customer", header: "Customer", cell: (q) => q.customer?.name ?? "—" },
    { key: "valid", header: "Valid until", hideBelow: "md", cell: (q) => q.validUntil ? q.validUntil.toLocaleDateString("en-KE", { day: "numeric", month: "short", year: "numeric" }) : "—" },
    { key: "total", header: "Total", align: "right", cell: (q) => <Money cents={q.totalCents} /> },
    { key: "status", header: "Status", cell: (q) => <Badge tone={STATUS_TONE[q.status] ?? "neutral"}>{q.status}</Badge> },
    {
      key: "actions",
      header: "",
      align: "right",
      cell: (q) =>
        canWrite ? (
          <div className="flex justify-end gap-2">
            {q.status === "DRAFT" ? <QuotationStatusButton id={q.id} to="SENT" label="Send" /> : null}
            {q.status === "SENT" ? <QuotationStatusButton id={q.id} to="ACCEPTED" label="Accept" /> : null}
            {["DRAFT", "SENT", "ACCEPTED"].includes(q.status) ? <ConvertQuotationButton id={q.id} number={q.number} /> : null}
            {q.status === "CONVERTED" ? <span className="text-xs text-content-muted">Converted</span> : null}
          </div>
        ) : null,
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Quotations"
        description="Priced proposals. Send one, then convert the accepted quote to an order or invoice."
        actions={canWrite ? <QuotationDialog customers={customers} products={products} /> : null}
      />
      <FilterBar action="/app/sales/quotations">
        <FilterSearch value={params.q} placeholder="Number or customer" />
        <FilterSelect
          name="status"
          value={params.status}
          allLabel="Any status"
          options={[
            { value: "DRAFT", label: "Draft" },
            { value: "SENT", label: "Sent" },
            { value: "ACCEPTED", label: "Accepted" },
            { value: "REJECTED", label: "Rejected" },
            { value: "EXPIRED", label: "Expired" },
            { value: "CONVERTED", label: "Converted" },
          ]}
        />
      </FilterBar>
      <DataTable
        columns={columns}
        rows={quotations}
        getRowKey={(q) => q.id}
        caption="Quotations"
        empty={{ title: "No quotations yet", description: "Raise one with the New quotation button." }}
      />
    </div>
  );
}
