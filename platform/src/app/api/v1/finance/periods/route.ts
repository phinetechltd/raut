import { z } from "zod";

import { forbidden, handler, parseBody } from "@/lib/api";
import { auditAs } from "@/lib/audit";
import { can } from "@/lib/rbac";
import { companyIdOf } from "@/lib/tenant";
import { closePeriod, periodsOverview, reopenPeriod } from "@/server/accounting";

export const dynamic = "force-dynamic";

export const GET = handler({ permission: "report:financial" }, async ({ principal }) => {
  return periodsOverview(companyIdOf(principal));
});

const schema = z.object({
  month: z.string(),
  action: z.enum(["close", "reopen"]),
});

/**
 * Closing stops anything being posted into that month, including a backdated
 * invoice or a phone syncing late. Reopening is a separate permission, because a
 * month already reported on should not reopen as easily as it closes.
 */
export const POST = handler({ permission: "period:close" }, async ({ principal, request }) => {
  const companyId = companyIdOf(principal);
  const input = await parseBody(request, schema);

  if (input.action === "reopen") {
    if (!can(principal, "period:reopen")) throw forbidden("Only a company administrator can reopen a closed month");
    const period = await reopenPeriod(companyId, input.month);
    await auditAs(principal, "UPDATE", "AccountingPeriod", period.id, { month: input.month, action: "reopen" }, request);
    return period;
  }

  const period = await closePeriod(companyId, principal.userId, input.month);
  await auditAs(principal, "UPDATE", "AccountingPeriod", period.id, { month: input.month, action: "close" }, request);
  return period;
});
