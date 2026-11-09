import Link from "next/link";
import { notFound } from "next/navigation";

import {
  Badge,
  ButtonLink,
  DataTable,
  EmptyState,
  FilterBar,
  FilterSelect,
  ModuleLocked,
  Money,
  SectionHeading,
  StatCard,
  StatusBadge,
  TileMap,
  type Column,
} from "@/components/ui";
import { db } from "@/lib/db";
import { toClientConfig } from "@/lib/maps";
import { outstandingCents } from "@/lib/money";
import { creditedByInvoice } from "@/server/sales";
import { ensureStages, listDeals, listTasks } from "@/server/crm";
import { can } from "@/lib/rbac";
import { requireTenant } from "@/lib/session";
import { preserved, tableHref, tableState, toggleSort } from "@/lib/table";
import { mapConfigFor } from "@/server/maps";

import { CustomerDeleteButton, CustomerDialog } from "../customer-dialog";
import { DealStageSelect, NewDealDialog, NewTaskDialog, TaskStatusButton, type Option, type StageOption } from "../../crm/crm-client";

export const dynamic = "force-dynamic";

const INV_SORT: Record<string, string> = {
  number: "number",
  issued: "issueDate",
  total: "totalCents",
  paid: "paidCents",
  status: "status",
};
const VIS_SORT: Record<string, string> = {
  date: "scheduledAt",
  status: "status",
  verified: "geofenceVerified",
  distance: "distanceFromCustomerM",
};


