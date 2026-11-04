import { handler } from "@/lib/api";
import { latestPositions } from "@/server/tracking";

export const dynamic = "force-dynamic";

/**
 * Where every rep is right now — one row per rep: their last fix since local
 * midnight, the vehicle they are in (via today's route), how stale the fix is,
 * speed and battery. The console's live-tracking map polls this.
 *
 * Reads sit under `geofence:read`, the same gate as the trail itself; a field
 * rep sees only their own row.
 */
export const GET = handler({ permission: "geofence:read" }, async ({ principal }) => {
  const now = new Date();
  const positions = await latestPositions(principal, now);
  return { asOf: now.toISOString(), positions };
});
