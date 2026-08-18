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
 * Layout is a fixed sidebar plus a sticky header on desktop, collapsing to a
 * header and a horizontally-scrolling section strip below `lg`. The strip
 * matters: the sidebar is the only navigation, so hiding it on a phone without
 * a replacement would strand the user.
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
      <aside className="sticky top-0 hidden h-screen w-sidebar shrink-0 flex-col border-r border-border bg-surface lg:flex">
        {/* Product identity above the tenant's. Raut is what they are using;
            the company name is whose data they are in. Both matter, and
            collapsing them loses the multi-tenant story. */}
        <div className="border-b border-border px-4 py-3">
          <div className="flex items-center gap-2.5">
            <RautMark size={32} className="h-8 w-8 shrink-0" />
            <div className="min-w-0 leading-none">
              <p className="text-md font-semibold tracking-tight">Raut</p>
              <p className="mt-0.5 text-[9px] uppercase tracking-[0.11em] text-content-muted">
                One Platform. Every Mile.
              </p>
            </div>
          </div>
          <div className="mt-3 min-w-0 border-t border-border pt-2.5">
            <p className="truncate text-sm font-medium leading-tight">{title}</p>
            <p className="truncate text-xs text-content-muted">{subtitle}</p>
          </div>
        </div>

        <nav className="flex-1 overflow-y-auto p-2.5" aria-label="Sections">
          {groups.map(([group, items]) => (
            <div key={group || "main"} className="mb-3 last:mb-0">
              {group ? (
                <p className="px-2.5 pb-1 pt-2 text-xs font-semibold uppercase tracking-wider text-content-muted">
                  {group}
                </p>
              ) : null}
              <div className="space-y-0.5">
                <NavLinks nav={items} enabledModules={enabledModules} variant="sidebar" />
              </div>
            </div>
          ))}
        </nav>

        <div className="border-t border-border p-3">
          <div className="mb-2.5 flex items-center gap-2.5">
            <span
              className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-accent-subtle text-sm font-semibold text-accent"
              aria-hidden="true"
            >
              {user.name.charAt(0).toUpperCase()}
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{user.name}</p>
              <p className="truncate text-xs text-content-muted">
                {ROLE_LABELS[user.role as Role] ?? user.role}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <ThemeToggle />
            <form action={logout} className="flex-1">
              <button
                type="submit"
                className="h-7 w-full rounded border border-border text-xs font-medium transition-colors hover:bg-surface-hover"
              >
                Sign out
              </button>
            </form>
          </div>
        </div>
      </aside>

      {/* ── main column ─────────────────────────────────────────── */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 border-b border-border bg-surface/85 backdrop-blur lg:hidden">
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

        <main className="min-w-0 flex-1 animate-fade-in p-4 sm:p-6 lg:p-8">
          <div className="mx-auto w-full max-w-[1440px]">{children}</div>
        </main>
      </div>
    </div>
  );
}
