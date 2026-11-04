import { z } from "zod";

import { handler, ok, parseOptionalBody } from "@/lib/api";
import { auditAs } from "@/lib/audit";
import { companyIdOf } from "@/lib/tenant";
import { postGoodsReceipt } from "@/server/inventory";

export const dynamic = "force-dynamic";

const schema = z.object({ allowOver: z.boolean().optional() }).optional();

/**
 * Posts a DRAFT goods receipt: stock arrives at each line's location, the
 * products' cost basis moves to the landed cost, PO lines are marked received
 * and inventory / GRNI are booked. Posting twice is refused.
 */
export const POST = handler<{ id: string }>(
  { permission: "grn:write" },
  async ({ principal, request, params }) => {
    const companyId = companyIdOf(principal);
    const input = await parseOptionalBody(request, schema);

    const grn = await postGoodsReceipt(params.id, principal.userId, {
      companyId,
      allowOver: input?.allowOver,
    });

    await auditAs(principal, "UPDATE", "GoodsReceipt", grn.id, { action: "post", number: grn.number }, request);
    return ok(grn);
  },
);
