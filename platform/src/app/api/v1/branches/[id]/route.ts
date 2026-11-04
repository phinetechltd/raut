import { z } from "zod";

import { handler, notFound, parseBody } from "@/lib/api";
import { auditAs, diff } from "@/lib/audit";
import { db } from "@/lib/db";
import { scope } from "@/lib/tenant";

export const dynamic = "force-dynamic";

const updateSchema = z.object({
  name: z.string().min(2).optional(),
  phone: z.string().nullable().optional(),
  address: z.string().nullable().optional(),
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
  active: z.boolean().optional(),
});

export const PATCH = handler<{ id: string }>(
  { permission: "branch:write" },
  async ({ principal, params, request }) => {
    const existing = await db.branch.findFirst({
      where: { id: params.id, ...scope(principal) },
    });
    if (!existing) throw notFound("Branch not found");

    const input = await parseBody(request, updateSchema);
    const data: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
      if (value === undefined) continue;
      data[key] = value === "" ? null : value;
    }

    const branch = await db.branch.update({ where: { id: params.id }, data });

    await auditAs(
      principal,
      "UPDATE",
      "Branch",
      branch.id,
      diff(existing as unknown as Record<string, unknown>, data),
      request,
    );
    return branch;
  },
);
