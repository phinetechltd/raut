import { z } from "zod";

import { handler, notFound, parseBody } from "@/lib/api";
import { auditAs, diff } from "@/lib/audit";
import { db } from "@/lib/db";
import { scope } from "@/lib/tenant";

export const dynamic = "force-dynamic";

export const GET = handler<{ id: string }>(
  { permission: "supplier:read" },
  async ({ principal, params }) => {
    const supplier = await db.supplier.findFirst({
      where: { id: params.id, ...scope(principal) },
      include: {
        purchaseOrders: { orderBy: { orderDate: "desc" }, take: 20 },
        goodsReceipts: { orderBy: { receivedAt: "desc" }, take: 20 },
      },
    });
    if (!supplier) throw notFound("Supplier not found");
    return supplier;
  },
);

const updateSchema = z.object({
  name: z.string().min(2).optional(),
  contactName: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  email: z.string().email().nullable().optional().or(z.literal("")),
  address: z.string().nullable().optional(),
  taxPin: z.string().nullable().optional(),
  paymentTermsDays: z.number().int().min(0).max(180).optional(),
  status: z.enum(["ACTIVE", "SUSPENDED"]).optional(),
});

export const PATCH = handler<{ id: string }>(
  { permission: "supplier:write" },
  async ({ principal, params, request }) => {
    const existing = await db.supplier.findFirst({
      where: { id: params.id, ...scope(principal) },
    });
    if (!existing) throw notFound("Supplier not found");

    const input = await parseBody(request, updateSchema);
    const data: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
      if (value === undefined) continue;
      data[key] = value === "" ? null : value;
    }

    const supplier = await db.supplier.update({ where: { id: params.id }, data });

    await auditAs(
      principal,
      "UPDATE",
      "Supplier",
      supplier.id,
      diff(existing as unknown as Record<string, unknown>, data),
      request,
    );
    return supplier;
  },
);
