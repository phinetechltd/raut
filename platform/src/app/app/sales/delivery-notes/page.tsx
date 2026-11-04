import type { Prisma } from "@prisma/client";
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
  PageHeader,
  StatusBadge,
  type Column,
} from "@/components/ui";
import { db } from "@/lib/db";
import { can } from "@/lib/rbac";
import { requireTenant } from "@/lib/session";
import { preserved, tableHref, tableState, toggleSort } from "@/lib/table";
import {
  DELIVERY_NOTE_INCLUDE,
  DELIVERY_STATUSES,
  deliveryScope,
  remainingBySourceLine,
} from "@/server/delivery";

import {
  DeliveryNoteActions,
  NewDeliveryNoteDialog,
  type SourceOption,
} from "./delivery-note-dialog";

export const dynamic = "force-dynamic";

type Dir = "asc" | "desc";
const SORT: Record<string, (dir: Dir) => Prisma.DeliveryNoteOrderByWithRelationInput> = {
  number: (dir) => ({ number: dir }),
  issued: (dir) => ({ issueDate: dir }),
  delivered: (dir) => ({ deliveredAt: dir }),
  status: (dir) => ({ status: dir }),
  customer: (dir) => ({ customer: { name: dir } }),
};

const PATH = "/app/sales/delivery-notes";

/**
 * Module 02 · Delivery notes.
 *
 * The paper that travels with the goods and comes back signed. Notes are
 * raised here or from an invoice, printed on /print, and walked through
 * issued → delivered → returned from the row. Stock never moves from this
 * page: it moved with the invoice.
 */
