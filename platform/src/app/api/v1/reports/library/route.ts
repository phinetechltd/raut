import { handler } from "@/lib/api";
import { REPORT_GROUPS, visibleCatalogue } from "@/server/report-library";

export const dynamic = "force-dynamic";

/** The reports this person may run: their role and their company's licences decide. */
export const GET = handler({}, async ({ principal }) => {
  const { reports, links } = visibleCatalogue(principal);
  return {
    groups: REPORT_GROUPS,
    reports: reports.map((r) => ({
      key: r.key,
      title: r.title,
      description: r.description,
      group: r.group,
      usesPeriod: r.usesPeriod,
    })),
    statements: links,
  };
});
