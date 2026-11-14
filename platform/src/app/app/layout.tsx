import { Shell, type NavItem } from "@/components/shell";
import { db } from "@/lib/db";
import { requireTenant } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * Nav is declared with the module each section belongs to. The Shell renders
 * unlicensed sections as locked rather than hiding them, so the client can see
 * the upgrade path — the modules are the product's commercial units.
 */
const NAV: NavItem[] = [
  { href: "/app", label: "Dashboard" },
  { href: "/app/customers", label: "Customers", module: "CRM", group: "Sell" },
  { href: "/app/crm", label: "CRM & Pipeline", module: "CRM", group: "Sell" },
  { href: "/app/crm/leads", label: "Leads", module: "CRM", group: "Sell" },
  { href: "/app/tasks", label: "Tasks", module: "CRM", group: "Sell" },
  { href: "/app/sales", label: "Sales & POS", module: "SALES_POS", group: "Sell" },
  { href: "/app/sales/quotations", label: "Quotations", module: "SALES_POS", group: "Sell" },
  { href: "/app/inventory", label: "Inventory", module: "INVENTORY", group: "Sell" },
  { href: "/app/procurement", label: "Procurement", module: "PROCUREMENT", group: "Sell" },
  { href: "/app/finance", label: "Finance", module: "FINANCE", group: "Sell" },
  { href: "/app/field", label: "Field Sales", module: "FIELD_SALES", group: "Field" },
  { href: "/app/sales/targets", label: "Targets & Commission", module: "FIELD_SALES", group: "Field" },
  { href: "/app/routes", label: "Routing & Geofencing", module: "ROUTING", group: "Field" },
  { href: "/app/tracking", label: "Vehicle Tracking", module: "ROUTING", group: "Field" },
  { href: "/app/sms", label: "SMS", module: "SMS", group: "Engage" },
  { href: "/app/email", label: "Email", module: "SMS", group: "Engage" },
  { href: "/app/report-centre", label: "Report Centre", group: "Insight" },
  { href: "/app/reports", label: "Analytics", module: "ANALYTICS", group: "Insight" },
  { href: "/app/settings", label: "Settings", group: "Insight" },
];

export default async function TenantLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { claims, principal, companyId } = await requireTenant();

  const company = await db.company.findUniqueOrThrow({
    where: { id: companyId },
    select: { name: true },
  });

  return (
    <Shell
      title={company.name}
      subtitle="ERP & Field Sales"
      nav={NAV}
      user={{ name: claims.name, role: claims.role, email: claims.email }}
      enabledModules={[...principal.enabledModules]}
    >
      {children}
    </Shell>
  );
}
