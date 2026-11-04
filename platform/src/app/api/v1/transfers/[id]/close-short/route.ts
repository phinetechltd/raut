import { z } from "zod";

import { handler, ok, parseOptionalBody } from "@/lib/api";
import { auditAs } from "@/lib/audit";
import { companyIdOf } from "@/lib/tenant";
import { closeTransferShort } from "@/server/inventory";

export const dynamic = "force-dynamic";

const schema = z.object({ note: z.string().max(500).optional() }).optional();

/**
 * Closes a transfer that will never be completed. Goods dispatched but not
 * received go back onto the source's books and are written off there, which
 * posts the loss; undispatched quantity simply never moves.
 */
export const POST = handler<{ id: string }>(
  { permission: "stock:write" },
  async ({ principal, request, params }) => {
    const companyId = companyIdOf(principal);
    const input = await parseOptionalBody(request, schema);

    const transfer = await closeTransferShort(params.id, principal.userId, {
      companyId,
      note: input?.note,
    });

    await auditAs(principal, "UPDATE", "StockTransfer", transfer.id, {
      action: "close-short",
      writtenOff: transfer.lines.map((l) => ({ productId: l.productId, quantity: l.dispatched - l.received })),
    }, request);

    return ok(transfer);
  },
);
