import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MAX_FIXES_PER_REQUEST,
  normaliseFix,
  normalisePayload,
  parseFixTime,
  trackerKeyFrom,
} from "./tracker-ingest";

const NOW = new Date("2026-11-06T10:00:00Z");
const good = { deviceId: "356307042441013", latitude: -1.2864, longitude: 36.8172, recordedAt: "2026-11-06T09:59:00Z" };

function reasonOf(raw: unknown): string | undefined {
  const result = normaliseFix(raw, 0, NOW);
  return "rejected" in result ? result.rejected.reason : undefined;
}

describe("normalisePayload", () => {
  it("accepts a positions list, a bare array and one flat object", () => {
    assert.equal(normalisePayload({ positions: [good, good] }, NOW).fixes.length, 2);
    assert.equal(normalisePayload([good], NOW).fixes.length, 1);
    assert.equal(normalisePayload(good, NOW).fixes.length, 1);
  });

  it("reads a Traccar forward and converts knots", () => {
    const { fixes } = normalisePayload(
      {
        device: { id: 7, uniqueId: "IMEI-7", name: "Van" },
        position: {
          deviceId: 7,
          latitude: -1.3,
          longitude: 36.8,
          speed: 10,
          course: 90,
          accuracy: 8,
          valid: true,
          fixTime: "2026-11-06T09:58:00.000+00:00",
          attributes: { ignition: true, batteryLevel: 88, odometer: 84210500, totalDistance: 999 },
        },
      },
      NOW,
    );
    assert.equal(fixes.length, 1);
    const fix = fixes[0];
    assert.equal(fix.deviceId, "IMEI-7");
    assert.ok(Math.abs(fix.speedMps! - 5.14444) < 1e-6);
    assert.equal(fix.ignition, true);
    assert.equal(fix.batteryPct, 88);
    assert.equal(fix.odometerKm, 84210.5);
    assert.equal(fix.heading, 90);
  });

  it("rejects an invalid Traccar position instead of plotting it", () => {
    const { fixes, rejected } = normalisePayload(
      { device: { uniqueId: "A" }, position: { latitude: -1, longitude: 36, valid: false, fixTime: good.recordedAt } },
      NOW,
    );
    assert.equal(fixes.length, 0);
    assert.equal(rejected[0].reason, "NO_GPS_FIX");
  });

  it("keeps the good fixes when one in the batch is bad", () => {
    const { fixes, rejected } = normalisePayload({ positions: [good, { ...good, latitude: 200 }, good] }, NOW);
    assert.equal(fixes.length, 2);
    assert.deepEqual(rejected, [{ index: 1, deviceId: good.deviceId, reason: "INVALID_COORDINATES" }]);
  });

  it("refuses a body that is not a position, and an oversized batch", () => {
    assert.equal(normalisePayload("hello", NOW).unreadable, true);
    assert.equal(normalisePayload(null, NOW).unreadable, true);
    assert.equal(normalisePayload(new Array(MAX_FIXES_PER_REQUEST + 1).fill(good), NOW).tooMany, true);
  });
});

describe("normaliseFix", () => {
  it("rejects what cannot be a position", () => {
    assert.equal(reasonOf("x"), "NOT_AN_OBJECT");
    assert.equal(reasonOf({ ...good, deviceId: "" }), "MISSING_DEVICE_ID");
    assert.equal(reasonOf({ ...good, deviceId: { nested: 1 } }), "MISSING_DEVICE_ID");
    assert.equal(reasonOf({ ...good, longitude: 181 }), "INVALID_COORDINATES");
    assert.equal(reasonOf({ ...good, latitude: "abc" }), "INVALID_COORDINATES");
  });

  it("rejects the 0,0 a unit reports before its first satellite lock", () => {
    assert.equal(reasonOf({ ...good, latitude: 0, longitude: 0 }), "INVALID_COORDINATES");
  });

  it("allows a small clock drift but not a broken clock", () => {
    assert.equal(reasonOf({ ...good, recordedAt: "2026-11-06T10:04:00Z" }), undefined);
    assert.equal(reasonOf({ ...good, recordedAt: "2026-11-06T10:06:00Z" }), "TIMESTAMP_IN_FUTURE");
    assert.equal(reasonOf({ ...good, recordedAt: "2026-09-01T00:00:00Z" }), "TIMESTAMP_TOO_OLD");
    assert.equal(reasonOf({ ...good, recordedAt: "yesterday-ish" }), "INVALID_TIMESTAMP");
    assert.equal(reasonOf({ ...good, recordedAt: undefined }), "INVALID_TIMESTAMP");
  });

  it("accepts common aliases and strings", () => {
    const result = normaliseFix(
      { imei: 356307042441013, lat: "-1.5", lon: "36.9", timestamp: 1793959140, speed: "36", bearing: 10, battery: 50, acc: 1 },
      0,
      new Date(1793959200_000),
    );
    assert.ok("fix" in result);
    if ("fix" in result) {
      assert.equal(result.fix.deviceId, "356307042441013");
      assert.equal(result.fix.latitude, -1.5);
      assert.equal(result.fix.speedMps, 10);
      assert.equal(result.fix.ignition, true);
      assert.equal(result.fix.batteryPct, 50);
    }
  });

  it("drops a glitched reading but keeps the position", () => {
    const result = normaliseFix({ ...good, speedKmh: 900, heading: 720, batteryPct: 300, odometerKm: -4 }, 0, NOW);
    assert.ok("fix" in result);
    if ("fix" in result) {
      assert.equal(result.fix.speedMps, null);
      assert.equal(result.fix.heading, null);
      assert.equal(result.fix.batteryPct, null);
      assert.equal(result.fix.odometerKm, null);
    }
  });

  it("reads speed in the unit the field names", () => {
    const speed = (extra: object) => {
      const r = normaliseFix({ ...good, ...extra }, 0, NOW);
      return "fix" in r ? r.fix.speedMps : undefined;
    };
    assert.equal(speed({ speedMps: 10 }), 10);
    assert.equal(speed({ speedKmh: 36 }), 10);
    assert.equal(speed({ speed: 36 }), 10);
    assert.ok(Math.abs(speed({ speedKnots: 10 })! - 5.14444) < 1e-6);
  });
});

describe("parseFixTime", () => {
  it("tells Unix seconds from milliseconds", () => {
    const iso = "2026-11-06T09:59:00.000Z";
    const ms = Date.parse(iso);
    assert.equal(parseFixTime(ms)?.toISOString(), iso);
    assert.equal(parseFixTime(ms / 1000)?.toISOString(), iso);
    assert.equal(parseFixTime(String(ms / 1000))?.toISOString(), iso);
    assert.equal(parseFixTime(iso)?.toISOString(), iso);
  });

  it("refuses nonsense", () => {
    assert.equal(parseFixTime(-1), null);
    assert.equal(parseFixTime(""), null);
    assert.equal(parseFixTime({}), null);
  });
});

describe("trackerKeyFrom", () => {
  const headers = (h: Record<string, string>) => new Headers(h);

  it("reads either header", () => {
    assert.equal(trackerKeyFrom(headers({ "x-api-key": "abc" })), "abc");
    assert.equal(trackerKeyFrom(headers({ authorization: "Bearer abc" })), "abc");
  });

  it("finds nothing otherwise", () => {
    assert.equal(trackerKeyFrom(headers({})), null);
    assert.equal(trackerKeyFrom(headers({ authorization: "Basic abc" })), null);
    assert.equal(trackerKeyFrom(headers({ authorization: "Bearer " })), null);
  });
});
