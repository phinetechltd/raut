import { z } from "zod";

import { handler, ok, parseBody } from "@/lib/api";
import { auditAs } from "@/lib/audit";
import { companyIdOf } from "@/lib/tenant";
import { reverseManualJournal } from "@/server/accounting";

export const dynamic = "force-dynamic";

const schema = z.object({ reason: z.string().trim().min(3).max(200) });

/** Nothing is edited or deleted: a wrong journal is corrected by its mirror image. */
export const POST = handler<{ id: string }>({ permission: "journal:write" }, async ({ principal, params, request }) => {
  const input = await parseBody(request, schema);
  const reversal = await reverseManualJournal(companyIdOf(principal), principal.userId, params.id, input.reason);
  await auditAs(principal, "UPDATE", "JournalEntry", params.id, { reversedBy: reversal.number, reason: input.reason }, request);
  return ok(reversal, undefined, { status: 201 });
});
