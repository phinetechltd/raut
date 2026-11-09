import { z } from "zod";

import { handler, parseBody } from "@/lib/api";
import { auditAs } from "@/lib/audit";
import { setQuotationStatus } from "@/server/quotations";

export const dynamic = "force-dynamic";

const schema = z.object({ status: z.enum(["SENT", "ACCEPTED", "REJECTED", "EXPIRED"]) });

export const POST = handler<{ id: string }>({ permission: "quotation:write" }, async ({ principal, params, request }) => {
  const { status } = await parseBody(request, schema);
  const quotation = await setQuotationStatus(principal, params.id, status);
  await auditAs(principal, "UPDATE", "Quotation", quotation.id, { status }, request);
  return quotation;
});
