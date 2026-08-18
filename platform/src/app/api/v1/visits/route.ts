import { z } from "zod";

import { handler, ok, pagination, paginationMeta, parseBody } from "@/lib/api";
import { auditAs } from "@/lib/audit";
import { db } from "@/lib/db";
import { companyIdOf, scope } from "@/lib/tenant";

export const dynamic = "force-dynamic";

export const GET = handler(
  { permission: "visit:read" },
  async ({ principal, searchParams }) => {
    const page = pagination(searchParams);
    const status = searchParams.get("status");
    const repId = searchParams.get("repId");
    const date = searchParams.get("date");
    const customerId = searchParams.get("customerId");

    let dateFilter = {};
    if (date) {
      const start = new Date(date);
      start.setHours(0, 0, 0, 0);
      const end = new Date(start.getTime() + 86_400_000);
      dateFilter = { scheduledAt: { gte: start, lt: end } };
    }

    const where = {
      ...scope(principal, { selfField: "repId" }),
      ...(status ? { status } : {}),
      ...(repId && principal.role !== "FIELD_REP" ? { repId } : {}),
      ...(customerId ? { customerId } : {}),
      ...dateFilter,
    };

    const [items, total] = await Promise.all([
      db.visit.findMany({
        where,
        include: {
          customer: {
            select: {
              id: true, name: true, code: true, phone: true, town: true,
              latitude: true, longitude: true, balanceCents: true,
            },
          },
          rep: { select: { id: true, name: true } },
          photos: true,
          order: { select: { id: true, number: true, totalCents: true } },
        },
        orderBy: { scheduledAt: "asc" },
        take: page.take,
        skip: page.skip,
      }),
      db.visit.count({ where }),
    ]);

    return ok(items, paginationMeta(page, total));
  },
);

const schema = z.object({
  customerId: z.string(),
  repId: z.string().optional(),
  routeId: z.string().optional(),
  scheduledAt: z.string(),
  purpose: z.enum(["SALES", "COLLECTION", "DELIVERY", "PROSPECTING", "SUPPORT"]).optional(),
  notes: z.string().optional(),
  clientUuid: z.string().optional(),
});

export const POST = handler(
  { permission: "visit:write" },
  async ({ principal, request }) => {
    const companyId = companyIdOf(principal);
    const input = await parseBody(request, schema);

    // A rep can only schedule visits for themselves; managers assign anyone.
    const repId =
      principal.role === "FIELD_REP" ? principal.userId : (input.repId ?? principal.userId);

    const visit = await db.visit.create({
      data: {
        companyId,
        customerId: input.customerId,
        repId,
        routeId: input.routeId ?? null,
        scheduledAt: new Date(input.scheduledAt),
        purpose: input.purpose ?? "SALES",
        notes: input.notes ?? null,
        clientUuid: input.clientUuid ?? null,
      },
      include: { customer: { select: { name: true } } },
    });

    await auditAs(principal, "CREATE", "Visit", visit.id, { customer: visit.customer.name }, request);
    return ok(visit, undefined, { status: 201 });
  },
);
