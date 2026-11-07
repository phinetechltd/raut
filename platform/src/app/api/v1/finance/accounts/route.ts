import { z } from "zod";

import { handler, ok, parseBody } from "@/lib/api";
import { ACCOUNT_TYPES } from "@/lib/accounting";
import { auditAs } from "@/lib/audit";
import { companyIdOf } from "@/lib/tenant";
import { chartWithBalances, createAccount } from "@/server/accounting";

export const dynamic = "force-dynamic";

export const GET = handler({ permission: "report:financial" }, async ({ principal }) => {
  return chartWithBalances(companyIdOf(principal));
});

const schema = z.object({
  code: z.string().trim(),
  name: z.string().trim().min(2).max(80),
  type: z.enum(ACCOUNT_TYPES),
});

export const POST = handler({ permission: "journal:write" }, async ({ principal, request }) => {
  const input = await parseBody(request, schema);
  const account = await createAccount(companyIdOf(principal), input);
  await auditAs(principal, "CREATE", "Account", account.id, { code: account.code, name: account.name }, request);
  return ok(account, undefined, { status: 201 });
});
