import { z } from "zod";

import { badRequest, handler, ok, parseBody } from "@/lib/api";
import { auditAs } from "@/lib/audit";
import { momentForDay } from "@/lib/report-engine";
import { companyIdOf } from "@/lib/tenant";
import { payBill } from "@/server/payables";

export const dynamic = "force-dynamic";

const schema = z.object({
  amountCents: z.number().int().positive(),
  paidAt: z.string(),
  account: z.enum(["BANK", "CASH"]),
  reference: z.string().trim().max(60).nullish(),
  clientUuid: z.string().trim().min(8).max(64).nullish(),
});

export const POST = handler<{ id: string }>({ permission: "payable:write" }, async ({ principal, params, request }) => {
  const input = await parseBody(request, schema);
  const paidAt = momentForDay(input.paidAt);
  if (!paidAt) throw badRequest("paidAt must be a real calendar day, as YYYY-MM-DD");

  const payment = await payBill(companyIdOf(principal), principal.userId, params.id, {
    amountCents: input.amountCents,
    paidAt,
    account: input.account,
    reference: input.reference ?? null,
    clientUuid: input.clientUuid ?? null,
  });
  await auditAs(principal, "CREATE", "SupplierPayment", payment.id, { number: payment.number, amount: payment.amountCents }, request);
  return ok(payment, undefined, { status: 201 });
});
