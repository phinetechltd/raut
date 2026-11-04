import { logout } from "@/app/login/actions";
import { ROLE_LABELS, type Role } from "@/lib/rbac";

import { NavLinks } from "./nav-links";
import { ThemeToggle } from "./theme-toggle";
import { RautMark } from "./raut-mark";

export interface NavItem {
  href: string;
  label: string;
  /** Module this section belongs to; undefined means core platform. */
  module?: string;
  badge?: string | number;
  /** Grouping header this item sits under in the sidebar. */
  group?: string;
}

/**
 * Console chrome.
 *
 * Layout is a fixed dark sidebar plus content; below `lg` it collapses to a
 * header and a horizontally-scrolling section strip. The strip matters: the
 * sidebar is the only navigation, so hiding it on a phone without a
 * replacement would strand the user.
 *
 * The sidebar stays navy in both colour schemes — it is the brand spine of the
 * console, and a white sidebar against a light page reads as a template rather
 * than a product. Its text pairings are asserted in check-contrast.
 *
 * Unlicensed sections render locked rather than disappearing — the modules are
 * the commercial product, so the upgrade path should stay visible.
 */
export function Shell({
  title,
  subtitle,
  nav,
  user,
  enabledModules,
  children,
}: {
  title: string;
  subtitle: string;
  nav: NavItem[];
  user: { name: string; role: string; email: string };
  enabledModules?: string[];
  children: React.ReactNode;
}) {
  const groups = Array.from(
    nav.reduce((map, item) => {
      const key = item.group ?? "";
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(item);
      return map;
    }, new Map<string, NavItem[]>()),
  );

  return (
    <div className="flex min-h-screen bg-bg">
      {/* ── sidebar ─────────────────────────────────────────────── */}
      <aside className="sticky top-0 hidden h-screen w-sidebar shrink-0 flex-col text-sidebar-content lg:flex relative print:hidden">
        {/* Layered gradient over the navy base keeps the panel deep rather than
            flat; tokens split so the dark scheme can lift it a step. */}
        <div className="absolute inset-0 bg-sidebar-bg2" />
        <div className="absolute inset-0 bg-gradient-to-b from-sidebar-bg1 to-sidebar-bg2" />
        <div className="absolute inset-0 border-r border-sidebar-border" />

        <div className="relative flex h-full flex-col">
          {/* Product identity above the tenant's. Raut is what they are using;
              the company name is whose data they are in. Both matter, and
              collapsing them loses the multi-tenant story. */}
          <div className="px-4 pb-3 pt-4">
            <div className="flex items-center gap-2.5">
              <span className="rounded-lg bg-white/95 p-1 shadow-sm">
                <RautMark size={28} className="block h-7 w-7" />
              </span>
              <div className="min-w-0 leading-none">
                <p className="text-md font-semibold tracking-tight text-sidebar-content">Raut</p>
                <p className="mt-0.5 text-[9px] uppercase tracking-[0.11em] text-sidebar-subtle">
                  One Platform. Every Mile.
                </p>
              </div>
            </div>
            <div className="mt-3.5 min-w-0 rounded-lg border border-sidebar-border bg-sidebar-hover px-3 py-2">
              <p className="truncate text-sm font-medium leading-tight text-sidebar-content">
                {title}
              </p>
              <p className="truncate text-xs text-sidebar-subtle">{subtitle}</p>
            </div>
          </div>

          <nav className="flex-1 overflow-y-auto px-2.5 pb-2" aria-label="Sections">
            {groups.map(([group, items], gi) => (
              <div key={group || "main"} className={gi === 0 ? "pb-1" : "pb-1 pt-2"}>
                {group ? (
                  <p className="px-2.5 pb-1 text-[10.5px] font-semibold uppercase tracking-widest text-sidebar-subtle">
                    {group}
                  </p>
                ) : null}
                <div className="space-y-0.5">
                  <NavLinks nav={items} enabledModules={enabledModules} variant="sidebar" />
                </div>
              </div>
            ))}
          </nav>

          <div className="border-t border-sidebar-border px-3 py-3">
            <div className="mb-2.5 flex items-center gap-2.5">
              <span
                className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-sm font-semibold"
                style={{
                  background: "color-mix(in srgb, var(--brand-500) 22%, transparent)",
                  color: "var(--brand-200)",
                }}
                aria-hidden="true"
              >
                {user.name.charAt(0).toUpperCase()}
              </span>
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-sidebar-content">{user.name}</p>
                <p className="truncate text-xs text-sidebar-subtle">
                  {ROLE_LABELS[user.role as Role] ?? user.role}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <ThemeToggle onDark />
              <form action={logout} className="flex-1">
                <button
                  type="submit"
                  className="h-8 w-full rounded-md border border-sidebar-border text-xs font-medium text-sidebar-muted transition-colors hover:bg-sidebar-hover hover:text-sidebar-content"
                >
                  Sign out
                </button>
              </form>
            </div>
          </div>
        </div>
      </aside>

      {/* ── mobile header ───────────────────────────────────────── */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 border-b border-border bg-surface/85 backdrop-blur lg:hidden print:hidden">
          <div className="flex items-center justify-between gap-3 px-4 py-2.5">
            <div className="flex min-w-0 items-center gap-2">
              <RautMark size={28} className="h-7 w-7 shrink-0" />
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold leading-tight">{title}</p>
                <p className="truncate text-xs text-content-muted">{user.name}</p>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <ThemeToggle />
              <form action={logout}>
                <button
                  type="submit"
                  className="h-7 rounded border border-border px-2.5 text-xs font-medium transition-colors hover:bg-surface-hover"
                >
                  Sign out
                </button>
              </form>
            </div>
          </div>

          <nav
            className="scroll-x flex gap-1 border-t border-border px-3 py-1.5"
            aria-label="Sections"
          >
            <NavLinks nav={nav} enabledModules={enabledModules} variant="strip" />
          </nav>
        </header>

        <main className="min-w-0 flex-1 animate-fade-in p-4 sm:p-6 lg:p-8 print:p-0">
          <div className="mx-auto w-full max-w-[1440px]">{children}</div>
        </main>
      </div>
    </div>
  );
}
