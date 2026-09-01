import { z } from "zod";

import { handler, parseBody } from "@/lib/api";
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
 */
export const POST = handler(
  { permission: "etims:submit" },
  async ({ principal, request }) => {
    const body = await parseBody(request, Body);
    const companyId = companyIdOf(principal);

    const result =
      body.docType === "SALE"
        ? await transmitInvoice(body.docId, companyId)
        : await transmitCreditNote(body.docId, companyId);

    return result;
  },
);
