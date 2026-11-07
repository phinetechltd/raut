import { z } from "zod";

import { handler, parseBody } from "@/lib/api";
import { auditAs } from "@/lib/audit";
import { companyIdOf } from "@/lib/tenant";
import { voidBill } from "@/server/payables";

export const dynamic = "force-dynamic";

const schema = z.object({ reason: z.string().trim().min(3).max(200) });

export const POST = handler<{ id: string }>({ permission: "payable:write" }, async ({ principal, params, request }) => {
  const input = await parseBody(request, schema);
  const result = await voidBill(companyIdOf(principal), principal.userId, params.id, input.reason);
  await auditAs(principal, "UPDATE", "SupplierInvoice", params.id, { status: "VOID", reason: input.reason }, request);
  return result;
});
