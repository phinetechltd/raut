import { handler } from "@/lib/api";
import { nairobiDay } from "@/lib/tracking";
import { vehicleTrack } from "@/server/trackers";

export const dynamic = "force-dynamic";

/** One vehicle's day: its trail, distance, moving time and stops. `?date=YYYY-MM-DD`. */
export const GET = handler<{ id: string }>(
  { permission: "vehicle:track" },
  async ({ principal, params, searchParams }) => {
    return vehicleTrack(principal, params.id, searchParams.get("date") ?? nairobiDay());
  },
);
