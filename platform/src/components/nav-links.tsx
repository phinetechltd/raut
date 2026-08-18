"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import type { NavItem } from "./shell";

function isActive(pathname: string, href: string): boolean {
  // "/app" must not light up for "/app/customers", but "/app/customers/abc"
  // should keep "/app/customers" highlighted.
  if (href === "/app" || href === "/admin") return pathname === href;
  return pathname === href || pathname.startsWith(`${href}/`);
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
              className="flex cursor-not-allowed items-center justify-between rounded px-2.5 py-1.5 text-base text-content-muted opacity-55"
            >
              <span className="truncate">{item.label}</span>
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
            className={`relative flex items-center justify-between gap-2 rounded px-2.5 py-1.5 text-base transition-colors ${
              active
                ? "bg-accent-subtle font-medium text-accent"
                : "text-content-secondary hover:bg-surface-hover hover:text-content"
            }`}
          >
            {/* Active rail — a second signal beside colour, for the same reason
                charts direct-label rather than relying on hue alone. */}
            {active ? (
              <span
                className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-r bg-accent"
                aria-hidden="true"
              />
            ) : null}
            <span className="truncate">{item.label}</span>
            {item.badge ? (
              <span className="shrink-0 rounded-full bg-surface-sunken px-1.5 text-xs tabular text-content-secondary">
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
