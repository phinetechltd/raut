import { handler } from "@/lib/api";
import { companyIdOf } from "@/lib/tenant";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/** The transmission log for this company. */
export const GET = handler({ permission: "etims:read" }, async ({ principal, searchParams }) => {
  const companyId = companyIdOf(principal);
  const status = searchParams.get("status");

  const rows = await db.etimsSubmission.findMany({
    where: { companyId, ...(status ? { status } : {}) },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  const counts = await db.etimsSubmission.groupBy({
    by: ["status"],
    where: { companyId },
    _count: { _all: true },
  });

  return {
    rows,
    counts: Object.fromEntries(counts.map((c) => [c.status, c._count._all])),
  };
});
