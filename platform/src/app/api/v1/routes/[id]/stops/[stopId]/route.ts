import { z } from "zod";

import { badRequest, handler, notFound, parseBody } from "@/lib/api";
import { auditAs } from "@/lib/audit";
import { db } from "@/lib/db";
import { scope } from "@/lib/tenant";
import { skipStop } from "@/server/routing";

export const dynamic = "force-dynamic";

const schema = z.object({
  status: z.literal("SKIPPED"),
  skipReason: z.string().trim().min(2, "Say why the stop was skipped").max(200),
});

/**
 * Skips a stop. The only status a client may set directly — ARRIVED and DONE
 * come from check-in and check-out, never from a request, so the evidence
 * trail stays honest. The matching visit becomes MISSED. Follow with
 * `POST /routes/:id/resequence` to re-order what is left from where the rep is.
 */
export const PATCH = handler<{ id: string; stopId: string }>(
  { permission: "route:read" },
  async ({ principal, params, request }) => {
    const route = await db.route.findFirst({
      where: { id: params.id, ...scope(principal, { selfField: "repId" }) },
      select: { id: true, companyId: true },
    });
    if (!route) throw notFound("Route not found");

    const input = await parseBody(request, schema);

    let stop;
    try {
      stop = await skipStop({
        routeId: route.id,
        stopId: params.stopId,
        companyId: route.companyId,
        reason: input.skipReason,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not skip the stop";
      if (message === "Stop not found") throw notFound(message);
      throw badRequest(message);
    }

    await auditAs(
      principal,
      "UPDATE",
      "RouteStop",
      stop.id,
      { status: "SKIPPED", skipReason: input.skipReason, routeId: route.id },
      request,
    );

    return stop;
  },
);
