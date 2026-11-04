import { z } from "zod";

import { handler, ok, parseOptionalBody } from "@/lib/api";
import { auditAs } from "@/lib/audit";
import { companyIdOf } from "@/lib/tenant";
import { receiveTransfer } from "@/server/inventory";

export const dynamic = "force-dynamic";

const schema = z.object({
    /** Per-line quantities arriving now. Omit the whole list to receive everything in transit. */
    lines: z
      .array(z.object({ lineId: z.string(), quantity: z.number().int().positive() }))
      .min(1)
      .optional(),
  })
  .optional();

/** Stock arrives at the destination, in full or in part. */
export const POST = handler<{ id: string }>(
  { permission: "stock:write" },
  async ({ principal, request, params }) => {
    const companyId = companyIdOf(principal);
    const input = await parseOptionalBody(request, schema);

    const transfer = await receiveTransfer(params.id, principal.userId, {
      companyId,
      lines: input?.lines,
    });

    await auditAs(principal, "UPDATE", "StockTransfer", transfer.id, {
      action: "receive",
      status: transfer.status,
      lines: input?.lines ?? "all",
    }, request);

    return ok(transfer);
  },
);