export default async function DeliveryNotesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { companyId, principal } = await requireTenant();
  if (!principal.enabledModules.has("SALES_POS")) return <ModuleLocked module="SALES_POS" />;
  if (!can(principal, "delivery:read")) notFound();

  const params = await searchParams;
  const canWrite = can(principal, "delivery:write");

  const ts = tableState(params, {
    prefix: "dn",
    allowed: Object.keys(SORT),
    defaultSort: "issued",
    defaultDir: "desc",
    limit: 15,
  });

  const q = params.dn_q?.trim();
  const status = params.dn_status && (DELIVERY_STATUSES as readonly string[]).includes(params.dn_status) ? params.dn_status : undefined;

  const where = {
    ...deliveryScope(principal),
    ...(status ? { status } : {}),
    ...(q
      ? {
          AND: [
            {
              OR: [
                { number: { contains: q } },
                { customer: { name: { contains: q } } },
                { invoice: { number: { contains: q } } },
                { order: { number: { contains: q } } },
              ],
            },
          ],
        }
      : {}),
  };

  const orderBy = (SORT[ts.sort ?? "issued"] ?? SORT.issued)(ts.dir);

  const [notes, total, byStatus, vehicles, reps, invoices, orders] = await Promise.all([
    db.deliveryNote.findMany({
      where,
      include: DELIVERY_NOTE_INCLUDE,
      orderBy,
      take: ts.limit,
      skip: (ts.page - 1) * ts.limit,
    }),
    db.deliveryNote.count({ where }),
    db.deliveryNote.groupBy({ by: ["status"], where: deliveryScope(principal), _count: true }),
    canWrite
      ? db.vehicle.findMany({
          where: { companyId, active: true },
          select: { id: true, plate: true, make: true, model: true },
          orderBy: { plate: "asc" },
        })
      : [],
    canWrite
      ? db.user.findMany({
          where: { companyId, status: "ACTIVE", role: { in: ["FIELD_REP", "STOREKEEPER", "SALES_MANAGER", "BRANCH_MANAGER"] } },
          select: { id: true, name: true },
          orderBy: { name: "asc" },
          take: 100,
        })
      : [],
    // Candidates for a new note: the recent issued invoices and the confirmed
    // orders that have not been invoiced. Narrowed below to those with
    // something still to deliver.
    canWrite
      ? db.invoice.findMany({
          where: {
            companyId,
            status: { in: ["ISSUED", "PARTIALLY_PAID", "PAID", "OVERDUE"] },
            ...(principal.role === "FIELD_REP" ? { createdById: principal.userId } : {}),
          },
          select: {
            id: true,
            number: true,
            customer: { select: { name: true } },
            lines: { select: { id: true, description: true, quantity: true } },
          },
          orderBy: { issueDate: "desc" },
          take: 60,
        })
      : [],
    canWrite
      ? db.salesOrder.findMany({
          where: {
            companyId,
            status: { in: ["CONFIRMED", "PARTIALLY_FULFILLED"] },
            ...(principal.role === "FIELD_REP" ? { createdById: principal.userId } : {}),
          },
          select: {
            id: true,
            number: true,
            customer: { select: { name: true } },
            lines: { select: { id: true, description: true, quantity: true } },
          },
          orderBy: { orderDate: "desc" },
          take: 60,
        })
      : [],
  ]);

  const sources: SourceOption[] = [];
  if (canWrite) {
    const invLines = invoices.flatMap((i) => i.lines);
    const ordLines = orders.flatMap((o) => o.lines);
    const [invRemaining, ordRemaining] = await Promise.all([
      remainingBySourceLine(db, companyId, {
        invoiceLineIds: invLines.map((l) => l.id),
        ordered: new Map(invLines.map((l) => [l.id, l.quantity])),
      }),
      remainingBySourceLine(db, companyId, {
        orderLineIds: ordLines.map((l) => l.id),
        ordered: new Map(ordLines.map((l) => [l.id, l.quantity])),
      }),
    ]);
    for (const i of invoices) {
      const lines = i.lines.map((l) => ({
        id: l.id,
        description: l.description,
        ordered: l.quantity,
        remaining: invRemaining.get(l.id)?.remaining ?? 0,
      }));
      if (lines.some((l) => l.remaining > 0)) {
        sources.push({ id: i.id, kind: "invoice", number: i.number, customerName: i.customer.name, lines });
      }
    }
    for (const o of orders) {
      const lines = o.lines.map((l) => ({
        id: l.id,
        description: l.description,
        ordered: l.quantity,
        remaining: ordRemaining.get(l.id)?.remaining ?? 0,
      }));
      if (lines.some((l) => l.remaining > 0)) {
        sources.push({ id: o.id, kind: "order", number: o.number, customerName: o.customer.name, lines });
      }
    }
  }

  const sortHrefFor = (key: string) => {
    const next = toggleSort(ts, key);
    return tableHref(PATH, params, { dn_sort: next.sort, dn_dir: next.dir }, "dn");
  };

  type Row = (typeof notes)[number];
  const columns: Array<Column<Row>> = [
    {
      key: "number",
      header: "Note",
      sortKey: "number",
      cell: (n) => (
        <CellStack
          primary={
            <Link href={`/print/delivery-note/${n.id}`} target="_blank" className="font-medium underline underline-offset-2 hover:text-accent">
              {n.number}
            </Link>
          }
          secondary={n.invoice ? `Invoice ${n.invoice.number}` : n.order ? `Order ${n.order.number}` : ""}
        />
      ),
    },
    {
      key: "customer",
      header: "Customer",
      sortKey: "customer",
      cell: (n) => <CellStack primary={n.customer.name} secondary={n.deliveryAddress ?? n.customer.town ?? ""} />,
    },
    {
      key: "issued",
      header: "Issued",
      sortKey: "issued",
      cell: (n) => <span className="text-xs text-content-muted">{n.issueDate.toLocaleDateString("en-KE")}</span>,
    },
    {
      key: "qty",
      header: "Delivered",
      align: "right",
      numeric: true,
      hideBelow: "sm",
      cell: (n) => {
        const delivered = n.lines.reduce((s, l) => s + l.deliveredQty - l.returnedQty, 0);
        const ordered = n.lines.reduce((s, l) => s + l.orderedQty, 0);
        return (
          <span className="text-xs">
            {delivered}
            <span className="text-content-muted">/{ordered}</span>
          </span>
        );
      },
    },
    {
      key: "delivered",
      header: "Signed for",
      hideBelow: "md",
      sortKey: "delivered",
      cell: (n) =>
        n.deliveredAt ? (
          <CellStack primary={n.receivedByName ?? "—"} secondary={n.deliveredAt.toLocaleDateString("en-KE")} />
        ) : (
          <span className="text-xs text-content-muted">{n.deliveredBy?.name ?? "—"}</span>
        ),
    },
    {
      key: "status",
      header: "Status",
      align: "right",
      sortKey: "status",
      cell: (n) => <StatusBadge status={n.status} />,
    },
    {
      key: "actions",
      header: "Actions",
      align: "right",
      srOnlyHeader: true,
      cell: (n) => (
        <DeliveryNoteActions
          canWrite={canWrite}
          note={{
            id: n.id,
            number: n.number,
            status: n.status,
            lines: n.lines.map((l) => ({
              id: l.id,
              description: l.description,
              deliveredQty: l.deliveredQty,
              returnedQty: l.returnedQty,
            })),
          }}
        />
      ),
    },
  ];

  const count = (s: string) => byStatus.find((b) => b.status === s)?._count ?? 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Delivery notes"
        description="What left, who took it, and who signed for it. A delivery note is a dispatch record, not a tax invoice; stock moves with the invoice."
        breadcrumb={{ href: "/app/sales", label: "Sales & POS" }}
        actions={
          <>
            <ButtonLink href="/app/sales" variant="ghost">
              Invoices
            </ButtonLink>
            {canWrite ? (
              <NewDeliveryNoteDialog
                sources={sources}
                vehicles={vehicles.map((v) => ({ id: v.id, name: [v.plate, v.make, v.model].filter(Boolean).join(" ") }))}
                reps={reps}
              />
            ) : null}
          </>
        }
      />

      <p className="text-sm text-content-muted">
        {count("ISSUED")} out for delivery · {count("DELIVERED")} delivered · {count("RETURNED")} with returns ·{" "}
        {count("DRAFT")} draft
      </p>

      <FilterBar action={PATH} preserve={preserved(params, ["dn_q", "dn_status", "dn_page"])}>
        <FilterSearch name="dn_q" value={params.dn_q} placeholder="Search note, invoice, order, customer…" />
        <FilterSelect
          name="dn_status"
          value={params.dn_status}
          allLabel="Any status"
          options={DELIVERY_STATUSES.map((s) => ({ value: s, label: s.charAt(0) + s.slice(1).toLowerCase() }))}
        />
      </FilterBar>

      <DataTable
        columns={columns}
        rows={notes}
        getRowKey={(n) => n.id}
        caption="Delivery notes"
        sort={{ key: ts.sort, dir: ts.dir }}
        sortHrefFor={sortHrefFor}
        pagination={{
          page: ts.page,
          pages: Math.max(1, Math.ceil(total / ts.limit)),
          total,
          limit: ts.limit,
          hrefFor: (p) => tableHref(PATH, params, { dn_page: p }),
        }}
        empty={{
          title: q || status ? "No delivery notes match this filter" : "No delivery notes yet",
          description: "Raise one from an invoice's page, or here against an invoice or an order.",
        }}
      />
    </div>
  );
}
