import { z } from "zod";

import { handler, notFound, parseBody } from "@/lib/api";
import { auditAs, diff } from "@/lib/audit";
import { db } from "@/lib/db";
import { scope } from "@/lib/tenant";

export const dynamic = "force-dynamic";

export const GET = handler<{ id: string }>(
  { permission: "customer:read" },
  async ({ principal, params }) => {
    const customer = await db.customer.findFirst({
      where: { id: params.id, ...scope(principal, { selfField: "assignedRepId" }) },
      include: {
        territory: true,
        assignedRep: { select: { id: true, name: true, phone: true } },
        contacts: true,
        activities: { orderBy: { createdAt: "desc" }, take: 20, include: { user: { select: { name: true } } } },
        invoices: { orderBy: { issueDate: "desc" }, take: 20 },
        payments: { orderBy: { paidAt: "desc" }, take: 20 },
        visits: { orderBy: { scheduledAt: "desc" }, take: 20, include: { rep: { select: { name: true } } } },
      },
    });

    if (!customer) throw notFound("Customer not found");

    const outstanding = customer.invoices
      .filter((i) => ["ISSUED", "PARTIALLY_PAID", "OVERDUE"].includes(i.status))
      .reduce((sum, i) => sum + (i.totalCents - i.paidCents), 0);

    return { ...customer, outstandingCents: outstanding };
  },
);

const updateSchema = z.object({
  name: z.string().min(2).optional(),
  type: z.enum(["RETAIL", "WHOLESALE", "DISTRIBUTOR", "INSTITUTION"]).optional(),
  segment: z.enum(["A", "B", "C"]).optional(),
  phone: z.string().nullable().optional(),
  email: z.string().email().nullable().optional().or(z.literal("")),
  address: z.string().nullable().optional(),
  town: z.string().nullable().optional(),
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
  geofenceRadiusM: z.number().int().min(20).max(5000).optional(),
  creditLimitCents: z.number().int().nonnegative().optional(),
  paymentTermsDays: z.number().int().min(0).max(180).optional(),
  territoryId: z.string().nullable().optional(),
  assignedRepId: z.string().nullable().optional(),
  status: z.enum(["ACTIVE", "DORMANT", "BLOCKED"]).optional(),
  notes: z.string().nullable().optional(),
});

/** Fields a field rep may change. Everything else is a back-office decision. */
const REP_EDITABLE = new Set([
  "phone", "email", "address", "town", "latitude", "longitude", "notes",
]);

export const PATCH = handler<{ id: string }>(
  { permission: "customer:write" },
  async ({ principal, params, request }) => {
    const existing = await db.customer.findFirst({
      where: { id: params.id, ...scope(principal, { selfField: "assignedRepId" }) },
    });
    if (!existing) throw notFound("Customer not found");

    const input = await parseBody(request, updateSchema);

    const data: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
      if (value === undefined) continue;
      if (principal.role === "FIELD_REP" && !REP_EDITABLE.has(key)) continue;
      data[key] = value === "" ? null : value;
    }

    const customer = await db.customer.update({ where: { id: params.id }, data });

    await auditAs(
      principal,
      "UPDATE",
      "Customer",
      customer.id,
      diff(existing as unknown as Record<string, unknown>, data),
      request,
    );

    return customer;
  },
);

export const DELETE = handler<{ id: string }>(
  { permission: "customer:delete" },
  async ({ principal, params, request }) => {
    const existing = await db.customer.findFirst({
      where: { id: params.id, ...scope(principal) },
      include: { _count: { select: { invoices: true, salesOrders: true } } },
    });
    if (!existing) throw notFound("Customer not found");

    // A customer with trading history is deactivated, never removed —
    // deleting them would orphan invoices the business still needs to collect.
    if (existing._count.invoices > 0 || existing._count.salesOrders > 0) {
      const customer = await db.customer.update({
        where: { id: params.id },
        data: { status: "BLOCKED" },
      });
      await auditAs(principal, "UPDATE", "Customer", customer.id, { status: "BLOCKED" }, request);
      return { deleted: false, deactivated: true, customer };
    }

    await db.customer.delete({ where: { id: params.id } });
    await auditAs(principal, "DELETE", "Customer", params.id, { name: existing.name }, request);
    return { deleted: true, deactivated: false };
  },
);
