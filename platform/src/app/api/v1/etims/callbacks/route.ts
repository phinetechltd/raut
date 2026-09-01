import { handler, ok } from "@/lib/api";
import { db } from "@/lib/db";
import { reconcileInvoice } from "@/server/etims";

export const dynamic = "force-dynamic";

/**
 * Digitax status callbacks.
 *
 * Digitax documents no signature on these, so the body is **untrusted** and is
 * used only as a hint that something changed. Nothing in it is written to a
 * control code: if it were, anyone who learned an invoice number could stamp a
 * forged KRA code onto a real invoice and it would print as valid. The payload
 * tells us which document to look at; `reconcileInvoice` then asks Digitax
 * directly, over an authenticated request, what the truth is.
 *
 * The owning company is resolved from our own record too — never from the
 * payload — so a callback cannot be aimed at another tenant's invoice.
 *
 * Unknown references return 200. Every callback sender retries on a non-2xx,
 * and a reference we do not recognise is not going to start existing.
 */
export const POST = handler({ public: true }, async ({ request }) => {
  const payload = (await request.json().catch(() => ({}))) as Record<string, unknown>;

  const data = (payload.data ?? payload) as Record<string, unknown>;
  const saleId = typeof data.id === "string" ? data.id : null;
  const traderRef =
    typeof data.trader_invoice_number === "string" ? data.trader_invoice_number : null;

  if (!saleId && !traderRef) return ok({ ignored: true, reason: "no reference" });

  const invoice = await db.invoice.findFirst({
    where: saleId
      ? { etimsSaleId: saleId }
      : { number: traderRef!, etimsStatus: { not: "NOT_APPLICABLE" } },
    select: { id: true, companyId: true },
  });

  if (!invoice) return ok({ ignored: true, reason: "unknown reference" });

  await reconcileInvoice(invoice.id, invoice.companyId).catch(() => {});

  return ok({ received: true });
});
