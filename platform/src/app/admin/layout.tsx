import { Shell, type NavItem } from "@/components/shell";
import { requireSuperAdmin } from "@/lib/session";

export const dynamic = "force-dynamic";

const NAV: NavItem[] = [
  { href: "/admin", label: "Platform Overview" },
  { href: "/admin/companies", label: "Companies" },
  { href: "/admin/modules", label: "Module Catalogue" },
  { href: "/admin/audit", label: "Audit Log" },
];

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { claims } = await requireSuperAdmin();

  return (
    <Shell
      title="Super Admin"
      subtitle="Tari Africa Platforms"
      nav={NAV}
      user={{ name: claims.name, role: claims.role, email: claims.email }}
    >
      {children}
    </Shell>
  );
}
