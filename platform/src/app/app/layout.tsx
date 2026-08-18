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
  { href: "/app/customers", label: "Customers", module: "CRM" },
  { href: "/app/sales", label: "Sales & POS", module: "SALES_POS" },
  { href: "/app/inventory", label: "Inventory", module: "INVENTORY" },
  { href: "/app/procurement", label: "Procurement", module: "PROCUREMENT" },
  { href: "/app/finance", label: "Finance", module: "FINANCE" },
  { href: "/app/field", label: "Field Sales", module: "FIELD_SALES" },
  { href: "/app/routes", label: "Routing & Geofencing", module: "ROUTING" },
  { href: "/app/sms", label: "SMS", module: "SMS" },
  { href: "/app/reports", label: "Reports", module: "ANALYTICS" },
  { href: "/app/settings", label: "Settings" },
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
