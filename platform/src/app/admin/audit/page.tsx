import { SectionHeading } from "@/components/ui";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/** Platform-wide audit trail — Phase One security deliverable. */
export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ action?: string; entity?: string }>;
}) {
  const filters = await searchParams;

  const logs = await db.auditLog.findMany({
    where: {
      ...(filters.action ? { action: filters.action } : {}),
      ...(filters.entity ? { entity: filters.entity } : {}),
    },
    include: {
      user: { select: { name: true, email: true } },
      company: { select: { name: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 200,
  });

  const byAction = await db.auditLog.groupBy({ by: ["action"], _count: true });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Audit Log</h1>
        <p className="text-content-muted text-sm">
          Append-only trail of authentication and state changes across all tenants.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <a href="/admin/audit" className={`badge ${!filters.action ? "bg-accent-subtle text-accent" : "bg-surface-sunken"}`}>
          all ({byAction.reduce((s, a) => s + a._count, 0)})
        </a>
        {byAction
          .sort((a, b) => b._count - a._count)
          .map((a) => (
            <a
              key={a.action}
              href={`/admin/audit?action=${a.action}`}
              className={`badge ${
                filters.action === a.action
                  ? "bg-accent-subtle text-accent"
                  : "bg-surface-sunken"
              }`}
            >
              {a.action.toLowerCase()} ({a._count})
            </a>
          ))}
      </div>

      <div>
        <SectionHeading title="Events" description={`Showing the ${logs.length} most recent`} />
        <div className="scroll-x rounded-lg border border-border bg-surface shadow-sm">
          <table className="w-full border-collapse text-base">
            <thead>
              <tr>
                <th>When</th>
                <th>Company</th>
                <th>User</th>
                <th>Action</th>
                <th>Entity</th>
                <th>Details</th>
                <th>IP</th>
              </tr>
            </thead>
            <tbody>
              {logs.length === 0 ? (
                <tr>
                  <td colSpan={7} className="text-content-muted py-10 text-center">
                    No events match this filter
                  </td>
                </tr>
              ) : (
                logs.map((log) => (
                  <tr key={log.id}>
                    <td className="text-content-muted text-xs">
                      {log.createdAt.toLocaleString("en-KE", {
                        day: "2-digit", month: "short",
                        hour: "2-digit", minute: "2-digit",
                      })}
                    </td>
                    <td className="text-xs">{log.company?.name ?? "—"}</td>
                    <td className="text-xs">
                      {log.user?.name ?? "—"}
                      {log.user?.email ? (
                        <span className="text-content-muted block">{log.user.email}</span>
                      ) : null}
                    </td>
                    <td>
                      <span
                        className={`badge ${
                          log.action.includes("FAILED")
                            ? "bg-danger-bg text-danger"
                            : "bg-surface-sunken"
                        }`}
                      >
                        {log.action.toLowerCase()}
                      </span>
                    </td>
                    <td className="text-xs">{log.entity}</td>
                    <td className="text-content-muted max-w-xs truncate text-xs" title={log.changes ?? ""}>
                      {log.changes ?? "—"}
                    </td>
                    <td className="text-content-muted text-xs">{log.ipAddress ?? "—"}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
