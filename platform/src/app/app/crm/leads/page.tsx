import Link from "next/link";

import {
  DataTable,
  ModuleLocked,
  PageHeader,
  type Column,
} from "@/components/ui";
import { db } from "@/lib/db";
import { requireTenant } from "@/lib/session";
import { listLeads } from "@/server/crm";

import { ConvertLeadButton, LeadStatusSelect, NewLeadDialog, type Option } from "../crm-client";

export const dynamic = "force-dynamic";

const SOURCE_LABEL: Record<string, string> = {
  REFERRAL: "Referral", WEB: "Website", FIELD: "Field", CALL: "Call", EVENT: "Event", OTHER: "Other",
};

type LeadRow = Awaited<ReturnType<typeof listLeads>>[number];

export default async function LeadsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const { companyId, principal } = await requireTenant();
  if (!principal.enabledModules.has("CRM")) return <ModuleLocked module="CRM" />;

  const params = await searchParams;
  const leads = await listLeads(principal, { status: params.status, q: params.q });
  const users = await db.user.findMany({
    where: { companyId, status: { not: "SUSPENDED" } },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
  const userOpts: Option[] = users;
  const nameOf = new Map(users.map((u) => [u.id, u.name]));

  const columns: Array<Column<LeadRow>> = [
    {
      key: "name",
      header: "Lead",
      cell: (l) => (
        <div>
          <p className="font-medium">{l.name}</p>
          {l.contactName ? <p className="text-xs text-content-muted">{l.contactName}</p> : null}
        </div>
      ),
    },
    { key: "phone", header: "Phone", hideBelow: "md", cell: (l) => l.phone ?? "—" },
    { key: "source", header: "Source", hideBelow: "lg", cell: (l) => (l.source ? SOURCE_LABEL[l.source] ?? l.source : "—") },
    { key: "owner", header: "Owner", hideBelow: "lg", cell: (l) => (l.ownerId ? nameOf.get(l.ownerId) ?? "—" : "—") },
    {
      key: "status",
      header: "Status",
      cell: (l) =>
        l.status === "CONVERTED" && l.convertedCustomerId ? (
          <Link href={`/app/customers/${l.convertedCustomerId}`} className="text-sm text-accent hover:underline">Converted →</Link>
        ) : (
          <LeadStatusSelect leadId={l.id} status={l.status} />
        ),
    },
    {
      key: "actions",
      header: "",
      align: "right",
      cell: (l) => (l.status === "CONVERTED" ? null : <ConvertLeadButton leadId={l.id} leadName={l.name} />),
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Leads"
        description="Prospects at the top of the funnel. Convert a lead to create a customer and open a deal."
        actions={<NewLeadDialog reps={userOpts} />}
      />
      <DataTable
        columns={columns}
        rows={leads}
        getRowKey={(l) => l.id}
        caption="Leads"
        empty={{ title: "No leads yet", description: "Capture a prospect with the New lead button." }}
      />
    </div>
  );
}
