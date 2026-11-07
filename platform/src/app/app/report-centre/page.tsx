import Link from "next/link";

import { Card, EmptyState, FilterBar, FilterSearch, PageHeader, SectionHeading } from "@/components/ui";
import { requireTenant } from "@/lib/session";
import { REPORT_GROUPS, visibleCatalogue } from "@/server/report-library";

export const dynamic = "force-dynamic";

const PATH = "/app/report-centre";

/**
 * Every report this person may run, grouped by area. What appears here follows
 * their role and their company's licences, so nothing is offered that would then
 * be refused.
 */
export default async function ReportCentrePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { principal } = await requireTenant();
  const params = await searchParams;
  const { reports, links } = visibleCatalogue(principal);

  const q = params.q?.trim().toLowerCase();
  const matches = (r: { title: string; description: string }) =>
    !q || r.title.toLowerCase().includes(q) || r.description.toLowerCase().includes(q);

  const groups = REPORT_GROUPS.map((group) => ({
    ...group,
    items: [
      ...links
        .filter((l) => l.group === group.key && matches(l))
        .map((l) => ({ key: l.key, title: l.title, description: l.description, href: l.href })),
      ...reports
        .filter((r) => r.group === group.key && matches(r))
        .map((r) => ({ key: r.key, title: r.title, description: r.description, href: `${PATH}/${r.key}` })),
    ],
  })).filter((g) => g.items.length > 0);

  const total = reports.length + links.length;

  return (
    <div className="space-y-8">
      <PageHeader
        title="Report centre"
        description={`${total} report${total === 1 ? "" : "s"} available to you. Each can be searched, sorted, exported to a spreadsheet and printed.`}
      />

      <FilterBar action={PATH}>
        <FilterSearch name="q" value={params.q} placeholder="Find a report…" />
      </FilterBar>

      {groups.length === 0 ? (
        <Card>
          <EmptyState
            title={total === 0 ? "No reports for your role" : "No report matches that search"}
            description={total === 0 ? "Ask your administrator if you need access." : "Try a shorter word."}
          />
        </Card>
      ) : (
        groups.map((group) => (
          <section key={group.key}>
            <SectionHeading title={group.label} description={group.description} />
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {group.items.map((item) => (
                <Link
                  key={item.key}
                  href={item.href}
                  className="block rounded-xl border border-border bg-surface p-4 transition-colors hover:bg-surface-hover"
                >
                  <p className="text-sm font-semibold">{item.title}</p>
                  <p className="mt-1 text-xs text-content-muted">{item.description}</p>
                </Link>
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  );
}
