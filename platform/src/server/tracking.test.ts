import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  chronological,
  distanceVariance,
  downsample,
  dropInaccurate,
  routeProgress,
  speedKmh,
  stalenessLabel,
  stalenessSeconds,
  stalenessTone,
  trackColour,
  trailDistanceM,
} from "../lib/tracking";

describe("staleness", () => {
  const now = new Date("2026-11-04T10:00:00Z");

  it("counts seconds since the fix and never goes negative", () => {
    assert.equal(stalenessSeconds(new Date("2026-11-04T09:59:00Z"), now), 60);
    assert.equal(stalenessSeconds(new Date("2026-11-04T10:00:30Z"), now), 0);
  });

  it("tones: live under 15 min, quiet under an hour, offline beyond", () => {
    assert.equal(stalenessTone(0), "success");
    assert.equal(stalenessTone(14 * 60 + 59), "success");
    assert.equal(stalenessTone(15 * 60), "warning");
    assert.equal(stalenessTone(59 * 60 + 59), "warning");
    assert.equal(stalenessTone(60 * 60), "danger");
    assert.equal(stalenessTone(6 * 3600), "danger");
  });

  it("labels read naturally", () => {
    assert.equal(stalenessLabel(5), "just now");
    assert.equal(stalenessLabel(12 * 60), "12 min ago");
    assert.equal(stalenessLabel(3 * 3600), "3 h ago");
    assert.equal(stalenessLabel(2 * 86_400), "2 d ago");
  });
});

describe("downsample", () => {
  const points = Array.from({ length: 101 }, (_, i) => i);

  it("leaves a short trail alone", () => {
    assert.deepEqual(downsample(points.slice(0, 10), 2000), points.slice(0, 10));
  });

  it("thins evenly to the cap, keeping first and last", () => {
    const out = downsample(points, 11);
    assert.equal(out.length, 11);
    assert.equal(out[0], 0);
    assert.equal(out[out.length - 1], 100);
    assert.deepEqual(out, [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
  });

  it("is monotonic — order is preserved", () => {
    const out = downsample(points, 37);
    for (let i = 1; i < out.length; i++) assert.ok(out[i] > out[i - 1]);
    assert.equal(out.length, 37);
  });

  it("handles a cap below two", () => {
    assert.deepEqual(downsample(points, 1), [0]);
    assert.deepEqual(downsample(points, 0), []);
  });
});

describe("dropInaccurate", () => {
  it("drops fixes worse than 100 m and keeps unknown accuracy", () => {
    const rows = [
      { id: 1, accuracyM: 12 },
      { id: 2, accuracyM: 100 },
      { id: 3, accuracyM: 101 },
      { id: 4, accuracyM: null },
      { id: 5 },
    ];
    assert.deepEqual(dropInaccurate(rows).map((r) => r.id), [1, 2, 4, 5]);
  });
});

describe("trailDistanceM", () => {
  // 0.01° of longitude on the equator ≈ 1 111.95 m.
  const trail = [
    { lat: 0, lng: 0 },
    { lat: 0, lng: 0.01 },
    { lat: 0, lng: 0.02 },
  ];

  it("sums consecutive haversine legs", () => {
    const d = trailDistanceM(trail);
    assert.ok(Math.abs(d - 2224) < 10, `got ${d}`);
  });

  it("ignores jitter below the step threshold", () => {
    const parked = [
      { lat: 0, lng: 0 },
      { lat: 0.00001, lng: 0 }, // ~1.1 m
      { lat: 0, lng: 0.00001 },
      { lat: 0, lng: 0 },
    ];
    assert.equal(trailDistanceM(parked), 0);
  });

  it("is zero for fewer than two points", () => {
    assert.equal(trailDistanceM([]), 0);
    assert.equal(trailDistanceM([{ lat: 1, lng: 1 }]), 0);
  });

  it("does not depend on arrival order once sorted", () => {
    const shuffled = [
      { lat: 0, lng: 0.02, recordedAt: new Date(3000) },
      { lat: 0, lng: 0, recordedAt: new Date(1000) },
      { lat: 0, lng: 0.01, recordedAt: new Date(2000) },
    ];
    const sorted = chronological(shuffled);
    assert.deepEqual(sorted.map((p) => p.lng), [0, 0.01, 0.02]);
    assert.equal(trailDistanceM(sorted), trailDistanceM(trail));
    // Unsorted, the same three points "drive" 4.4 km — which is why sorting is not optional.
    assert.ok(trailDistanceM(shuffled) > trailDistanceM(sorted));
  });
});

describe("display helpers", () => {
  it("converts m/s to whole km/h and rejects nonsense", () => {
    assert.equal(speedKmh(10), 36);
    assert.equal(speedKmh(0), 0);
    assert.equal(speedKmh(null), null);
    assert.equal(speedKmh(-1), null);
    assert.equal(speedKmh(Number.NaN), null);
  });

  it("reports plan variance as a signed percentage", () => {
    assert.deepEqual(distanceVariance(10_000, 12_500), { deltaM: 2500, pct: 25 });
    assert.deepEqual(distanceVariance(10_000, 9_000), { deltaM: -1000, pct: -10 });
    assert.equal(distanceVariance(10_000, null), null);
    assert.equal(distanceVariance(0, 500), null);
  });

  it("route progress excludes skipped stops from the denominator", () => {
    const stops = [
      { status: "DONE" },
      { status: "DONE" },
      { status: "SKIPPED" },
      { status: "PENDING" },
      { status: "ARRIVED" },
    ];
    assert.deepEqual(routeProgress(stops), { done: 2, total: 4, skipped: 1 });
  });

  it("track colour is stable per key and a valid hex colour", () => {
    assert.equal(trackColour("rep-1"), trackColour("rep-1"));
    assert.match(trackColour("anything"), /^#[0-9A-Fa-f]{6}$/);
  });
});
