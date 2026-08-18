import type { ReactNode } from "react";

import { MODULE_CATALOG, type ModuleKey } from "@/lib/modules";
import { can, denialReason, moduleNameFor, type Permission, type Principal } from "@/lib/rbac";

import { Badge, Callout, cx } from "./primitives";

/**
 * Permission-aware rendering.
 *
 * The rule this enforces: **a control the server will refuse must never look
 * available.** Route guards alone are not enough — a user who clicks a button
 * and gets an error has been misled by the UI, and on a shared handset or a
 * shared login that reads as the system being broken.
 *
 * Two failure modes are treated differently on purpose:
 *
 *   role     — the person cannot do this. Hide it. Explaining an action they
 *              can never take is noise.
 *   module   — the company has not bought this. Show it, disabled, with the
 *              module named. That is a sales conversation, not an error, and
 *              hiding it would conceal what the platform can do.
 */

export function Can({
  principal,
  permission,
  children,
  fallback = null,
}: {
  principal: Principal;
  permission: Permission;
  children: ReactNode;
  /** Rendered when denied. Defaults to nothing. */
  fallback?: ReactNode;
}) {
  return can(principal, permission) ? <>{children}</> : <>{fallback}</>;
}

/**
 * Like `Can`, but a module denial renders the children visibly disabled with an
 * explanation instead of vanishing.
 */
export function CanOrUpgrade({
  principal,
  permission,
  children,
}: {
  principal: Principal;
  permission: Permission;
  children: ReactNode;
}) {
  if (can(principal, permission)) return <>{children}</>;

  const reason = denialReason(principal, permission);
  if (reason === "role") return null;

  const module = moduleNameFor(permission);
  return (
    <span
      className="inline-flex cursor-not-allowed items-center gap-2 opacity-60"
      title={`${module ?? "This feature"} is not part of your subscription`}
    >
      <span className="pointer-events-none">{children}</span>
      <Badge tone="warning">Upgrade</Badge>
    </span>
  );
}

/**
 * Full-page state for an unlicensed module.
 *
 * Deliberately not an error page — the visitor has done nothing wrong. It
 * states what the module does and what it costs, because a module that has not
 * been bought is a commercial conversation.
 */
export function ModuleLocked({ module }: { module: ModuleKey }) {
  const definition = MODULE_CATALOG[module];

  return (
    <div className="mx-auto max-w-lg py-16 text-center">
      <div className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-accent-subtle text-accent">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <rect x="4" y="10" width="16" height="11" rx="2" stroke="currentColor" strokeWidth="2" />
          <path d="M8 10V7a4 4 0 1 1 8 0v3" stroke="currentColor" strokeWidth="2" />
        </svg>
      </div>

      <h1 className="mt-5 text-xl font-semibold">
        <span className="mr-1.5 text-content-muted">{definition.ordinal}</span>
        {definition.name}
      </h1>
      <p className="mt-2 text-base text-content-secondary">{definition.summary}</p>

      <ul className="mx-auto mt-6 max-w-xs space-y-2 text-left text-base">
        {definition.features.map((f) => (
          <li key={f} className="flex items-start gap-2">
            <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" aria-hidden="true" />
            {f}
          </li>
        ))}
      </ul>

      <p className="mt-6 text-xl font-semibold text-accent">
        KES {(definition.priceCents / 100).toLocaleString("en-KE")}
      </p>
      <p className="mt-1 text-sm text-content-muted">
        One-time module licence. Not included in your current subscription.
      </p>

      <p className="mt-6 text-sm text-content-muted">
        Contact your platform administrator to enable this module.
      </p>
    </div>
  );
}

/**
 * Read-only notice for a user who can see a section but not change it.
 * Better than silently omitting the controls — the absence would otherwise look
 * like a bug to someone who knows the feature exists.
 */
export function ReadOnlyNotice({ what }: { what: string }) {
  return (
    <Callout tone="info">
      You have view access to {what}. Changes require a role with edit
      permission — ask your company administrator.
    </Callout>
  );
}

/** Small inline lock marker for a disabled control. */
export function LockedHint({ className }: { className?: string }) {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className={cx("inline-block", className)}
    >
      <rect x="4" y="10" width="16" height="11" rx="2" stroke="currentColor" strokeWidth="2.5" />
      <path d="M8 10V7a4 4 0 1 1 8 0v3" stroke="currentColor" strokeWidth="2.5" />
    </svg>
  );
}
