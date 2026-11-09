import { z } from "zod";

import { handler, ok, parseBody } from "@/lib/api";
import { auditAs } from "@/lib/audit";
import { createQuotation, listQuotations } from "@/server/quotations";

export const dynamic = "force-dynamic";

export const GET = handler({ permission: "quotation:read" }, async ({ principal, searchParams }) => {
  return listQuotations(principal, {
    status: searchParams.get("status") ?? undefined,
    q: searchParams.get("q") ?? undefined,
    customerId: searchParams.get("customerId") ?? undefined,
  });
});

const lineSchema = z.object({
  productId: z.string(),
  variantId: z.string().optional(),
  quantity: z.number().int().positive(),
  unitPriceCents: z.number().int().nonnegative().optional(),
  discountCents: z.number().int().nonnegative().optional(),
  description: z.string().optional(),
});

const schema = z.object({
  customerId: z.string(),
  lines: z.array(lineSchema).min(1),
  validUntil: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
  send: z.boolean().optional(),
});

export const POST = handler({ permission: "quotation:write" }, async ({ principal, request }) => {
  const input = await parseBody(request, schema);
  const quotation = await createQuotation(principal, input);
  await auditAs(principal, "CREATE", "Quotation", quotation.id, { number: quotation.number, totalCents: quotation.totalCents }, request);
  return ok(quotation, undefined, { status: 201 });
});
