import Link from "next/link";
import { notFound } from "next/navigation";

import {
  Badge,
  ButtonLink,
  Card,
  EmptyState,
  ModuleLocked,
  PageHeader,
  SectionHeading,
  StatCard,
  StatGrid,
} from "@/components/ui";
import { db } from "@/lib/db";
import { can } from "@/lib/rbac";
import { requireTenant } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * Finance > eTIMS.
 *
 * What has been filed, what has not, and why. The stored request and response
 * are shown verbatim because when KRA disputes something, the useful answer is
 * what was actually sent — not what today's code would send.
 */

const TONE = {
  ACCEPTED: "success",
  PENDING: "warning",
  REJECTED: "danger",
  SENT: "info",
  FAILED: "danger",
} as const;

export default async function EtimsLogPage() {
  const { companyId, principal } = await requireTenant();

  if (!principal.enabledModules.has("ETIMS")) return <ModuleLocked module="ETIMS" />;
  if (!can(principal, "etims:read")) notFound();

  const [submissions, counts, queuedInvoices, rejectedInvoices, config] = await Promise.all([
    db.etimsSubmission.findMany({
      where: { companyId },
      orderBy: { createdAt: "desc" },
      take: 60,
    }),
    db.etimsSubmission.groupBy({
      by: ["status"],
      where: { companyId },
      _count: { _all: true },
    }),
    db.invoice.count({ where: { companyId, etimsStatus: "QUEUED" } }),
    db.invoice.count({ where: { companyId, etimsStatus: "REJECTED" } }),
    db.etimsConfig.findUnique({ where: { companyId } }),
  ]);

  const byStatus = Object.fromEntries(counts.map((c) => [c.status, c._count._all]));

  // Invoice ids, so a row can link back to the document it belongs to.
  const invoiceIds = submissions.filter((s) => s.docType === "SALE").map((s) => s.docId);
  const invoices = await db.invoice.findMany({
    where: { companyId, id: { in: invoiceIds } },
    select: { id: true, number: true },
  });
  const numberOf = new Map(invoices.map((i) => [i.id, i.number]));

  return (
    <div className="space-y-5">
      <PageHeader
        title="eTIMS transmissions"
        breadcrumb={{ href: "/app/finance", label: "Finance" }}
        description={
          config?.enabled
            ? `Filing in ${config.environment === "LIVE" ? "live" : "sandbox"} mode.`
            : "eTIMS is switched off. Nothing is being transmitted."
        }
        actions={
          can(principal, "etims:configure") ? (
            <ButtonLink href="/app/settings/etims" variant="secondary" size="sm">
              Settings
            </ButtonLink>
          ) : undefined
        }
      />

      <StatGrid>
        <StatCard label="Accepted" value={String(byStatus.ACCEPTED ?? 0)} tone="success" />
        <StatCard
          label="Awaiting KRA"
          value={String(queuedInvoices)}
          tone={queuedInvoices > 0 ? "warning" : "neutral"}
          hint="Invoices queued for transmission"
        />
        <StatCard
          label="Rejected"
          value={String(rejectedInvoices)}
          tone={rejectedInvoices > 0 ? "danger" : "neutral"}
          hint={rejectedInvoices > 0 ? "Needs attention" : undefined}
        />
      </StatGrid>

      <Card>
        <SectionHeading
          title="Attempts"
          description="Newest first. Every attempt is kept, including the ones that failed."
        />

        {submissions.length === 0 ? (
          <EmptyState
            title="Nothing transmitted yet"
            description={
              config?.enabled
                ? "Invoices raised from the start date will appear here."
                : "Switch eTIMS on in Settings to begin filing."
            }
          />
        ) : (
          <div className="space-y-2">
            {submissions.map((s) => (
              <details key={s.id} className="rounded-md border border-border">
                <summary className="flex cursor-pointer flex-wrap items-center gap-2 p-3 text-sm">
                  <Badge tone={TONE[s.status as keyof typeof TONE] ?? "neutral"}>
                    {s.status}
                  </Badge>
                  <span className="text-content-muted">{s.docType}</span>
                  {s.docType === "SALE" && numberOf.get(s.docId) ? (
                    <Link
                      href={`/app/sales/invoices/${s.docId}`}
                      className="tabular font-medium underline underline-offset-2"
                    >
                      {numberOf.get(s.docId)}
                    </Link>
                  ) : (
                    <span className="tabular text-xs text-content-muted">{s.docId}</span>
                  )}
                  <span className="text-xs text-content-muted">attempt {s.attempt}</span>
                  {s.httpStatus && (
                    <span className="tabular text-xs text-content-muted">
                      HTTP {s.httpStatus}
                    </span>
                  )}
                  <span className="ml-auto text-xs text-content-muted">
                    {s.createdAt.toISOString().slice(0, 16).replace("T", " ")}
                  </span>
                </summary>

                <div className="space-y-3 border-t border-border p-3 text-xs">
                  {s.error && (
                    <p className="text-danger">{s.error}</p>
                  )}
                  {s.endpoint && (
                    <p className="text-content-muted">
                      <span className="font-medium">Endpoint</span> {s.endpoint}
                    </p>
                  )}
                  {s.request && (
                    <div>
                      <p className="mb-1 font-medium">Sent</p>
                      <pre className="overflow-x-auto rounded bg-surface-sunken p-2">
                        {pretty(s.request)}
                      </pre>
                    </div>
                  )}
                  {s.response && (
                    <div>
                      <p className="mb-1 font-medium">Received</p>
                      <pre className="overflow-x-auto rounded bg-surface-sunken p-2">
                        {pretty(s.response)}
                      </pre>
                    </div>
                  )}
                </div>
              </details>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

/** Stored verbatim as a string; shown formatted, but never re-serialised. */
function pretty(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}
