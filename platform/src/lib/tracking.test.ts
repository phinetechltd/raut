import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  dropTeleports,
  durationLabel,
  nairobiDay,
  nairobiDayBounds,
  pickVehicleFix,
  tripSummary,
  vehicleStatus,
} from "./tracking";

const NOW = new Date("2026-11-06T10:00:00Z");
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);

describe("vehicleStatus", () => {
  it("has no signal without a fix", () => {
    assert.equal(vehicleStatus(null, NOW), "NO_SIGNAL");
  });

  it("calls a fast van moving, with or without ignition data", () => {
    assert.equal(vehicleStatus({ recordedAt: ago(1), speedMps: 10 }, NOW), "MOVING");
    assert.equal(vehicleStatus({ recordedAt: ago(1), speedMps: 10, ignition: false }, NOW), "MOVING");
  });

  it("tells idling from parked by ignition", () => {
    assert.equal(vehicleStatus({ recordedAt: ago(1), speedMps: 0, ignition: true }, NOW), "IDLE");
    assert.equal(vehicleStatus({ recordedAt: ago(1), speedMps: 0, ignition: false }, NOW), "PARKED");
  });

  it("uses a phone's motion flag only when it has no speed", () => {
    assert.equal(vehicleStatus({ recordedAt: ago(1), isMoving: true }, NOW), "MOVING");
    assert.equal(vehicleStatus({ recordedAt: ago(1), speedMps: 0, isMoving: true }, NOW), "PARKED");
    assert.equal(vehicleStatus({ recordedAt: ago(1) }, NOW), "PARKED");
  });

  it("gives a parked van far longer before calling it offline", () => {
    assert.equal(vehicleStatus({ recordedAt: ago(90), speedMps: 10 }, NOW), "OFFLINE");
    assert.equal(vehicleStatus({ recordedAt: ago(90), ignition: false }, NOW), "PARKED");
    assert.equal(vehicleStatus({ recordedAt: ago(25 * 60), ignition: false }, NOW), "OFFLINE");
  });
});

describe("pickVehicleFix", () => {
  const at = (m: number) => ({ recordedAt: ago(m) });

  it("returns nothing with nothing", () => {
    assert.equal(pickVehicleFix(null, null), null);
  });

  it("uses whichever source exists", () => {
    assert.equal(pickVehicleFix(at(1), null)?.source, "TRACKER");
    assert.equal(pickVehicleFix(null, at(1))?.source, "PHONE");
  });

  it("prefers the tracker unless it has gone quiet while the phone kept going", () => {
    assert.equal(pickVehicleFix(at(5), at(1))?.source, "TRACKER");
    assert.equal(pickVehicleFix(at(1), at(5))?.source, "TRACKER");
    assert.equal(pickVehicleFix(at(30), at(1))?.source, "PHONE");
  });
});

describe("tripSummary", () => {
  // Roughly 1.1 km per 0.01 degrees of latitude.
  const point = (minute: number, lat: number, speedMps?: number) => ({
    lat,
    lng: 36.8,
    recordedAt: new Date(NOW.getTime() + minute * 60_000),
    speedMps,
  });

  it("is empty without fixes, and has no distance with one", () => {
    assert.equal(tripSummary([]).fixCount, 0);
    assert.equal(tripSummary([]).firstFixAt, null);
    assert.equal(tripSummary([point(0, -1.3)]).distanceM, 0);
  });

  it("measures distance and moving time, in any input order", () => {
    const summary = tripSummary([point(2, -1.28, 15), point(0, -1.3, 15), point(1, -1.29, 20)]);
    assert.ok(summary.distanceM > 2200 && summary.distanceM < 2250, String(summary.distanceM));
    assert.equal(summary.movingS, 120);
    assert.equal(summary.maxSpeedKmh, 72);
    assert.equal(summary.fixCount, 3);
    assert.equal(summary.firstFixAt?.getTime(), point(0, 0).recordedAt.getTime());
  });

  it("finds a stop and ignores a brief pause", () => {
    const summary = tripSummary([
      point(0, -1.3),
      point(1, -1.29),
      point(2, -1.29),
      point(12, -1.29),
      point(13, -1.28),
      point(14, -1.28),
      point(15, -1.27),
    ]);
    assert.equal(summary.stops.length, 1);
    assert.equal(summary.stops[0].durationS, 660);
  });

  it("counts a stop that runs to the end of the day", () => {
    const summary = tripSummary([point(0, -1.3), point(1, -1.29), point(20, -1.29)]);
    assert.equal(summary.stops.length, 1);
    assert.equal(summary.stops[0].durationS, 19 * 60);
  });

  it("does not count a long data gap as driving", () => {
    assert.equal(tripSummary([point(0, -1.3), point(60, -1.2)]).movingS, 0);
  });

  it("drops a single fix that jumps across town", () => {
    const points = [point(0, -1.3), point(1, -3.0), point(2, -1.29)];
    assert.equal(dropTeleports(points).length, 2);
    assert.ok(tripSummary(points).distanceM < 1200);
  });
});

describe("Nairobi days", () => {
  it("rolls over at Nairobi midnight, not UTC", () => {
    assert.equal(nairobiDay(new Date("2026-11-05T20:59:00Z")), "2026-11-05");
    assert.equal(nairobiDay(new Date("2026-11-05T21:00:00Z")), "2026-11-06");
  });

  it("bounds a day", () => {
    const bounds = nairobiDayBounds("2026-11-06");
    assert.equal(bounds?.start.toISOString(), "2026-11-05T21:00:00.000Z");
    assert.equal(bounds?.end.toISOString(), "2026-11-06T21:00:00.000Z");
  });

  it("refuses what is not a real date", () => {
    assert.equal(nairobiDayBounds("yesterday"), null);
    assert.equal(nairobiDayBounds("2026-02-31"), null);
    assert.equal(nairobiDayBounds("2026-13-01"), null);
  });
});

describe("durationLabel", () => {
  it("reads naturally", () => {
    assert.equal(durationLabel(45), "45 s");
    assert.equal(durationLabel(720), "12 min");
    assert.equal(durationLabel(7500), "2 h 05 min");
  });
});
