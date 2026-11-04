import { z } from "zod";

import { ApiError, handler, parseBody } from "@/lib/api";
import { companyIdOf } from "@/lib/tenant";
import { transmitCreditNote, transmitInvoice } from "@/server/etims";

export const dynamic = "force-dynamic";

const Body = z.object({
  docType: z.enum(["SALE", "CREDIT_NOTE"]),
  docId: z.string().min(1),
});

/**
 * Sends one document by hand.
 *
 * The company id comes from the principal, never the request, so this cannot be
 * pointed at another tenant's invoice — the lookups inside are scoped by it and
 * return "not found" rather than transmitting.
 *
 * A document that did not end up ACCEPTED is a **422**, not a 200 with
 * `ok: false` inside. The handset's "Send all" counts a 2xx as sent, and a
 * queue that reports "Sent 12 to KRA" while nine of them are still waiting is
 * a lie told to a rep standing in front of a customer. `status` and `reason`
 * ride in the error details so the caller can still tell "awaiting KRA" from
 * "rejected".
 */
export const POST = handler(
  { permission: "etims:submit" },
  async ({ principal, request }) => {
    const body = await parseBody(request, Body);
    const companyId = companyIdOf(principal);

    const result =
      body.docType === "SALE"
        ? await transmitInvoice(body.docId, companyId, { manual: true })
        : await transmitCreditNote(body.docId, companyId, { manual: true });

    if (!result.ok) {
      throw new ApiError(422, "ETIMS_NOT_FILED", result.reason ?? "Not accepted by eTIMS", {
        status: result.status ?? null,
        reason: result.reason ?? null,
      });
    }

    return result;
  },
);
