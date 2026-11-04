"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

import type { NavItem } from "./shell";
import {
  CustomersIcon,
  DashboardIcon,
  FieldIcon,
  FinanceIcon,
  InventoryIcon,
  PlatformIcon,
  ProcurementIcon,
  ReportsIcon,
  RoutesIcon,
  SalesIcon,
  SettingsIcon,
  SmsIcon,
} from "./ui/icons";

function isActive(pathname: string, href: string): boolean {
  // "/app" must not light up for "/app/customers", but "/app/customers/abc"
  // should keep "/app/customers" highlighted.
  if (href === "/app" || href === "/admin") return pathname === href;
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** Icon per section, keyed by href so layouts stay declarative. */
const ICONS: Array<[prefix: string, icon: ReactNode]> = [
  ["/admin", <PlatformIcon key="p" />],
  ["/app/customers", <CustomersIcon key="c" />],
  ["/app/sales", <SalesIcon key="s" />],
  ["/app/inventory", <InventoryIcon key="i" />],
  ["/app/procurement", <ProcurementIcon key="pr" />],
  ["/app/finance", <FinanceIcon key="f" />],
  ["/app/field", <FieldIcon key="fd" />],
  ["/app/routes", <RoutesIcon key="r" />],
  ["/app/sms", <SmsIcon key="sms" />],
  ["/app/reports", <ReportsIcon key="rep" />],
  ["/app/settings", <SettingsIcon key="set" />],
];

function iconFor(href: string): ReactNode {
  const found = ICONS.find(([prefix]) => href === prefix || href.startsWith(`${prefix}/`));
  if (found) return found[1];
  return href === "/app" ? <DashboardIcon /> : <PlatformIcon />;
}

export function NavLinks({
  nav,
  enabledModules,
  variant,
}: {
  nav: NavItem[];
  enabledModules?: string[];
  variant: "sidebar" | "strip";
}) {
  const pathname = usePathname();
  const licensed = enabledModules ? new Set(enabledModules) : null;

  // The strip is the only navigation on small screens and has no room for
  // locked entries, so it shows what is actually reachable.
  const visible =
    variant === "strip"
      ? nav.filter((i) => i.module === undefined || !licensed || licensed.has(i.module))
      : nav;

  return (
    <>
      {visible.map((item) => {
        const locked =
          item.module !== undefined && licensed !== null && !licensed.has(item.module);
        const active = isActive(pathname, item.href);

        if (locked) {
          return (
            <span
              key={item.href}
              title="Not included in your subscription"
              aria-disabled="true"
              className={
                variant === "strip"
                  ? "flex cursor-not-allowed items-center justify-between whitespace-nowrap rounded px-2.5 py-1 text-sm text-content-muted opacity-55"
                  : "flex cursor-not-allowed items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13.5px] text-sidebar-subtle opacity-55"
              }
            >
              <span className="flex min-w-0 items-center gap-2.5">
                {variant === "sidebar" ? <span className="shrink-0 opacity-80">{iconFor(item.href)}</span> : null}
                <span className="truncate">{item.label}</span>
              </span>
              <LockIcon />
            </span>
          );
        }

        if (variant === "strip") {
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={`whitespace-nowrap rounded px-2.5 py-1 text-sm font-medium transition-colors ${
                active
                  ? "bg-accent-subtle text-accent"
                  : "text-content-secondary hover:text-content"
              }`}
            >
              {item.label}
            </Link>
          );
        }

        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={`relative flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13.5px] transition-colors ${
              active
                ? "bg-sidebar-active font-medium text-sidebar-activetext"
                : "text-sidebar-muted hover:bg-sidebar-hover hover:text-sidebar-content"
            }`}
          >
            <span className="shrink-0 opacity-90">{iconFor(item.href)}</span>
            <span className="truncate">{item.label}</span>
            {item.badge ? (
              <span className="ms-auto shrink-0 rounded-full px-1.5 text-xs tabular bg-white/10 text-sidebar-content">
                {item.badge}
              </span>
            ) : null}
          </Link>
        );
      })}
    </>
  );
}

function LockIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="4" y="10" width="16" height="11" rx="2" stroke="currentColor" strokeWidth="2.5" />
      <path d="M8 10V7a4 4 0 1 1 8 0v3" stroke="currentColor" strokeWidth="2.5" />
    </svg>
  );
}
