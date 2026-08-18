import { z } from "zod";

import { handler, ok, pagination, paginationMeta, parseBody } from "@/lib/api";
import { auditAs } from "@/lib/audit";
import { db } from "@/lib/db";
import { nextNumber } from "@/lib/numbering";
import { companyIdOf, scope } from "@/lib/tenant";

export const dynamic = "force-dynamic";

export const GET = handler(
  { permission: "customer:read" },
  async ({ principal, searchParams }) => {
    const page = pagination(searchParams);
    const search = searchParams.get("q");
    const territoryId = searchParams.get("territoryId");
    const status = searchParams.get("status");
    const withBalance = searchParams.get("withBalance") === "true";

    const where = {
      ...scope(principal, { selfField: "assignedRepId" }),
      ...(search
        ? {
            OR: [
              { name: { contains: search } },
              { code: { contains: search } },
              { phone: { contains: search } },
              { town: { contains: search } },
            ],
          }
        : {}),
      ...(territoryId ? { territoryId } : {}),
      ...(status ? { status } : {}),
      ...(withBalance ? { balanceCents: { gt: 0 } } : {}),
    };

    const [items, total] = await Promise.all([
      db.customer.findMany({
        where,
        include: {
          territory: { select: { id: true, name: true, colour: true } },
          assignedRep: { select: { id: true, name: true } },
        },
        orderBy: { name: "asc" },
        take: page.take,
        skip: page.skip,
      }),
      db.customer.count({ where }),
    ]);

    return ok(items, paginationMeta(page, total));
  },
);

const createSchema = z.object({
  name: z.string().min(2),
  code: z.string().optional(),
  type: z.enum(["RETAIL", "WHOLESALE", "DISTRIBUTOR", "INSTITUTION"]).optional(),
  segment: z.enum(["A", "B", "C"]).optional(),
  phone: z.string().optional(),
  email: z.string().email().optional().or(z.literal("")),
  address: z.string().optional(),
  town: z.string().optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  geofenceRadiusM: z.number().int().min(20).max(5000).optional(),
  creditLimitCents: z.number().int().nonnegative().optional(),
  paymentTermsDays: z.number().int().min(0).max(180).optional(),
  territoryId: z.string().optional(),
  assignedRepId: z.string().optional(),
  branchId: z.string().optional(),
  notes: z.string().optional(),
});

export const POST = handler(
  { permission: "customer:write" },
  async ({ principal, request }) => {
    const companyId = companyIdOf(principal);
    const input = await parseBody(request, createSchema);

    const customer = await db.customer.create({
      data: {
        companyId,
        code: input.code ?? (await nextNumber(companyId, "CUSTOMER")),
        name: input.name,
        type: input.type ?? "RETAIL",
        segment: input.segment ?? "C",
        phone: input.phone ?? null,
        email: input.email || null,
        address: input.address ?? null,
        town: input.town ?? null,
        latitude: input.latitude ?? null,
        longitude: input.longitude ?? null,
        geofenceRadiusM: input.geofenceRadiusM ?? 150,
        creditLimitCents: input.creditLimitCents ?? 0,
        paymentTermsDays: input.paymentTermsDays ?? 0,
        territoryId: input.territoryId ?? null,
        // A rep creating a customer in the field owns it by default.
        assignedRepId:
          input.assignedRepId ??
          (principal.role === "FIELD_REP" ? principal.userId : null),
        branchId: input.branchId ?? principal.branchId ?? null,
        notes: input.notes ?? null,
        createdById: principal.userId,
      },
    });

    await auditAs(principal, "CREATE", "Customer", customer.id, { name: customer.name }, request);
    return ok(customer, undefined, { status: 201 });
  },
);
