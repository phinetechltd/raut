import { notFound } from "next/navigation";
import QRCode from "qrcode";

import {
  Badge,
  ButtonLink,
  Card,
  DataTable,
  FilterBar,
  FilterSearch,
  Money,
  SectionHeading,
  StatusBadge,
  type Column,
} from "@/components/ui";
import { db } from "@/lib/db";
import { can } from "@/lib/rbac";
import { requireTenant } from "@/lib/session";
import { preserved, tableHref, tableState, toggleSort } from "@/lib/table";

import { CreditNoteButton } from "./credit-note-button";
import { DeliveryNoteButton } from "./delivery-note-button";
import { PaymentDialog } from "../../../finance/payment-dialog";
import { TransmitButton } from "./transmit-button";

export const dynamic = "force-dynamic";

/**
 * The tax invoice.
 *
 * This page is the point of the eTIMS work. A control code sitting in a
 * database column satisfies nobody: KRA's requirement is that the buyer can see
 * the code and scan the QR on the document they were handed. Everything else in
 * the integration exists so that this page can print correctly.
 */

const ETIMS_TONE = {
  ACCEPTED: "success",
  QUEUED: "warning",
  SUBMITTED: "warning",
  REJECTED: "danger",
  NOT_APPLICABLE: "neutral",
} as const;

const ETIMS_LABEL = {
  ACCEPTED: "Filed with KRA",
  QUEUED: "Awaiting KRA",
  SUBMITTED: "Stuck at KRA - contact support",
  REJECTED: "Rejected by KRA",
  NOT_APPLICABLE: "Not filed",
} as const;

type EtimsKey = keyof typeof ETIMS_LABEL;

const asKey = (v: string | null | undefined): EtimsKey =>
  v && v in ETIMS_LABEL ? (v as EtimsKey) : "NOT_APPLICABLE";

const LINE_SORT = ["item", "qty", "unit", "vat", "total"] as const;
type LineSortKey = (typeof LINE_SORT)[number];

