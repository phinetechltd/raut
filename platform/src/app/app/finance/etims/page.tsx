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

const STATUS_HINT: Record<string, string> = {
  ACCEPTED: "KRA has the document.",
  SENT: "Digitax has it; KRA has not answered yet. It is read back, never re-sent.",
  PENDING: "Failed in a way worth retrying. The next attempt is scheduled.",
  REJECTED: "Permanent. Someone has to fix the cause and retry by hand.",
};

export default async function EtimsLogPage() {
  const { companyId, principal } = await requireTenant();

  if (!principal.enabledModules.has("ETIMS")) return <ModuleLocked module="ETIMS" />;
  if (!can(principal, "etims:read")) notFound();

  const awaiting = { in: ["QUEUED", "SUBMITTED"] };
  const [
    submissions,
    counts,
    queuedInvoices,
    rejectedInvoices,
    queuedNotes,
    rejectedNotes,
    config,
    problemInvoices,
    problemNotes,
  ] = await Promise.all([
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
    db.invoice.count({ where: { companyId, etimsStatus: awaiting } }),
    db.invoice.count({ where: { companyId, etimsStatus: "REJECTED" } }),
    db.creditNote.count({ where: { companyId, etimsStatus: awaiting } }),
    db.creditNote.count({ where: { companyId, etimsStatus: "REJECTED" } }),
    db.etimsConfig.findUnique({ where: { companyId } }),
    // Documents carrying an error — rejected, or queued with a reason. These
    // are what someone has to act on; the attempt log below is the evidence.
    db.invoice.findMany({
      where: { companyId, etimsStatus: { in: ["QUEUED", "SUBMITTED", "REJECTED"] }, etimsError: { not: null } },
      select: { id: true, number: true, etimsStatus: true, etimsError: true, issueDate: true },
      orderBy: { issueDate: "desc" },
      take: 20,
    }),
    db.creditNote.findMany({
      where: { companyId, etimsStatus: { in: ["QUEUED", "SUBMITTED", "REJECTED"] }, etimsError: { not: null } },
      select: { id: true, number: true, etimsStatus: true, etimsError: true, issueDate: true, invoiceId: true },
      orderBy: { issueDate: "desc" },
      take: 20,
    }),
  ]);

  const byStatus = Object.fromEntries(counts.map((c) => [c.status, c._count._all]));

  // Document numbers, so a row can link back to the document it belongs to.
  const invoiceIds = submissions.filter((s) => s.docType === "SALE").map((s) => s.docId);
  const noteIds = submissions.filter((s) => s.docType === "CREDIT_NOTE").map((s) => s.docId);
  const [invoices, notes] = await Promise.all([
    db.invoice.findMany({
      where: { companyId, id: { in: invoiceIds } },
      select: { id: true, number: true },
    }),
    db.creditNote.findMany({
      where: { companyId, id: { in: noteIds } },
      select: { id: true, number: true, invoiceId: true },
    }),
  ]);
  const numberOf = new Map(invoices.map((i) => [i.id, i.number]));
  const noteOf = new Map(notes.map((n) => [n.id, n]));

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
          value={String(queuedInvoices + queuedNotes)}
          tone={queuedInvoices + queuedNotes > 0 ? "warning" : "neutral"}
          hint={`${queuedInvoices} invoice${queuedInvoices === 1 ? "" : "s"}, ${queuedNotes} credit note${queuedNotes === 1 ? "" : "s"} queued or pending`}
        />
        <StatCard
          label="Rejected"
          value={String(rejectedInvoices + rejectedNotes)}
          tone={rejectedInvoices + rejectedNotes > 0 ? "danger" : "neutral"}
          hint={rejectedInvoices + rejectedNotes > 0 ? "Needs attention: fix and retry by hand" : undefined}
        />
      </StatGrid>

      {(problemInvoices.length > 0 || problemNotes.length > 0) && (
        <Card>
          <SectionHeading
            title="Needs attention"
            description="Documents KRA has not accepted, with the reason on each. Nothing here retries on its own once it is rejected."
          />
          <ul className="divide-y divide-border text-sm">
            {problemInvoices.map((inv) => (
              <li key={inv.id} className="flex flex-wrap items-start gap-2 py-2">
                <Badge tone={inv.etimsStatus === "REJECTED" ? "danger" : "warning"}>{inv.etimsStatus}</Badge>
                <Link
                  href={`/app/sales/invoices/${inv.id}`}
                  className="tabular font-medium underline underline-offset-2"
                >
                  {inv.number}
                </Link>
                <span className="text-content-secondary">{inv.etimsError}</span>
              </li>
            ))}
            {problemNotes.map((n) => (
              <li key={n.id} className="flex flex-wrap items-start gap-2 py-2">
                <Badge tone={n.etimsStatus === "REJECTED" ? "danger" : "warning"}>{n.etimsStatus}</Badge>
                <span className="text-content-muted">Credit note</span>
                <Link
                  href={`/app/sales/invoices/${n.invoiceId}`}
                  className="tabular font-medium underline underline-offset-2"
                >
                  {n.number}
                </Link>
                <span className="text-content-secondary">{n.etimsError}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

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
                    <span title={STATUS_HINT[s.status]}>{s.status}</span>
                  </Badge>
                  <span className="text-content-muted">{s.docType}</span>
                  {s.docType === "SALE" && numberOf.get(s.docId) ? (
                    <Link
                      href={`/app/sales/invoices/${s.docId}`}
                      className="tabular font-medium underline underline-offset-2"
                    >
                      {numberOf.get(s.docId)}
                    </Link>
                  ) : s.docType === "CREDIT_NOTE" && noteOf.get(s.docId) ? (
                    <Link
                      href={`/app/sales/invoices/${noteOf.get(s.docId)!.invoiceId}`}
                      className="tabular font-medium underline underline-offset-2"
                    >
                      {noteOf.get(s.docId)!.number}
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
