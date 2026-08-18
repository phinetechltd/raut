import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";

/**
 * Base UI primitives.
 *
 * Every visual value comes from a token — no literal colours, radii or shadows
 * below. That is what makes a theme change a one-file edit rather than a
 * find-and-replace across forty components.
 */

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

// ── surface ────────────────────────────────────────────────────────────

export function Card({
  children,
  className,
  padded = true,
  as: Tag = "div",
}: {
  children: ReactNode;
  className?: string;
  padded?: boolean;
  as?: "div" | "section" | "article";
}) {
  return (
    <Tag
      className={cx(
        "rounded-lg border border-border bg-surface shadow-sm",
        padded && "p-5",
        className,
      )}
    >
      {children}
    </Tag>
  );
}

export function Divider({ className }: { className?: string }) {
  return <hr className={cx("border-0 border-t border-border", className)} />;
}

// ── typography / page structure ────────────────────────────────────────

/**
 * The standard page header. Consistency here is what makes twelve different
 * screens feel like one product — every page gets the same title position,
 * description treatment and action slot.
 */
export function PageHeader({
  title,
  description,
  actions,
  breadcrumb,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  breadcrumb?: { href: string; label: string };
}) {
  return (
    <header className="mb-6">
      {breadcrumb ? (
        <Link
          href={breadcrumb.href}
          className="mb-2 inline-flex items-center gap-1 text-sm text-content-muted transition-colors hover:text-accent"
        >
          <span aria-hidden="true">←</span> {breadcrumb.label}
        </Link>
      ) : null}

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          {description ? (
            <p className="mt-1 max-w-2xl text-base text-content-secondary">
              {description}
            </p>
          ) : null}
        </div>
        {actions ? <div className="flex shrink-0 flex-wrap gap-2">{actions}</div> : null}
      </div>
    </header>
  );
}

