import { notFound } from "next/navigation";

import { PrintDocument } from "@/components/print/print-document";
import { requireTenant } from "@/lib/session";
import { buildPrintDoc, isPrintType } from "@/server/print";

export const dynamic = "force-dynamic";

/**
 * /print/[type]/[id]
 *
 *   invoice · credit-note · receipt · delivery-note · order · purchase-order
 *   grn · statement (id = customer) · route-sheet
 *
 * Query: `?copy=1` stamps DUPLICATE, `?autoprint=1` opens the print dialog,
 * `?format=thermal` is the 80 mm layout (invoice, credit-note, receipt),
 * `?prices=1` puts prices on a delivery note, `?from&to` bound a statement.
 *
 * Signed-in tenants only. The builder applies the permission for the type and
 * the tenant scope; anything it cannot find is a 404, never a 403, so this URL
 * cannot be used to learn whether another company's id exists.
 */
export default async function PrintPage({
  params,
  searchParams,
}: {
  params: Promise<{ type: string; id: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { principal } = await requireTenant();
  const { type, id } = await params;
  const sp = await searchParams;

  if (!isPrintType(type)) notFound();

  const date = (v: string | undefined) => {
    if (!v) return null;
    const d = new Date(v.includes("T") ? v : `${v}T00:00:00`);
    return Number.isNaN(d.getTime()) ? null : d;
  };

  const doc = await buildPrintDoc(principal, type, id, {
    copy: sp.copy === "1" || sp.copy === "true",
    thermal: sp.format === "thermal",
    prices: sp.prices === "1" || sp.prices === "true",
    autoprint: sp.autoprint === "1" || sp.autoprint === "true",
    from: date(sp.from),
    to: date(sp.to),
  });
  if (!doc) notFound();

  return <PrintDocument doc={doc} />;
}
