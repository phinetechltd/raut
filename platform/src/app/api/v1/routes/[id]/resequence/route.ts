import { z } from "zod";

import { badRequest, handler, notFound } from "@/lib/api";
import { auditAs } from "@/lib/audit";
import { db } from "@/lib/db";
import { scope } from "@/lib/tenant";
import { resequenceRoute } from "@/server/routing";

export const dynamic = "force-dynamic";

const schema = z.object({
  /** Where the rep is now. Omitted, the server uses their last breadcrumb. */
  latitude: z.number().min(-90).max(90).nullish(),
  longitude: z.number().min(-180).max(180).nullish(),
});

/**
 * Smart re-routing mid-day: re-sequences the stops still outstanding from
 * where the rep actually is, so after a skip or a detour the next stop is the
 * nearest one, not the one the morning plan said. Done and skipped stops keep
 * their sequence — the plan stays an honest record of the day.
 *
 * Reps may re-sequence their own route (the handset calls this after a skip);
 * managers any route in the company.
 */
export const POST = handler<{ id: string }>(
  { permission: "route:read" },
  async ({ principal, params, request }) => {
    const route = await db.route.findFirst({
      where: { id: params.id, ...scope(principal, { selfField: "repId" }) },
      select: { id: true, repId: true, companyId: true, status: true, totalDistanceM: true },
    });
    if (!route) throw notFound("Route not found");
    if (route.status === "COMPLETED" || route.status === "CANCELLED") {
      throw badRequest("A closed route cannot be re-sequenced");
    }

    // An empty body is the common case: "re-route me from wherever I am".
    const raw = (await request.text()).trim();
    let parsed: unknown = {};
    if (raw) {
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw badRequest("Request body must be valid JSON");
      }
    }
    const input = schema.parse(parsed);

    let from: { lat: number; lng: number } | null =
      input.latitude != null && input.longitude != null
        ? { lat: input.latitude, lng: input.longitude }
        : null;

    if (!from) {
      // The rep's most recent fix in the last two hours. Older than that the
      // van has moved on and the depot is the better guess.
      const ping = await db.locationPing.findFirst({
        where: {
          companyId: route.companyId,
          userId: route.repId,
          recordedAt: { gte: new Date(Date.now() - 2 * 3_600_000) },
        },
        orderBy: { recordedAt: "desc" },
        select: { latitude: true, longitude: true },
      });
      if (ping) from = { lat: ping.latitude, lng: ping.longitude };
    }

    const before = route.totalDistanceM;
    const updated = await resequenceRoute(route.id, from);

    await auditAs(
      principal,
      "UPDATE",
      "Route",
      route.id,
      { resequenced: true, from, distanceM: { from: before, to: updated.totalDistanceM } },
      request,
    );

    return { ...updated, previousDistanceM: before, origin: from };
  },
);
