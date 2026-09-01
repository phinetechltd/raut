import { handler, notFound } from "@/lib/api";
import { companyIdOf } from "@/lib/tenant";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * One invoice, with its eTIMS result and any credit notes against it.
 *
 * The mobile app reads this to show a rep the control code and QR once KRA has
 * accepted the sale, so the customer standing in front of them can see a valid
 * tax invoice rather than a promise of one.
 *
 * Scoped by the principal's company: an id from another tenant is not found,
 * not forbidden, because the existence of another company's invoice numbers is
 * itself something they should not be able to probe for.
 */
export const GET = handler<{ id: string }>(
  { permission: "invoice:read" },
  async ({ principal, params }) => {
    const companyId = companyIdOf(principal);

    const invoice = await db.invoice.findFirst({
      where: { id: params.id, companyId },
      include: {
        customer: { select: { id: true, name: true, taxPin: true, town: true } },
        lines: {
          include: { product: { select: { sku: true, name: true } } },
        },
        creditNotes: {
          select: {
            id: true,
            number: true,
            reason: true,
            totalCents: true,
            issueDate: true,
            etimsStatus: true,
            etimsControlCode: true,
          },
          orderBy: { issueDate: "desc" },
        },
      },
    });

    if (!invoice) throw notFound("Invoice not found");

    return { invoice };
  },
);
