/**
 * Pretends to be a GPS tracker, for trying the integration without hardware.
 *
 * Sends an hour of driving across Nairobi ending now, with a ten-minute stop in
 * the middle, the way a real tracker platform would.
 *
 *   TRACKER_KEY=rtk_... node scripts/simulate-tracker.mjs <deviceId> [baseUrl]
 *
 * The key comes from Settings → Vehicle trackers. It is read from the environment
 * so it stays out of shell history and process listings. Safe to run repeatedly.
 */

const deviceId = process.argv[2];
const BASE = process.argv[3] ?? "http://localhost:3200";
const key = process.env.TRACKER_KEY;

if (!deviceId || !key) {
  console.error("Usage: TRACKER_KEY=rtk_... node scripts/simulate-tracker.mjs <deviceId> [baseUrl]");
  process.exit(1);
}

const START = { lat: -1.3192, lng: 36.8275 };
const END = { lat: -1.2345, lng: 36.8721 };
const MINUTES = 60;
const STOP_FROM = 25;
const STOP_UNTIL = 35;

const now = Date.now();
const drivingMinutes = MINUTES - (STOP_UNTIL - STOP_FROM);
let driven = 0;

const positions = [];
for (let minute = 0; minute <= MINUTES; minute++) {
  const stopped = minute > STOP_FROM && minute <= STOP_UNTIL;
  if (!stopped && minute > 0) driven++;
  const progress = driven / drivingMinutes;
  positions.push({
    deviceId,
    latitude: Number((START.lat + (END.lat - START.lat) * progress).toFixed(6)),
    longitude: Number((START.lng + (END.lng - START.lng) * progress).toFixed(6)),
    recordedAt: new Date(now - (MINUTES - minute) * 60_000).toISOString(),
    speedKmh: stopped ? 0 : 38 + (minute % 7) * 2,
    heading: 30,
    ignition: !stopped,
    batteryPct: 96,
    accuracyM: 6,
  });
}

const res = await fetch(`${BASE}/api/v1/tracking/ingest`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-Api-Key": key },
  body: JSON.stringify({ positions }),
});
const json = await res.json().catch(() => null);
console.log(res.status, JSON.stringify(json?.data ?? json?.error ?? null));
process.exit(res.ok ? 0 : 1);
