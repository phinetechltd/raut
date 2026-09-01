import { handler } from "@/lib/api";
import { db } from "@/lib/db";
import { isSelfScoped } from "@/lib/rbac";
import { companyIdOf } from "@/lib/tenant";

export const dynamic = "force-dynamic";

/**
 * Delta pull for the field app.
 *
 * The client sends `?since=<ISO>`; the server returns everything in that
 * company (narrowed to the rep for field-owned entities) whose `updatedAt` is
 * newer. Omitting `since` performs a full bootstrap.
 *
 * The returned `syncedAt` is the server's clock, and the client stores it as
 * the next watermark rather than using its own — handset clocks drift, and a
 * fast phone clock would silently skip records.
 *
 * Deletes are not tracked as tombstones. For this product that is acceptable:
 * customers and products are deactivated (`status`/`active`), not removed, so
 * the client sees the state change. A hard delete would need a tombstone table.
 */
export const GET = handler({}, async ({ principal, searchParams }) => {
  const companyId = companyIdOf(principal);
  const sinceRaw = searchParams.get("since");
  const since = sinceRaw ? new Date(sinceRaw) : null;
  const validSince = since && !Number.isNaN(since.getTime()) ? since : null;
  const newer = validSince ? { gt: validSince } : undefined;

  const selfOnly = isSelfScoped(principal);
  const repFilter = selfOnly ? { repId: principal.userId } : {};

  // Horizon caps the working set a handset holds. Reps do not need last year's
  // invoices offline, and pulling them makes first sync unusable on 3G.
  const horizon = new Date(Date.now() - 90 * 86_400_000);

  // One shape for customers wherever they are selected, so the referential
  // closure below yields rows indistinguishable from the delta.
  const customerSelect = {
    id: true, code: true, name: true, type: true, segment: true,
    phone: true, email: true, address: true, town: true,
    latitude: true, longitude: true, geofenceRadiusM: true,
    creditLimitCents: true, paymentTermsDays: true, balanceCents: true,
    status: true, territoryId: true, assignedRepId: true, notes: true,
    updatedAt: true,
  };

  const [
    customers,
    products,
    variants,
    territories,
    stock,
    visits,
    routes,
    orders,
    invoices,
    creditNotes,
    payments,
    expenseCategories,
  ] = await Promise.all([
    db.customer.findMany({
      where: {
        companyId,
        ...(newer ? { updatedAt: newer } : {}),
        ...(selfOnly ? { OR: [{ assignedRepId: principal.userId }, { assignedRepId: null }] } : {}),
      },
      select: customerSelect,
    }),

    db.product.findMany({
      where: { companyId, ...(newer ? { updatedAt: newer } : {}) },
      select: {
        id: true, sku: true, name: true, unit: true, unitsPerPack: true,
        barcode: true, sellPriceCents: true, taxRateBp: true,
        categoryId: true, active: true, imageUrl: true, updatedAt: true,
      },
    }),

    // Selling units. The POS needs these offline or a rep cannot sell a carton
    // in a shop with no signal, which is most shops.
    db.productVariant.findMany({
      where: { companyId, active: true, ...(newer ? { updatedAt: newer } : {}) },
      select: {
        id: true, productId: true, name: true, sku: true, barcode: true,
        unitsPerVariant: true, sellPriceCents: true, isDefault: true,
        active: true, updatedAt: true,
      },
    }),

    db.territory.findMany({
      where: { companyId, ...(newer ? { updatedAt: newer } : {}) },
      select: {
        id: true, name: true, code: true, colour: true, boundary: true,
        centerLat: true, centerLng: true, radiusM: true, active: true,
        updatedAt: true,
      },
    }),

    // Van stock: a rep only needs the load they are selling from.
    principal.enabledModules.has("INVENTORY")
      ? db.stockItem.findMany({
          where: {
            companyId,
            ...(selfOnly ? { location: { ownerUserId: principal.userId } } : {}),
            ...(newer ? { updatedAt: newer } : {}),
          },
          select: {
            id: true, productId: true, locationId: true,
            quantity: true, updatedAt: true,
          },
        })
      : Promise.resolve([]),

    db.visit.findMany({
      where: {
        companyId,
        ...repFilter,
        ...(newer ? { updatedAt: newer } : { scheduledAt: { gte: horizon } }),
      },
      include: { photos: { select: { id: true, url: true, caption: true, takenAt: true } } },
    }),

    db.route.findMany({
      where: {
        companyId,
        ...repFilter,
        ...(newer ? { updatedAt: newer } : { routeDate: { gte: horizon } }),
      },
      include: { stops: { orderBy: { sequence: "asc" } } },
    }),

    db.salesOrder.findMany({
      where: {
        companyId,
        ...(selfOnly ? { createdById: principal.userId } : {}),
        ...(newer ? { updatedAt: newer } : { orderDate: { gte: horizon } }),
      },
      include: { lines: true },
    }),

    db.invoice.findMany({
      where: {
        companyId,
        ...(selfOnly ? { createdById: principal.userId } : {}),
        ...(newer ? { updatedAt: newer } : { issueDate: { gte: horizon } }),
      },
      include: { lines: true },
    }),

    // Returns. A rep who raised one needs to reprint its credit note days
    // later, and the office needs it on the handset to stop a second credit
    // being raised against the same delivery.
    db.creditNote.findMany({
      where: {
        companyId,
        ...(selfOnly ? { createdById: principal.userId } : {}),
        ...(newer ? { updatedAt: newer } : { issueDate: { gte: horizon } }),
      },
      include: { lines: true },
    }),

    db.payment.findMany({
      where: {
        companyId,
        ...(selfOnly ? { createdById: principal.userId } : {}),
        ...(newer ? { updatedAt: newer } : { paidAt: { gte: horizon } }),
      },
      include: { allocations: true },
    }),

    db.expenseCategory.findMany({
      where: { companyId, active: true },
      select: { id: true, name: true, code: true },
    }),
  ]);

  // Referential closure.
  //
  // Customers are scoped to the rep who *owns* them; visits, orders, invoices
  // and payments to the rep who *performs* them. Those sets are not the same —
  // cover a colleague's shop and the handset receives the visit without the
  // customer, then renders "Unknown customer" on a stop it cannot identify.
  //
  // So anything the delta references ships with it, and deliberately without
  // the `updatedAt` filter: a customer unchanged since the watermark is absent
  // from the delta but may still be newly referenced by it.
  const referenced = new Set<string>();
  for (const v of visits) referenced.add(v.customerId);
  for (const o of orders) referenced.add(o.customerId);
  for (const i of invoices) referenced.add(i.customerId);
  for (const p of payments) referenced.add(p.customerId);
  for (const c of customers) referenced.delete(c.id);

  if (referenced.size > 0) {
    // companyId keeps this inside the tenant: a foreign id simply finds nothing.
    customers.push(
      ...(await db.customer.findMany({
        where: { companyId, id: { in: [...referenced] } },
        select: customerSelect,
      })),
    );
  }

  const deviceId = searchParams.get("deviceId");
  if (deviceId) {
    await db.device
      .updateMany({
        where: { deviceId, userId: principal.userId },
        data: { lastSyncAt: new Date(), lastSeenAt: new Date() },
      })
      .catch(() => undefined);
  }

  const counts = {
    customers: customers.length,
    products: products.length,
    territories: territories.length,
    stock: stock.length,
    visits: visits.length,
    routes: routes.length,
    orders: orders.length,
    invoices: invoices.length,
    creditNotes: creditNotes.length,
    payments: payments.length,
  };

  return {
    syncedAt: new Date().toISOString(),
    bootstrap: validSince === null,
    counts,
    // Named `entities`, not `data`: the success envelope already has a `data`
    // key, and nesting `data.data` reads badly on every client that consumes it.
    entities: {
      customers,
      products,
      variants,
      territories,
      stock,
      visits,
      routes,
      orders,
      invoices,
      creditNotes,
      payments,
      expenseCategories,
    },
  };
});
