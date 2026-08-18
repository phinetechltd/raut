import Link from "next/link";

import { Money, SectionHeading, StatusBadge } from "@/components/ui";
import { db } from "@/lib/db";
import { MODULE_LIST } from "@/lib/modules";

import { NewCompanyForm } from "./new-company-form";

export const dynamic = "force-dynamic";

export default async function CompaniesPage() {
  const companies = await db.company.findMany({
    include: {
      _count: { select: { users: true, customers: true, invoices: true } },
      modules: { where: { enabled: true }, select: { priceCents: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Companies</h1>
        <p className="text-content-muted text-sm">
          Create, activate and license tenants on the shared instance.
        </p>
      </div>

      <div>
        <SectionHeading title="All tenants" description={`${companies.length} on this instance`} />
        <div className="scroll-x rounded-lg border border-border bg-surface shadow-sm">
          <table className="w-full border-collapse text-base">
            <thead>
              <tr>
                <th>Company</th>
                <th>Status</th>
                <th>Users</th>
                <th>Customers</th>
                <th>Invoices</th>
                <th>Modules</th>
                <th>Licence value</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {companies.map((c) => (
                <tr key={c.id}>
                  <td>
                    <p className="font-medium">{c.name}</p>
                    <p className="text-content-muted text-xs">/{c.slug}</p>
                  </td>
                  <td>
                    <StatusBadge status={c.status} />
                  </td>
                  <td>
                    {c._count.users}
                    <span className="text-content-text-content-muted">/{c.seatLimit}</span>
                  </td>
                  <td>{c._count.customers}</td>
                  <td>{c._count.invoices}</td>
                  <td>
                    {c.modules.length}
                    <span className="text-content-text-content-muted">/{MODULE_LIST.length}</span>
                  </td>
                  <td>
                    <Money cents={c.modules.reduce((s, m) => s + m.priceCents, 0)} />
                  </td>
                  <td>
                    <Link
                      href={`/admin/companies/${c.id}`}
                      className="text-xs text-accent hover:underline"
                    >
                      Manage
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div>
        <SectionHeading
          title="Onboard a new company"
          description="Creates the tenant, its head office, main store, admin user and licences in one step."
        />
        <NewCompanyForm />
      </div>
    </div>
  );
}
