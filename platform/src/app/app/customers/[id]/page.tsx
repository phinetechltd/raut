import Link from "next/link";
import { notFound } from "next/navigation";

import {
  GeoMap,
  ModuleLocked,
  Money,
  SectionHeading,
  StatCard,
  StatusBadge,
} from "@/components/ui";
import { db } from "@/lib/db";
import { requireTenant } from "@/lib/session";

export const dynamic = "force-dynamic";

/** Module 01 · CRM — the 360° customer profile with activity log. */
export default async function CustomerDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { companyId, principal } = await requireTenant();
  if (!principal.enabledModules.has("CRM")) return <ModuleLocked module="CRM" />;

  const { id } = await params;

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
      invoices: { orderBy: { issueDate: "desc" }, take: 15 },
      payments: { orderBy: { paidAt: "desc" }, take: 15 },
      visits: {
        orderBy: { scheduledAt: "desc" },
        take: 15,
        include: { rep: { select: { name: true } } },
      },
    },
  });

  if (!customer) notFound();

  const lifetime = await db.invoice.aggregate({
    where: { customerId: customer.id, status: { notIn: ["DRAFT", "CANCELLED"] } },
    _sum: { totalCents: true },
    _count: true,
  });

  const verifiedVisits = customer.visits.filter((v) => v.geofenceVerified).length;

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
        <StatusBadge status={customer.status} />
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
          value={`${verifiedVisits} / ${customer.visits.length}`}
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
          <GeoMap
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
                    ...customer.visits
                      .filter((v) => v.checkInLat != null)
                      .slice(0, 8)
                      .map((v) => ({
                        id: v.id,
                        lat: v.checkInLat!,
                        lng: v.checkInLng!,
                        label: v.geofenceVerified ? "✓" : "✗",
                        tone: v.geofenceVerified
                          ? ("neutral" as const)
                          : ("danger" as const),
                      })),
                  ]
                : []
            }
            height={280}
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
            <SectionHeading title="Invoices" />
            <div className="scroll-x rounded-lg border border-border bg-surface shadow-sm">
              <table className="w-full border-collapse text-base">
                <thead>
                  <tr>
                    <th>Number</th>
                    <th>Issued</th>
                    <th>Total</th>
                    <th>Due</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {customer.invoices.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="text-content-muted py-6 text-center">
                        No invoices
                      </td>
                    </tr>
                  ) : (
                    customer.invoices.map((inv) => (
                      <tr key={inv.id}>
                        <td className="font-medium">{inv.number}</td>
                        <td className="text-content-muted text-xs">
                          {inv.issueDate.toLocaleDateString("en-KE")}
                        </td>
                        <td>
                          <Money cents={inv.totalCents} />
                        </td>
                        <td>
                          <Money cents={inv.totalCents - inv.paidCents} />
                        </td>
                        <td>
                          <StatusBadge status={inv.status} />
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div>
            <SectionHeading title="Visits" />
            <div className="scroll-x rounded-lg border border-border bg-surface shadow-sm">
              <table className="w-full border-collapse text-base">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Rep</th>
                    <th>Status</th>
                    <th>Verified</th>
                    <th>Distance</th>
                  </tr>
                </thead>
                <tbody>
                  {customer.visits.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="text-content-muted py-6 text-center">
                        No visits
                      </td>
                    </tr>
                  ) : (
                    customer.visits.map((v) => (
                      <tr key={v.id}>
                        <td className="text-content-muted text-xs">
                          {v.scheduledAt.toLocaleDateString("en-KE")}
                        </td>
                        <td className="text-xs">{v.rep.name}</td>
                        <td>
                          <StatusBadge status={v.status} />
                        </td>
                        <td>
                          {v.geofenceVerified ? (
                            <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium bg-success-bg text-success">yes</span>
                          ) : v.checkInAt ? (
                            <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium bg-danger-bg text-danger">no</span>
                          ) : (
                            <span className="text-content-muted text-xs">—</span>
                          )}
                        </td>
                        <td className="text-content-muted text-xs">
                          {v.distanceFromCustomerM != null
                            ? `${v.distanceFromCustomerM}m`
                            : "—"}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

