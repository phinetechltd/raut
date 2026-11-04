import { z } from "zod";

import { handler, ok, parseOptionalBody } from "@/lib/api";
import { auditAs } from "@/lib/audit";
import { companyIdOf } from "@/lib/tenant";
import { dispatchTransfer } from "@/server/inventory";

export const dynamic = "force-dynamic";

const schema = z.object({
    /** Per-line quantities to send now. Omit the whole list to dispatch everything outstanding. */
    lines: z
      .array(z.object({ lineId: z.string(), quantity: z.number().int().positive() }))
      .min(1)
      .optional(),
  })
  .optional();

/** Stock leaves the source location, in full or in part. */
export const POST = handler<{ id: string }>(
  { permission: "stock:write" },
  async ({ principal, request, params }) => {
    const companyId = companyIdOf(principal);
    const input = await parseOptionalBody(request, schema);

    const transfer = await dispatchTransfer(params.id, principal.userId, {
      companyId,
      lines: input?.lines,
    });

    await auditAs(principal, "UPDATE", "StockTransfer", transfer.id, {
      action: "dispatch",
      status: transfer.status,
      lines: input?.lines ?? "all",
    }, request);

    return ok(transfer);
  },
);
