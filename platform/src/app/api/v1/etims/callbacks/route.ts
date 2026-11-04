import { NextResponse } from "next/server";

import { handler, ok } from "@/lib/api";
import { db } from "@/lib/db";
import { reconcileCreditNote, reconcileInvoice } from "@/server/etims";

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
 * payload — so a callback cannot be aimed at another tenant's invoice. A
 * Digitax sale id is unique across Digitax, so it identifies the company; a
 * trader invoice number is only unique *within* a company, so it is looked up
 * inside the company the sale id named, or — with no sale id — against every
 * company that has a filed document under that number. Reconciling is a GET
 * under each company's own key, so the worst a forged body can do is cause a
 * status to be re-read.
 *
 * Unknown references return 200. Every callback sender retries on a non-2xx,
 * and a reference we do not recognise is not going to start existing.
 */
export const POST = handler({ public: true }, async ({ request }) => {
  const ip = clientIp(request);
  if (!allow(ip)) {
    return NextResponse.json(
      { ok: false, error: { code: "RATE_LIMITED", message: "Too many callbacks; slow down" } },
      { status: 429, headers: { "Retry-After": "10" } },
    );
  }

  const payload = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const data = (payload && typeof payload === "object" && payload.data && typeof payload.data === "object"
    ? payload.data
    : payload) as Record<string, unknown>;

  const saleId = str(data.id) ?? str(data.sale_id);
  const traderRef = str(data.trader_invoice_number);

  if (!saleId && !traderRef) return ok({ ignored: true, reason: "no reference" });

  const targets: Array<{ kind: "SALE" | "CREDIT_NOTE"; id: string; companyId: string }> = [];

  // The sale id is the authoritative handle; it also tells us the company.
  let companyId: string | null = null;
  if (saleId) {
    const inv = await db.invoice.findFirst({
      where: { etimsSaleId: saleId },
      select: { id: true, companyId: true },
    });
    if (inv) {
      targets.push({ kind: "SALE", ...inv });
      companyId = inv.companyId;
    } else {
      const cn = await db.creditNote.findFirst({
        where: { etimsSaleId: saleId },
        select: { id: true, companyId: true },
      });
      if (cn) {
        targets.push({ kind: "CREDIT_NOTE", ...cn });
        companyId = cn.companyId;
      }
    }
  }

  // Our own number — only ever inside a company. A SUBMITTED document has no
  // sale id yet, which is exactly when this lookup earns its keep.
  if (targets.length === 0 && traderRef) {
    const filed = { not: "NOT_APPLICABLE" };
    const [invoices, notes] = await Promise.all([
      db.invoice.findMany({
        where: { number: traderRef, etimsStatus: filed, ...(companyId ? { companyId } : {}) },
        select: { id: true, companyId: true },
        take: 5,
      }),
      db.creditNote.findMany({
        where: { number: traderRef, etimsStatus: filed, ...(companyId ? { companyId } : {}) },
        select: { id: true, companyId: true },
        take: 5,
      }),
    ]);
    for (const inv of invoices) targets.push({ kind: "SALE", ...inv });
    for (const cn of notes) targets.push({ kind: "CREDIT_NOTE", ...cn });
  }

  if (targets.length === 0) return ok({ ignored: true, reason: "unknown reference" });

  let reconciled = 0;
  for (const t of targets) {
    const r = await (t.kind === "SALE"
      ? reconcileInvoice(t.id, t.companyId)
      : reconcileCreditNote(t.id, t.companyId)
    ).catch(() => ({ ok: false }));
    if (r.ok) reconciled++;
  }

  return ok({ received: true, documents: targets.length, reconciled });
});

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 && v.length <= 200 ? v.trim() : null;
}

// ── rate limit ─────────────────────────────────────────────────────────
//
// A token bucket per source address, in memory. This is a public endpoint that
// causes an authenticated GET to Digitax per hit, so an unthrottled caller
// could spend a company's API quota for them. Sixty a minute with a burst of
// thirty is far more than Digitax will ever send to one deployment; the point
// is the ceiling, not the precise number. Per process, which is fine: a
// deployment with several processes has several ceilings, all of them low.

const BUCKET_CAPACITY = 30;
const REFILL_PER_SECOND = 1;
const buckets = new Map<string, { tokens: number; at: number }>();

// Not exported: Next.js rejects route modules with extra exports.
function allow(ip: string, now = Date.now()): boolean {
  let b = buckets.get(ip);
  if (!b) {
    b = { tokens: BUCKET_CAPACITY, at: now };
    buckets.set(ip, b);
  }
  const elapsed = Math.max(0, now - b.at) / 1000;
  b.tokens = Math.min(BUCKET_CAPACITY, b.tokens + elapsed * REFILL_PER_SECOND);
  b.at = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;

  // Forget quiet callers so the map cannot grow without bound.
  if (buckets.size > 5000) {
    for (const [k, v] of buckets) if (now - v.at > 60_000) buckets.delete(k);
  }
  return true;
}

function clientIp(request: Request): string {
  const fwd = request.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return request.headers.get("x-real-ip") ?? "unknown";
}