export function SectionHeading({
  title,
  description,
  actions,
  level = 2,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  level?: 2 | 3;
}) {
  const Tag = level === 2 ? "h2" : "h3";
  return (
    <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <Tag className={cx("font-semibold tracking-tight", level === 2 ? "text-lg" : "text-md")}>
          {title}
        </Tag>
        {description ? (
          <p className="mt-0.5 text-sm text-content-muted">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 gap-2">{actions}</div> : null}
    </div>
  );
}

// ── button ─────────────────────────────────────────────────────────────

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
type ButtonSize = "sm" | "md";

const BUTTON_BASE =
  "inline-flex items-center justify-center gap-2 rounded font-medium " +
  "transition-colors disabled:pointer-events-none disabled:opacity-50 " +
  "whitespace-nowrap";

const BUTTON_VARIANT: Record<ButtonVariant, string> = {
  primary: "bg-accent text-white hover:bg-accent-hover",
  secondary: "border border-border bg-surface hover:bg-surface-hover",
  ghost: "hover:bg-surface-hover",
  danger: "border border-danger-border bg-danger-bg text-danger hover:brightness-95",
};

const BUTTON_SIZE: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-sm",
  md: "h-10 px-4 text-base",
};

export function Button({
  variant = "secondary",
  size = "md",
  className,
  ...props
}: ComponentProps<"button"> & { variant?: ButtonVariant; size?: ButtonSize }) {
  return (
    <button
      className={cx(BUTTON_BASE, BUTTON_VARIANT[variant], BUTTON_SIZE[size], className)}
      {...props}
    />
  );
}

export function ButtonLink({
  variant = "secondary",
  size = "md",
  className,
  ...props
}: ComponentProps<typeof Link> & { variant?: ButtonVariant; size?: ButtonSize }) {
  return (
    <Link
      className={cx(BUTTON_BASE, BUTTON_VARIANT[variant], BUTTON_SIZE[size], className)}
      {...props}
    />
  );
}

// ── badge / status ─────────────────────────────────────────────────────

export type Tone = "neutral" | "info" | "success" | "warning" | "danger" | "accent";

const TONE_CLASS: Record<Tone, string> = {
  neutral: "bg-surface-sunken text-content-secondary border-border",
  info: "bg-info-bg text-info border-info-border",
  success: "bg-success-bg text-success border-success-border",
  warning: "bg-warning-bg text-warning border-warning-border",
  danger: "bg-danger-bg text-danger border-danger-border",
  accent: "bg-accent-subtle text-accent border-info-border",
};

export function Badge({
  children,
  tone = "neutral",
  className,
}: {
  children: ReactNode;
  tone?: Tone;
  className?: string;
}) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium",
        TONE_CLASS[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/**
 * Status → tone mapping, in one place so a status cannot be green on one screen
 * and grey on another.
 */
const STATUS_TONE: Record<string, Tone> = {
  ACTIVE: "success", PAID: "success", COMPLETED: "success", RECEIVED: "success",
  APPROVED: "success", DONE: "success", VISIT_VERIFIED: "success", POSTED: "success",
  SENT: "info", ISSUED: "info", CONFIRMED: "info", IN_PROGRESS: "info",
  IN_TRANSIT: "info", ARRIVED: "info", DELIVERED: "success",
  PENDING: "warning", SCHEDULED: "warning", PARTIALLY_PAID: "warning",
  PARTIALLY_RECEIVED: "warning", SUBMITTED: "warning", QUEUED: "warning",
  DRAFT: "neutral", UNPAID: "warning",
  OVERDUE: "danger", SUSPENDED: "danger", MISSED: "danger", REJECTED: "danger",
  CANCELLED: "danger", BLOCKED: "danger", FAILED: "danger",
  VISIT_REJECTED: "danger", OUT_OF_ZONE: "danger", SKIPPED: "danger",
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <Badge tone={STATUS_TONE[status] ?? "neutral"}>
      {status.replaceAll("_", " ").toLowerCase()}
    </Badge>
  );
}

// ── feedback ───────────────────────────────────────────────────────────

export function EmptyState({
  title,
  description,
  action,
  icon,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center px-6 py-14 text-center">
      {icon ? (
        <div className="mb-3 grid h-11 w-11 place-items-center rounded-full bg-surface-sunken text-content-muted">
          {icon}
        </div>
      ) : null}
      <p className="font-medium">{title}</p>
      {description ? (
        <p className="mt-1 max-w-sm text-sm text-content-muted">{description}</p>
      ) : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function Callout({
  tone = "info",
  title,
  children,
}: {
  tone?: Exclude<Tone, "neutral" | "accent">;
  title?: string;
  children: ReactNode;
}) {
  const border = {
    info: "border-info-border bg-info-bg",
    success: "border-success-border bg-success-bg",
    warning: "border-warning-border bg-warning-bg",
    danger: "border-danger-border bg-danger-bg",
  }[tone];

  const text = {
    info: "text-info", success: "text-success",
    warning: "text-warning", danger: "text-danger",
  }[tone];

  return (
    <div className={cx("rounded-lg border p-4", border)}>
      {title ? <p className={cx("text-base font-semibold", text)}>{title}</p> : null}
      <div className={cx("text-sm", title && "mt-1", text)}>{children}</div>
    </div>
  );
}

/** Loading placeholder that reserves the right amount of space. */
export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      className={cx(
        "relative overflow-hidden rounded bg-surface-sunken",
        "after:absolute after:inset-0 after:animate-shimmer",
        "after:bg-gradient-to-r after:from-transparent after:via-black/5 after:to-transparent",
        className,
      )}
      aria-hidden="true"
    />
  );
}

// ── form controls ──────────────────────────────────────────────────────

const FIELD_BASE =
  "w-full rounded border border-border bg-surface px-3 text-base " +
  "placeholder:text-content-muted transition-colors " +
  "hover:border-border-strong disabled:opacity-50";

export function Input({ className, ...props }: ComponentProps<"input">) {
  return <input className={cx(FIELD_BASE, "h-10", className)} {...props} />;
}

export function Select({ className, children, ...props }: ComponentProps<"select">) {
  return (
    <select className={cx(FIELD_BASE, "h-10 pr-8", className)} {...props}>
      {children}
    </select>
  );
}

export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return <textarea className={cx(FIELD_BASE, "py-2", className)} {...props} />;
}

export function Field({
  label,
  hint,
  error,
  htmlFor,
  children,
  required,
}: {
  label: string;
  hint?: string;
  error?: string;
  htmlFor?: string;
  children: ReactNode;
  required?: boolean;
}) {
  return (
    <div>
      <label htmlFor={htmlFor} className="mb-1 block text-sm font-medium">
        {label}
        {required ? <span className="ml-0.5 text-danger">*</span> : null}
      </label>
      {children}
      {error ? (
        <p className="mt-1 text-sm text-danger">{error}</p>
      ) : hint ? (
        <p className="mt-1 text-sm text-content-muted">{hint}</p>
      ) : null}
    </div>
  );
}

/** Filters and search sit in one row above the content they affect. */
export function Toolbar({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx("mb-3 flex flex-wrap items-center gap-2", className)}>
      {children}
    </div>
  );
}

/** Segmented filter links — for status/period switches on list pages. */
export function FilterTabs({
  options,
  active,
  hrefFor,
}: {
  options: Array<{ value: string; label: string; count?: number }>;
  active: string | null;
  hrefFor: (value: string | null) => string;
}) {
  return (
    <nav
      className="inline-flex flex-wrap gap-1 rounded-lg border border-border bg-surface-sunken p-1"
      aria-label="Filter"
    >
      {options.map((o) => {
        const isActive = (o.value === "" && !active) || o.value === active;
        return (
          <Link
            key={o.value || "all"}
            href={hrefFor(o.value || null)}
            aria-current={isActive ? "page" : undefined}
            className={cx(
              "rounded px-2.5 py-1 text-sm font-medium transition-colors",
              isActive
                ? "bg-surface text-accent shadow-sm"
                : "text-content-secondary hover:text-content",
            )}
          >
            {o.label}
            {o.count !== undefined ? (
              <span className="ml-1.5 text-content-muted">{o.count}</span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}
