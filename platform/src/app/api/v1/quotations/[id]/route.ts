import { z } from "zod";

import { handler, parseBody } from "@/lib/api";
import { auditAs } from "@/lib/audit";
import { getQuotation, updateQuotation } from "@/server/quotations";

export const dynamic = "force-dynamic";

export const GET = handler<{ id: string }>({ permission: "quotation:read" }, async ({ principal, params }) => {
  return getQuotation(principal, params.id);
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
  lines: z.array(lineSchema).min(1).optional(),
  validUntil: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
});

export const PATCH = handler<{ id: string }>({ permission: "quotation:write" }, async ({ principal, params, request }) => {
  const input = await parseBody(request, schema);
  const quotation = await updateQuotation(principal, params.id, input);
  await auditAs(principal, "UPDATE", "Quotation", quotation.id, { number: quotation.number }, request);
  return quotation;
});
