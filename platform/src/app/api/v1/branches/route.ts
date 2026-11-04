import { z } from "zod";

import { handler, ok, parseBody } from "@/lib/api";
import { auditAs } from "@/lib/audit";
import { db } from "@/lib/db";
import { companyIdOf, scope } from "@/lib/tenant";

export const dynamic = "force-dynamic";

export const GET = handler(
  { permission: "company:read" },
  async ({ principal }) => {
    return db.branch.findMany({
      where: { ...scope(principal) },
      include: { _count: { select: { users: true, customers: true } } },
      orderBy: { name: "asc" },
    });
  },
);

const createSchema = z.object({
  name: z.string().min(2),
  code: z.string().min(1),
  phone: z.string().optional(),
  address: z.string().optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
});

export const POST = handler(
  { permission: "branch:write" },
  async ({ principal, request }) => {
    const companyId = companyIdOf(principal);
    const input = await parseBody(request, createSchema);

    const branch = await db.branch.create({
      data: {
        companyId,
        name: input.name,
        code: input.code.toUpperCase(),
        phone: input.phone ?? null,
        address: input.address ?? null,
        latitude: input.latitude ?? null,
        longitude: input.longitude ?? null,
      },
    });

    await auditAs(principal, "CREATE", "Branch", branch.id, { name: branch.name }, request);
    return ok(branch, undefined, { status: 201 });
  },
);
