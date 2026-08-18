import { z } from "zod";

import { handler, ok, pagination, paginationMeta, parseBody } from "@/lib/api";
import { auditAs } from "@/lib/audit";
import { db } from "@/lib/db";
import { nextNumber } from "@/lib/numbering";
import { companyIdOf, scope } from "@/lib/tenant";

export const dynamic = "force-dynamic";

export const GET = handler(
  { permission: "supplier:read" },
  async ({ principal, searchParams }) => {
    const page = pagination(searchParams);
    const search = searchParams.get("q");

    const where = {
      ...scope(principal),
      ...(search
        ? { OR: [{ name: { contains: search } }, { code: { contains: search } }] }
        : {}),
    };

    const [items, total] = await Promise.all([
      db.supplier.findMany({
        where,
        include: { _count: { select: { purchaseOrders: true } } },
        orderBy: { name: "asc" },
        take: page.take,
        skip: page.skip,
      }),
      db.supplier.count({ where }),
    ]);

    return ok(items, paginationMeta(page, total));
  },
);

const schema = z.object({
  name: z.string().min(2),
  code: z.string().optional(),
  contactName: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().email().optional().or(z.literal("")),
  address: z.string().optional(),
  taxPin: z.string().optional(),
  paymentTermsDays: z.number().int().min(0).max(180).optional(),
});

export const POST = handler(
  { permission: "supplier:write" },
  async ({ principal, request }) => {
    const companyId = companyIdOf(principal);
    const input = await parseBody(request, schema);

    const supplier = await db.supplier.create({
      data: {
        companyId,
        code: input.code ?? (await nextNumber(companyId, "SUPPLIER")),
        name: input.name,
        contactName: input.contactName ?? null,
        phone: input.phone ?? null,
        email: input.email || null,
        address: input.address ?? null,
        taxPin: input.taxPin ?? null,
        paymentTermsDays: input.paymentTermsDays ?? 30,
      },
    });

    await auditAs(principal, "CREATE", "Supplier", supplier.id, { name: supplier.name }, request);
    return ok(supplier, undefined, { status: 201 });
  },
);
