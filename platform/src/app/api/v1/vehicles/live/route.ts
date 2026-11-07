import { handler } from "@/lib/api";
import { fleetPositions } from "@/server/trackers";

export const dynamic = "force-dynamic";

/**
 * Where each vehicle is now, from its tracker or its driver's phone. The fleet
 * map polls this, and it is the read API for anything outside Raut that wants
 * the same picture. A field rep sees only the van they drive.
 */
export const GET = handler({ permission: "vehicle:track" }, async ({ principal }) => {
  const now = new Date();
  const vehicles = await fleetPositions(principal, now);
  return { asOf: now.toISOString(), vehicles };
});
