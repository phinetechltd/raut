import { z } from "zod";

import { handler, ok, parseBody } from "@/lib/api";
import { auditAs } from "@/lib/audit";
import { companyIdOf } from "@/lib/tenant";
import { checkIn } from "@/server/field";

export const dynamic = "force-dynamic";

const schema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  accuracyM: z.number().nonnegative().optional(),
  /** When the rep actually checked in — may predate the request if offline. */
  at: z.string().optional(),
});

/**
 * GPS check-in. Returns the verification verdict so the app can show the rep
 * immediately whether the visit counted, rather than letting them discover it
 * at month-end when their numbers are already disputed.
 */
export const POST = handler<{ id: string }>(
  { permission: "visit:write" },
  async ({ principal, params, request }) => {
    const companyId = companyIdOf(principal);
    const input = await parseBody(request, schema);

    const result = await checkIn({
      visitId: params.id,
      companyId,
      userId: principal.userId,
      latitude: input.latitude,
      longitude: input.longitude,
      accuracyM: input.accuracyM ?? null,
      at: input.at ? new Date(input.at) : undefined,
      geofencingEnabled: principal.enabledModules.has("GEOFENCING"),
    });

    await auditAs(
      principal,
      "UPDATE",
      "Visit",
      params.id,
      { action: "check-in", verified: result.verified, distanceM: result.distanceM },
      request,
    );

    return ok({
      visit: result.visit,
      verification: {
        verified: result.verified,
        distanceM: result.distanceM,
        reason: result.reason,
        enforced: principal.enabledModules.has("GEOFENCING"),
      },
    });
  },
);