export default async function InvoicePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { companyId, principal } = await requireTenant();
  const { id } = await params;
  const sp = await searchParams;
  const path = `/app/sales/invoices/${id}`;

  const lineTs = tableState(sp, {
    prefix: "line",
    allowed: [...LINE_SORT],
    limit: 25,
  });

  const invoice = await db.invoice.findFirst({
    // Scoped by company: an id belonging to another tenant is simply not found.
    where: { id, companyId },
    include: {
      customer: true,
      lines: { include: { product: { select: { sku: true, name: true } } } },
      creditNotes: { orderBy: { issueDate: "desc" } },
      deliveryNotes: {
        where: { status: { not: "CANCELLED" } },
        select: { id: true, number: true, status: true },
        orderBy: { issueDate: "desc" },
      },
    },
  });
  if (!invoice) notFound();

  const company = await db.company.findUniqueOrThrow({
    where: { id: companyId },
    select: { name: true, taxPin: true, address: true, phone: true, email: true },
  });

  // Rendered server-side as inline SVG rather than an <img> pointing at a
  // generator: the document has to print identically with no network, and a QR
  // that fails to load is an invoice that fails an inspection.
  const qrSvg = invoice.etimsQrUrl
    ? await QRCode.toString(invoice.etimsQrUrl, {
        type: "svg",
        margin: 1,
        width: 132,
        errorCorrectionLevel: "M",
      })
    : null;

  const status = asKey(invoice.etimsStatus);
  const credited = invoice.creditNotes
    .filter((c) => c.status !== "CANCELLED")
    .reduce((n, c) => n + c.totalCents, 0);
  const outstandingCents = invoice.totalCents - invoice.paidCents - credited;

  // Lines are already loaded with the invoice (an invoice has a handful, not
  // thousands), so search, sort and paging happen here rather than in SQL.
  type Line = (typeof invoice.lines)[number];
  const lineQuery = (sp.line_q ?? "").trim().toLowerCase();
  const matchedLines = lineQuery
    ? invoice.lines.filter(
        (l) =>
          l.product.name.toLowerCase().includes(lineQuery) ||
          l.product.sku.toLowerCase().includes(lineQuery) ||
          l.description.toLowerCase().includes(lineQuery),
      )
    : invoice.lines;
  const lineValue = (l: Line, key: LineSortKey): string | number => {
    switch (key) {
      case "item":
        return `${l.product.sku} ${l.description}`.toLowerCase();
      case "qty":
        return l.quantity;
      case "unit":
        return l.unitPriceCents;
      case "vat":
        return l.taxRateBp;
      case "total":
        return l.lineTotalCents;
    }
  };
  const sortedLines = lineTs.sort
    ? [...matchedLines].sort((a, b) => {
        const av = lineValue(a, lineTs.sort as LineSortKey);
        const bv = lineValue(b, lineTs.sort as LineSortKey);
        const cmp = typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv));
        return lineTs.dir === "asc" ? cmp : -cmp;
      })
    : matchedLines;
  const linePages = Math.max(1, Math.ceil(sortedLines.length / lineTs.limit));
  const linePage = Math.min(lineTs.page, linePages);
  const pagedLines = sortedLines.slice((linePage - 1) * lineTs.limit, linePage * lineTs.limit);

  const lineSortHrefFor = (key: string) => {
    const next = toggleSort(lineTs, key);
    return tableHref(path, sp, { line_sort: next.sort, line_dir: next.dir }, "line");
  };

  const lineColumns: Array<Column<Line>> = [
    {
      key: "item",
      header: "Item",
      sortKey: "item",
      cell: (l) => (
        <>
          <span className="tabular text-xs text-content-muted">{l.product.sku}</span> {l.description}
        </>
      ),
    },
    { key: "qty", header: "Qty", align: "right", numeric: true, sortKey: "qty", cell: (l) => l.quantity },
    {
      key: "unit",
      header: "Unit",
      align: "right",
      numeric: true,
      sortKey: "unit",
      cell: (l) => <Money cents={l.unitPriceCents} />,
    },
    {
      key: "vat",
      header: "VAT",
      align: "right",
      numeric: true,
      sortKey: "vat",
      cell: (l) => `${l.taxRateBp / 100}%`,
    },
    {
      key: "total",
      header: "Total",
      align: "right",
      numeric: true,
      sortKey: "total",
      cell: (l) => (
        <span className="font-medium">
          <Money cents={l.lineTotalCents} />
        </span>
      ),
    },
  ];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3 print:hidden">
        <div>
          <ButtonLink href="/app/sales" variant="ghost" size="sm">
            Back to sales
          </ButtonLink>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">
            Invoice {invoice.number}
          </h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={ETIMS_TONE[status]}>{ETIMS_LABEL[status]}</Badge>
          {/* Printing happens on /print, outside the Shell, so the paper carries
              no sidebar and the same layout as every other document. */}
          <ButtonLink href={`/print/invoice/${invoice.id}`} target="_blank" variant="secondary" size="sm">
            Print
          </ButtonLink>
          {invoice.status === "PAID" && (
            <ButtonLink
              href={`/print/invoice/${invoice.id}?format=thermal`}
              target="_blank"
              variant="ghost"
              size="sm"
              title="80 mm till-roll receipt"
            >
              Thermal receipt
            </ButtonLink>
          )}
          {can(principal, "delivery:write") && invoice.status !== "DRAFT" && invoice.status !== "CANCELLED" && (
            <DeliveryNoteButton invoiceId={invoice.id} />
          )}
          {can(principal, "payment:write") && outstandingCents > 0 && (
            <PaymentDialog
              customers={[{ id: invoice.customer.id, name: invoice.customer.name, balanceCents: invoice.customer.balanceCents }]}
              presetCustomerId={invoice.customer.id}
              buttonVariant="primary"
              buttonLabel="Record payment"
            />
          )}
          {can(principal, "etims:submit") && status !== "ACCEPTED" && (
            <TransmitButton invoiceId={invoice.id} />
          )}
          {can(principal, "creditnote:write") && invoice.status !== "DRAFT" && (
            <CreditNoteButton
              invoiceId={invoice.id}
              lines={invoice.lines.map((l) => ({
                id: l.id,
                description: l.description,
                quantity: l.quantity,
              }))}
            />
          )}
        </div>
      </div>

      {invoice.etimsError && status === "REJECTED" && (
        <Card className="border-danger-border bg-danger-bg print:hidden">
          <p className="text-sm font-medium text-danger">KRA rejected this invoice</p>
          <p className="mt-1 text-sm text-content-secondary">{invoice.etimsError}</p>
        </Card>
      )}

      {/* The printable document itself. */}
      <Card className="print:border-0 print:shadow-none">
        <div className="flex flex-wrap items-start justify-between gap-6">
          <div>
            <p className="text-lg font-semibold">{company.name}</p>
            {company.taxPin && (
              <p className="tabular text-sm text-content-secondary">PIN {company.taxPin}</p>
            )}
            {company.address && <p className="text-sm text-content-muted">{company.address}</p>}
            {(company.phone || company.email) && (
              <p className="text-sm text-content-muted">
                {[company.phone, company.email].filter(Boolean).join(" · ")}
              </p>
            )}
          </div>

          <div className="text-right">
            <p className="text-xs font-medium uppercase tracking-wide text-content-muted">
              {status === "ACCEPTED" ? "Tax invoice" : "Invoice"}
            </p>
            <p className="tabular text-lg font-semibold">{invoice.number}</p>
            <p className="text-sm text-content-secondary">
              {invoice.issueDate.toISOString().slice(0, 10)}
            </p>
          </div>
        </div>

        <div className="mt-6 grid gap-6 sm:grid-cols-2">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-content-muted">
              Billed to
            </p>
            <p className="font-medium">{invoice.customer.name}</p>
            {invoice.customer.taxPin ? (
              <p className="tabular text-sm text-content-secondary">
                PIN {invoice.customer.taxPin}
              </p>
            ) : (
              <p className="text-sm text-content-muted print:hidden">
                No KRA PIN on file, so this buyer cannot claim the input VAT.
              </p>
            )}
            {invoice.customer.town && (
              <p className="text-sm text-content-muted">{invoice.customer.town}</p>
            )}
          </div>

          {/* The block that makes it a tax invoice rather than a bill. */}
          {status === "ACCEPTED" && (
            <div className="flex items-start gap-4 sm:justify-end">
              {qrSvg && (
                <div
                  className="shrink-0 [&>svg]:h-[120px] [&>svg]:w-[120px]"
                  aria-label="KRA verification QR code"
                  dangerouslySetInnerHTML={{ __html: qrSvg }}
                />
              )}
              <dl className="text-sm">
                <dt className="text-xs uppercase tracking-wide text-content-muted">
                  Control code
                </dt>
                <dd className="tabular font-semibold">{invoice.etimsControlCode}</dd>
                {invoice.etimsInvoiceNumber && (
                  <>
                    <dt className="mt-2 text-xs uppercase tracking-wide text-content-muted">
                      KRA invoice no.
                    </dt>
                    <dd className="tabular">{invoice.etimsInvoiceNumber}</dd>
                  </>
                )}
                {invoice.etimsSerialNumber && (
                  <>
                    <dt className="mt-2 text-xs uppercase tracking-wide text-content-muted">
                      Serial
                    </dt>
                    <dd className="tabular text-xs">{invoice.etimsSerialNumber}</dd>
                  </>
                )}
              </dl>
            </div>
          )}
        </div>

        <div className="mt-6">
          {invoice.lines.length > 5 || sp.line_q ? (
            <FilterBar action={path} preserve={preserved(sp, ["line_q", "line_page"])}>
              <FilterSearch name="line_q" value={sp.line_q} placeholder="Search product, SKU…" />
            </FilterBar>
          ) : null}
          <DataTable
            columns={lineColumns}
            rows={pagedLines}
            getRowKey={(l) => l.id}
            caption="Invoice lines"
            dense
            sort={{ key: lineTs.sort, dir: lineTs.dir }}
            sortHrefFor={lineSortHrefFor}
            pagination={{
              page: linePage,
              pages: linePages,
              total: sortedLines.length,
              limit: lineTs.limit,
              hrefFor: (p) => tableHref(path, sp, { line_page: p }),
            }}
            empty={{ title: lineQuery ? "No lines match this search" : "No lines on this invoice" }}
          />
        </div>

        <div className="mt-4 flex justify-end">
          <dl className="w-full max-w-xs space-y-1 text-sm">
            <div className="flex justify-between">
              <dt className="text-content-secondary">Subtotal</dt>
              <dd className="tabular">
                <Money cents={invoice.subtotalCents} />
              </dd>
            </div>
            {invoice.discountCents > 0 && (
              <div className="flex justify-between">
                <dt className="text-content-secondary">Discount</dt>
                <dd className="tabular">
                  <Money cents={-invoice.discountCents} />
                </dd>
              </div>
            )}
            <div className="flex justify-between">
              <dt className="text-content-secondary">VAT</dt>
              <dd className="tabular">
                <Money cents={invoice.taxCents} />
              </dd>
            </div>
            <div className="flex justify-between border-t border-border pt-1 font-semibold">
              <dt>Total</dt>
              <dd className="tabular">
                <Money cents={invoice.totalCents} />
              </dd>
            </div>
            {credited > 0 && (
              <div className="flex justify-between text-content-secondary">
                <dt>Credited</dt>
                <dd className="tabular">
                  <Money cents={-credited} />
                </dd>
              </div>
            )}
            <div className="flex justify-between">
              <dt className="text-content-secondary">Paid</dt>
              <dd className="tabular">
                <Money cents={invoice.paidCents} />
              </dd>
            </div>
            <div className="flex justify-between border-t border-border pt-1 font-semibold">
              <dt>Balance</dt>
              <dd className="tabular">
                <Money cents={invoice.totalCents - invoice.paidCents - credited} />
              </dd>
            </div>
          </dl>
        </div>

        {status === "ACCEPTED" && (
          <p className="mt-6 border-t border-border pt-3 text-xs text-content-muted">
            This is a valid tax invoice. Verify it at{" "}
            <span className="break-all">{invoice.etimsQrUrl}</span>
          </p>
        )}
      </Card>

      {invoice.creditNotes.length > 0 && (
        <Card className="print:hidden">
          <SectionHeading title="Credit notes" />
          {invoice.creditNotes.map((c) => (
            <div
              key={c.id}
              className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border py-2 last:border-0"
            >
              <span className="tabular font-medium">{c.number}</span>
              <span className="min-w-0 flex-1 truncate px-2 text-sm text-content-secondary">
                {c.reason}
              </span>
              <Badge tone={ETIMS_TONE[asKey(c.etimsStatus)]}>
                {ETIMS_LABEL[asKey(c.etimsStatus)]}
              </Badge>
              <span className="tabular font-medium">
                <Money cents={c.totalCents} />
              </span>
              <ButtonLink href={`/print/credit-note/${c.id}`} target="_blank" variant="ghost" size="sm">
                Print
              </ButtonLink>
            </div>
          ))}
        </Card>
      )}

      {invoice.deliveryNotes.length > 0 && (
        <Card className="print:hidden">
          <SectionHeading
            title="Delivery notes"
            actions={
              can(principal, "delivery:read") ? (
                <ButtonLink href={`/app/sales/delivery-notes?dn_q=${encodeURIComponent(invoice.number)}`} variant="ghost" size="sm">
                  Manage
                </ButtonLink>
              ) : null
            }
          />
          {invoice.deliveryNotes.map((d) => (
            <div
              key={d.id}
              className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border py-2 last:border-0"
            >
              <span className="tabular font-medium">{d.number}</span>
              <span className="flex-1" />
              <StatusBadge status={d.status} />
              <ButtonLink href={`/print/delivery-note/${d.id}`} target="_blank" variant="ghost" size="sm">
                Print
              </ButtonLink>
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}
