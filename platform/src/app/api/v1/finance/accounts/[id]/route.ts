import { z } from "zod";

import { handler, parseBody } from "@/lib/api";
import { auditAs } from "@/lib/audit";
import { companyIdOf } from "@/lib/tenant";
import { updateAccount } from "@/server/accounting";

export const dynamic = "force-dynamic";

const schema = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  active: z.boolean().optional(),
});

export const PATCH = handler<{ id: string }>({ permission: "journal:write" }, async ({ principal, params, request }) => {
  const input = await parseBody(request, schema);
  const account = await updateAccount(companyIdOf(principal), params.id, input);
  await auditAs(principal, "UPDATE", "Account", account.id, input, request);
  return account;
});
