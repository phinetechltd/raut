import { z } from "zod";

import { handler, ok, parseBody } from "@/lib/api";
import { auditAs } from "@/lib/audit";
import { convertQuotation } from "@/server/quotations";

export const dynamic = "force-dynamic";

const schema = z.object({ toInvoice: z.boolean().optional() });

export const POST = handler<{ id: string }>({ permission: "quotation:write" }, async ({ principal, params, request }) => {
  const input = await parseBody(request, schema).catch(() => ({}));
  const result = await convertQuotation(principal, params.id, input);
  await auditAs(principal, "UPDATE", "Quotation", params.id, { convertedTo: result.kind, ref: result.number }, request);
  return ok(result, undefined, { status: 201 });
});