/** Module 01 · CRM — the 360° customer profile with activity log. */
export default async function CustomerDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { companyId, principal } = await requireTenant();
  if (!principal.enabledModules.has("CRM")) return <ModuleLocked module="CRM" />;

  const { id } = await params;
  const sp = await searchParams;
  const path = `/app/customers/${id}`;

  const invTs = tableState(sp, {
    prefix: "inv",
    allowed: Object.keys(INV_SORT),
    defaultSort: "issued",
    defaultDir: "desc",
    limit: 10,
  });
  const visTs = tableState(sp, {
    prefix: "vis",
    allowed: Object.keys(VIS_SORT),
    defaultSort: "date",
    defaultDir: "desc",
    limit: 10,
  });

  const customer = await db.customer.findFirst({
    where: {
      id,
      companyId,
      ...(principal.role === "FIELD_REP" ? { assignedRepId: principal.userId } : {}),
    },
    include: {
      territory: true,
      assignedRep: { select: { name: true, phone: true } },
      contacts: true,
      activities: {
        orderBy: { createdAt: "desc" },
        take: 30,
        include: { user: { select: { name: true } } },
      },
    },
  });

  if (!customer) notFound();

  const invWhere = {
    customerId: customer.id,
    companyId,
    ...(sp.inv_status ? { status: sp.inv_status } : {}),
  };
  const visWhere = {
    customerId: customer.id,
    companyId,
    ...(sp.vis_status ? { status: sp.vis_status } : {}),
  };

  const [maps, invoices, invoiceCount, visits, visitCount, visitStats, lifetime, territories, reps] =
    await Promise.all([
      mapConfigFor(companyId),
      db.invoice.findMany({
        where: invWhere,
        orderBy: { [INV_SORT[invTs.sort ?? "issued"]]: invTs.dir } as Record<string, "asc" | "desc">,
        take: invTs.limit,
        skip: (invTs.page - 1) * invTs.limit,
      }),
      db.invoice.count({ where: invWhere }),
      db.visit.findMany({
        where: visWhere,
        include: { rep: { select: { name: true } } },
        orderBy: { [VIS_SORT[visTs.sort ?? "date"]]: visTs.dir } as Record<string, "asc" | "desc">,
        take: visTs.limit,
        skip: (visTs.page - 1) * visTs.limit,
      }),
      db.visit.count({ where: visWhere }),
      // The stat card and the map read recent visits regardless of how the
      // table below is sorted or paged.
      db.visit.findMany({
        where: { customerId: customer.id, companyId },
        select: { id: true, scheduledAt: true, geofenceVerified: true, checkInLat: true, checkInLng: true },
        orderBy: { scheduledAt: "desc" },
        take: 15,
      }),
      db.invoice.aggregate({
        where: { customerId: customer.id, status: { notIn: ["DRAFT", "CANCELLED"] } },
        _sum: { totalCents: true },
        _count: true,
      }),
      db.territory.findMany({
        where: { companyId },
        select: { id: true, name: true },
        orderBy: { name: "asc" },
      }),
      db.user.findMany({
        where: { companyId, status: "ACTIVE" },
        select: { id: true, name: true },
        orderBy: { name: "asc" },
        take: 100,
      }),
    ]);

  // What has come back as credit notes, so "Due" agrees with the API and the
  // payment screen rather than over-stating a part-credited invoice.
  const credited = await creditedByInvoice(db, invoices.map((i) => i.id));
  const dueFor = (inv: { id: string; totalCents: number; paidCents: number }) =>
    outstandingCents({ ...inv, creditedCents: credited.get(inv.id) ?? 0 });

  const verifiedVisits = visitStats.filter((v) => v.geofenceVerified).length;
  const canWrite = can(principal, "customer:write");
  const canDelete = can(principal, "customer:delete");

  const invSortHrefFor = (key: string) => {
    const next = toggleSort(invTs, key);
    return tableHref(path, sp, { inv_sort: next.sort, inv_dir: next.dir }, "inv");
  };
  const visSortHrefFor = (key: string) => {
    const next = toggleSort(visTs, key);
    return tableHref(path, sp, { vis_sort: next.sort, vis_dir: next.dir }, "vis");
  };

  // CRM panel: this customer's deals and open tasks, plus the options the
  // quick-add dialogs need.
  const [custDeals, custTasks, stageRows, companyUsers] = await Promise.all([
    listDeals(principal, { customerId: id }),
    listTasks(principal, { customerId: id, status: "OPEN" }),
    ensureStages(companyId),
    db.user.findMany({ where: { companyId, status: { not: "SUSPENDED" } }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);
  const stageOpts: StageOption[] = stageRows.map((s) => ({ id: s.id, name: s.name, kind: s.kind }));
  const userOpts: Option[] = companyUsers;
  const thisCustomerOpt: Option[] = [{ id: customer.id, name: customer.name }];

  type InvRow = (typeof invoices)[number];
  const invoiceColumns: Array<Column<InvRow>> = [
    {
      key: "number",
      header: "Number",
      sortKey: "number",
      cell: (inv) => (
        <Link href={`/app/sales/invoices/${inv.id}`} className="font-medium hover:text-accent">
          {inv.number}
        </Link>
      ),
    },
    {
      key: "issued",
      header: "Issued",
      sortKey: "issued",
      cell: (inv) => (
        <span className="text-content-muted text-xs">{inv.issueDate.toLocaleDateString("en-KE")}</span>
      ),
    },
    {
      key: "total",
      header: "Total",
      align: "right",
      numeric: true,
      sortKey: "total",
      cell: (inv) => <Money cents={inv.totalCents} />,
    },
    {
      key: "due",
      header: "Due",
      align: "right",
      numeric: true,
      sortKey: "paid",
      cell: (inv) => (
        <span className={dueFor(inv) > 0 ? "font-medium" : "text-content-muted"}>
          <Money cents={dueFor(inv)} />
        </span>
      ),
    },
    {
      key: "status",
      header: "Status",
      align: "right",
      sortKey: "status",
      cell: (inv) => <StatusBadge status={inv.status} />,
    },
  ];

  type VisRow = (typeof visits)[number];
  const visitColumns: Array<Column<VisRow>> = [
    {
      key: "date",
      header: "Date",
      sortKey: "date",
      cell: (v) => (
        <span className="text-content-muted text-xs">{v.scheduledAt.toLocaleDateString("en-KE")}</span>
      ),
    },
    { key: "rep", header: "Rep", cell: (v) => <span className="text-xs">{v.rep.name}</span> },
    {
      key: "status",
      header: "Status",
      sortKey: "status",
      cell: (v) => <StatusBadge status={v.status} />,
    },
    {
      key: "verified",
      header: "Verified",
      sortKey: "verified",
      cell: (v) =>
        v.geofenceVerified ? (
          <span className="badge bg-success-bg text-success border-success-border">yes</span>
        ) : v.checkInAt ? (
          <span className="badge bg-danger-bg text-danger border-danger-border">no</span>
        ) : (
          <span className="text-content-muted text-xs">—</span>
        ),
    },
    {
      key: "distance",
      header: "Distance",
      align: "right",
      numeric: true,
      sortKey: "distance",
      cell: (v) => (
        <span className="text-content-muted text-xs">
          {v.distanceFromCustomerM != null ? `${v.distanceFromCustomerM}m` : "—"}
        </span>
      ),
    },
  ];

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link href="/app/customers" className="text-content-muted text-xs hover:underline">
            ← All customers
          </Link>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">{customer.name}</h1>
          <p className="text-content-muted text-sm">
            {customer.code} · {customer.type.toLowerCase()} · Segment {customer.segment} ·{" "}
            {customer.town ?? "no town"}
          </p>
        </div>
        <div className="flex items-start gap-2">
          {can(principal, "invoice:read") ? (
            <ButtonLink href={`/print/statement/${customer.id}`} target="_blank" variant="secondary" size="sm">
              Print statement
            </ButtonLink>
          ) : null}
          {canWrite ? (
            <CustomerDialog mode="edit" customer={customer} territories={territories} reps={reps} buttonLabel="Edit details" buttonVariant="secondary" />
          ) : null}
          {canDelete ? <CustomerDeleteButton id={customer.id} name={customer.name} /> : null}
          <StatusBadge status={customer.status} />
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Outstanding balance"
          value={<Money cents={customer.balanceCents} />}
          hint={`Credit limit ${(customer.creditLimitCents / 100).toLocaleString("en-KE")}`}
          tone={
            customer.creditLimitCents > 0 && customer.balanceCents > customer.creditLimitCents
              ? "danger"
              : customer.balanceCents > 0
                ? "warning"
                : "success"
          }
        />
        <StatCard
          label="Lifetime value"
          value={<Money cents={lifetime._sum.totalCents ?? 0} compact />}
          hint={`${lifetime._count} invoices`}
        />
        <StatCard
          label="Payment terms"
          value={customer.paymentTermsDays > 0 ? `${customer.paymentTermsDays} days` : "Cash"}
        />
        <StatCard
          label="Visits (recent)"
          value={`${verifiedVisits} / ${visitStats.length}`}
          hint="GPS-verified"
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="rounded-lg border border-border bg-surface p-5 shadow-sm">
          <SectionHeading title="Contact" />
          <dl className="space-y-2 text-sm">
            {[
              ["Phone", customer.phone],
              ["Email", customer.email],
              ["Address", customer.address],
              ["Territory", customer.territory?.name],
              ["Assigned rep", customer.assignedRep?.name],
            ].map(([label, value]) => (
              <div key={label} className="flex justify-between gap-3">
                <dt className="text-content-muted shrink-0">{label}</dt>
                <dd className="truncate text-right">{value ?? "—"}</dd>
              </div>
            ))}
          </dl>

          {customer.contacts.length > 0 ? (
            <>
              <p className="text-xs font-medium uppercase tracking-wide text-content-muted mt-5">Additional contacts</p>
              <ul className="mt-2 space-y-2 text-sm">
                {customer.contacts.map((c) => (
                  <li key={c.id}>
                    <span className="font-medium">{c.name}</span>
                    <span className="text-content-muted block text-xs">
                      {c.role ?? "contact"} · {c.phone ?? "no phone"}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </div>

        <div className="lg:col-span-2">
          <SectionHeading
            title="Location"
            description={
              customer.latitude != null
                ? `Pin captured · ${customer.geofenceRadiusM}m check-in fence`
                : "No GPS pin captured yet"
            }
          />
          <TileMap
            map={toClientConfig(maps)}
            points={
              customer.latitude != null
                ? [
                    {
                      id: customer.id,
                      lat: customer.latitude,
                      lng: customer.longitude!,
                      label: customer.name,
                      tone: "success",
                    },
                    ...visitStats
                      .filter((v) => v.checkInLat != null)
                      .slice(0, 8)
                      .map((v) => ({
                        id: v.id,
                        lat: v.checkInLat!,
                        lng: v.checkInLng!,
                        label: `${new Date(v.scheduledAt).toLocaleDateString("en-KE")} — ${v.geofenceVerified ? "verified" : "outside fence"}`,
                        tone: v.geofenceVerified
                          ? ("neutral" as const)
                          : ("danger" as const),
                      })),
                  ]
                : []
            }
            height={300}
          />
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div>
          <SectionHeading title="Activity log" description="Follow-ups, calls, visits and orders" />
          <div className="rounded-lg border border-border bg-surface shadow-sm divide-y border-border" >
            {customer.activities.length === 0 ? (
              <p className="text-content-muted p-6 text-center text-sm">No activity recorded</p>
            ) : (
              customer.activities.map((a) => (
                <div key={a.id} className="p-4">
                  <div className="flex items-baseline justify-between gap-3">
                    <p className="text-sm font-medium">{a.subject}</p>
                    <span className="text-content-muted shrink-0 text-xs">
                      {a.createdAt.toLocaleDateString("en-KE")}
                    </span>
                  </div>
                  {a.body ? <p className="text-content-muted mt-0.5 text-xs">{a.body}</p> : null}
                  <p className="text-content-muted mt-1 text-[11px]">
                    <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium bg-surface-sunken">
                      {a.type.toLowerCase()}
                    </span>{" "}
                    {a.user?.name ? `· ${a.user.name}` : ""}
                  </p>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="space-y-6">
          <div>
            <SectionHeading title="Invoices" description={`${invoiceCount} on this account`} />
            <FilterBar action={path} preserve={preserved(sp, ["inv_status", "inv_page"])}>
              <FilterSelect
                name="inv_status"
                value={sp.inv_status}
                allLabel="Any status"
                options={[
                  { value: "ISSUED", label: "Issued" },
                  { value: "PARTIALLY_PAID", label: "Partially paid" },
                  { value: "OVERDUE", label: "Overdue" },
                  { value: "PAID", label: "Paid" },
                  { value: "CANCELLED", label: "Cancelled" },
                ]}
              />
            </FilterBar>
            <DataTable
              columns={invoiceColumns}
              rows={invoices}
              getRowKey={(inv) => inv.id}
              caption="Invoices for this customer"
              dense
              sort={{ key: invTs.sort, dir: invTs.dir }}
              sortHrefFor={invSortHrefFor}
              pagination={{
                page: invTs.page,
                pages: Math.max(1, Math.ceil(invoiceCount / invTs.limit)),
                total: invoiceCount,
                limit: invTs.limit,
                hrefFor: (p) => tableHref(path, sp, { inv_page: p }),
              }}
              empty={{ title: "No invoices" }}
            />
          </div>

          <div>
            <SectionHeading title="Visits" description={`${visitCount} recorded`} />
            <FilterBar action={path} preserve={preserved(sp, ["vis_status", "vis_page"])}>
              <FilterSelect
                name="vis_status"
                value={sp.vis_status}
                allLabel="Any status"
                options={[
                  { value: "SCHEDULED", label: "Scheduled" },
                  { value: "IN_PROGRESS", label: "In progress" },
                  { value: "COMPLETED", label: "Completed" },
                  { value: "MISSED", label: "Missed" },
                  { value: "CANCELLED", label: "Cancelled" },
                ]}
              />
            </FilterBar>
            <DataTable
              columns={visitColumns}
              rows={visits}
              getRowKey={(v) => v.id}
              caption="Visits to this customer"
              dense
              sort={{ key: visTs.sort, dir: visTs.dir }}
              sortHrefFor={visSortHrefFor}
              pagination={{
                page: visTs.page,
                pages: Math.max(1, Math.ceil(visitCount / visTs.limit)),
                total: visitCount,
                limit: visTs.limit,
                hrefFor: (p) => tableHref(path, sp, { vis_page: p }),
              }}
              empty={{ title: "No visits" }}
            />
          </div>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div>
          <SectionHeading
            title="Deals"
            description={`${custDeals.length} on this account`}
            actions={<NewDealDialog customers={thisCustomerOpt} reps={userOpts} stages={stageOpts} />}
          />
          <div className="divide-y rounded-lg border border-border bg-surface shadow-sm">
            {custDeals.length === 0 ? (
              <EmptyState title="No deals" description="Open one with New deal, or convert a lead." />
            ) : (
              custDeals.map((d) => (
                <div key={d.id} className="flex items-center justify-between gap-3 p-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{d.title}</p>
                    <p className="text-xs text-content-muted">
                      <Money cents={d.valueCents} compact />
                      {d.status !== "OPEN" ? <> · <Badge tone={d.status === "WON" ? "success" : "neutral"}>{d.status}</Badge></> : null}
                    </p>
                  </div>
                  <div className="shrink-0">
                    <DealStageSelect dealId={d.id} stageId={d.stageId} stages={stageOpts} />
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        <div>
          <SectionHeading
            title="Open tasks"
            description={`${custTasks.length} open`}
            actions={<NewTaskDialog users={userOpts} customerId={customer.id} label="+ Task" />}
          />
          <div className="divide-y rounded-lg border border-border bg-surface shadow-sm">
            {custTasks.length === 0 ? (
              <EmptyState title="No open tasks" description="Add a follow-up for this customer." />
            ) : (
              custTasks.map((t) => (
                <div key={t.id} className="flex items-center justify-between gap-3 p-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{t.title}</p>
                    {t.dueAt ? (
                      <p className={`text-xs ${t.dueAt.getTime() < Date.now() ? "font-medium text-danger" : "text-content-muted"}`}>
                        due {t.dueAt.toLocaleDateString("en-KE", { day: "numeric", month: "short" })}
                      </p>
                    ) : null}
                  </div>
                  <div className="shrink-0">
                    <TaskStatusButton taskId={t.id} status={t.status} />
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
