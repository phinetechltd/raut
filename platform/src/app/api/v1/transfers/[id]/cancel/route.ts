import { handler, ok } from "@/lib/api";
import { auditAs } from "@/lib/audit";
import { companyIdOf } from "@/lib/tenant";
import { cancelTransfer } from "@/server/inventory";

export const dynamic = "force-dynamic";

/** Cancels a DRAFT transfer. Anything already dispatched must be received or closed short instead. */
export const POST = handler<{ id: string }>(
  { permission: "stock:write" },
  async ({ principal, request, params }) => {
    const companyId = companyIdOf(principal);
    const transfer = await cancelTransfer(params.id, companyId);
    await auditAs(principal, "UPDATE", "StockTransfer", transfer.id, { action: "cancel" }, request);
    return ok(transfer);
  },
);
