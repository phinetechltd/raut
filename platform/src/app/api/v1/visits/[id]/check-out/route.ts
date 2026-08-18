import { z } from "zod";

import { handler, parseBody } from "@/lib/api";
import { auditAs } from "@/lib/audit";
import { companyIdOf } from "@/lib/tenant";
import { checkOut } from "@/server/field";

export const dynamic = "force-dynamic";

const schema = z.object({
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  outcome: z.string().optional(),
  notes: z.string().optional(),
  at: z.string().optional(),
});

export const POST = handler<{ id: string }>(
  { permission: "visit:write" },
  async ({ principal, params, request }) => {
    const companyId = companyIdOf(principal);
    const input = await parseBody(request, schema);

    const visit = await checkOut({
      visitId: params.id,
      companyId,
      userId: principal.userId,
      latitude: input.latitude ?? null,
      longitude: input.longitude ?? null,
      outcome: input.outcome ?? null,
      notes: input.notes ?? null,
      at: input.at ? new Date(input.at) : undefined,
    });

    await auditAs(
      principal,
      "UPDATE",
      "Visit",
      params.id,
      { action: "check-out", durationMin: visit.durationMin },
      request,
    );

    return visit;
  },
);
