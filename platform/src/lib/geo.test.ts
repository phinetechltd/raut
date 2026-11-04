import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  haversineM,
  isInsidePolygon,
  optimiseRoute,
  roadDistanceM,
  ROAD_WINDING_FACTOR,
  verifyVisitLocation,
  type LatLng,
  type RoutePoint,
} from "./geo";

const NAIROBI: LatLng = { lat: -1.2864, lng: 36.8172 };
const MOMBASA: LatLng = { lat: -4.0435, lng: 39.6682 };

/** Offsets in degrees from a base point; near the equator 1° ≈ 111 km both ways. */
function at(base: LatLng, dLat: number, dLng: number, id: string): RoutePoint {
  return { id, lat: base.lat + dLat, lng: base.lng + dLng };
}

/** Proper segment intersection (shared endpoints do not count). */
function segmentsCross(a: LatLng, b: LatLng, c: LatLng, d: LatLng): boolean {
  const cross = (p: LatLng, q: LatLng, r: LatLng) =>
    (q.lng - p.lng) * (r.lat - p.lat) - (q.lat - p.lat) * (r.lng - p.lng);
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

function hasCrossing(path: LatLng[]): boolean {
  for (let i = 0; i < path.length - 1; i++) {
    for (let j = i + 2; j < path.length - 1; j++) {
      if (segmentsCross(path[i], path[i + 1], path[j], path[j + 1])) return true;
    }
  }
  return false;
}

function pathLength(path: LatLng[]): number {
  let total = 0;
  for (let i = 1; i < path.length; i++) total += haversineM(path[i - 1], path[i]);
  return total;
}

/** Plain nearest-neighbour, to have something the optimiser must beat or match. */
function nearestNeighbour(start: LatLng, points: RoutePoint[]): RoutePoint[] {
  const remaining = [...points];
  const tour: RoutePoint[] = [];
  let cursor = start;
  while (remaining.length) {
    let best = 0;
    for (let i = 1; i < remaining.length; i++) {
      if (haversineM(cursor, remaining[i]) < haversineM(cursor, remaining[best])) best = i;
    }
    const [next] = remaining.splice(best, 1);
    tour.push(next);
    cursor = next;
  }
  return tour;
}

describe("haversineM", () => {
  it("is zero for the same point", () => {
    assert.equal(haversineM(NAIROBI, NAIROBI), 0);
  });

  it("measures one degree of longitude on the equator as ~111.2 km", () => {
    const d = haversineM({ lat: 0, lng: 0 }, { lat: 0, lng: 1 });
    assert.ok(Math.abs(d - 111_195) < 200, `got ${d}`);
  });

  it("puts Nairobi–Mombasa at about 440 km great-circle", () => {
    const d = haversineM(NAIROBI, MOMBASA);
    assert.ok(d > 435_000 && d < 445_000, `got ${d}`);
  });

  it("is symmetric", () => {
    assert.equal(haversineM(NAIROBI, MOMBASA), haversineM(MOMBASA, NAIROBI));
  });

  it("road distance applies the winding factor", () => {
    const crow = haversineM(NAIROBI, MOMBASA);
    assert.equal(roadDistanceM(NAIROBI, MOMBASA), Math.round(crow * ROAD_WINDING_FACTOR));
  });
});

describe("isInsidePolygon", () => {
  const square: LatLng[] = [
    { lat: 0, lng: 0 },
    { lat: 0, lng: 1 },
    { lat: 1, lng: 1 },
    { lat: 1, lng: 0 },
  ];

  it("accepts a point inside", () => {
    assert.equal(isInsidePolygon({ lat: 0.5, lng: 0.5 }, square), true);
  });

  it("rejects a point outside", () => {
    assert.equal(isInsidePolygon({ lat: 1.5, lng: 0.5 }, square), false);
    assert.equal(isInsidePolygon({ lat: 0.5, lng: -0.1 }, square), false);
  });

  it("handles a concave shape", () => {
    // An L: the notch at the top-right is outside even though its bounding box is not.
    const ell: LatLng[] = [
      { lat: 0, lng: 0 },
      { lat: 0, lng: 2 },
      { lat: 1, lng: 2 },
      { lat: 1, lng: 1 },
      { lat: 2, lng: 1 },
      { lat: 2, lng: 0 },
    ];
    assert.equal(isInsidePolygon({ lat: 1.5, lng: 1.5 }, ell), false);
    assert.equal(isInsidePolygon({ lat: 1.5, lng: 0.5 }, ell), true);
    assert.equal(isInsidePolygon({ lat: 0.5, lng: 1.5 }, ell), true);
  });

  it("is never inside a degenerate polygon", () => {
    assert.equal(isInsidePolygon({ lat: 0, lng: 0 }, square.slice(0, 2)), false);
  });
});

describe("verifyVisitLocation", () => {
  const shop = { latitude: NAIROBI.lat, longitude: NAIROBI.lng, geofenceRadiusM: 150 };
  // ~0.0016° of latitude is ~178 m.
  const nearby: LatLng = { lat: NAIROBI.lat + 0.0016, lng: NAIROBI.lng };

  it("verifies a fix inside the fence", () => {
    const r = verifyVisitLocation({ lat: NAIROBI.lat + 0.0005, lng: NAIROBI.lng }, shop, 10);
    assert.equal(r.verified, true);
    assert.ok(r.distanceM != null && r.distanceM < 150);
  });

  it("folds GPS accuracy into the allowance", () => {
    const sharp = verifyVisitLocation(nearby, shop, 10);
    assert.equal(sharp.verified, false, "178 m with a 10 m fix is outside 160 m");
    const fuzzy = verifyVisitLocation(nearby, shop, 40);
    assert.equal(fuzzy.verified, true, "178 m with a 40 m fix is inside 190 m");
  });

  it("caps the accuracy allowance at 100 m so a wild fix cannot verify anything", () => {
    // ~0.0024° ≈ 267 m: beyond 150 + 100 even with a 500 m accuracy claim.
    const far: LatLng = { lat: NAIROBI.lat + 0.0024, lng: NAIROBI.lng };
    const r = verifyVisitLocation(far, shop, 500);
    assert.equal(r.verified, false);
    assert.match(r.reason, /outside 250m allowance/);
  });

  it("cannot verify against a customer with no pin", () => {
    const r = verifyVisitLocation(nearby, { latitude: null, longitude: null, geofenceRadiusM: 150 });
    assert.equal(r.verified, false);
    assert.equal(r.distanceM, null);
    assert.match(r.reason, /no GPS pin/);
  });
});

describe("optimiseRoute", () => {
  it("returns an empty route for no points", () => {
    assert.deepEqual(optimiseRoute(NAIROBI, []), { order: [], legs: [], totalDistanceM: 0, totalMin: 0 });
  });

  it("orders stops along a line by distance from the start", () => {
    const points = [
      at(NAIROBI, 0.03, 0, "C"),
      at(NAIROBI, 0.01, 0, "A"),
      at(NAIROBI, 0.02, 0, "B"),
    ];
    const r = optimiseRoute(NAIROBI, points);
    assert.deepEqual(r.order, ["A", "B", "C"]);
    assert.equal(r.legs.length, 3);
    assert.equal(r.totalDistanceM, r.legs.reduce((s, l) => s + l.legDistanceM, 0));
    assert.equal(r.totalMin, r.legs.reduce((s, l) => s + l.legMin, 0));
    // Each leg is the road estimate of ~1.11 km crow-flight.
    for (const leg of r.legs) assert.ok(Math.abs(leg.legDistanceM - 1112 * ROAD_WINDING_FACTOR) < 30, `${leg.legDistanceM}`);
  });

  it("visits every stop exactly once", () => {
    const points = Array.from({ length: 9 }, (_, i) =>
      at(NAIROBI, Math.sin(i * 1.7) * 0.02, Math.cos(i * 2.3) * 0.02, `P${i}`),
    );
    const r = optimiseRoute(NAIROBI, points);
    assert.deepEqual([...r.order].sort(), points.map((p) => p.id).sort());
  });

  it("2-opt removes the crossing nearest-neighbour leaves behind", () => {
    // Nearest-neighbour from S goes A → B → D → C and the legs A–B and D–C
    // cross; a rep would never drive that. The fixture is scaled to ~1 km.
    const points = [
      at(NAIROBI, 0, 0.01, "A"),
      at(NAIROBI, 0.01, 0.011, "B"),
      at(NAIROBI, 0.0105, 0, "C"),
      at(NAIROBI, 0.005, 0.02, "D"),
    ];
    const nn = nearestNeighbour(NAIROBI, points);
    assert.deepEqual(nn.map((p) => p.id), ["A", "B", "D", "C"], "fixture no longer makes NN cross");
    assert.equal(hasCrossing([NAIROBI, ...nn]), true, "fixture no longer crosses");

    const r = optimiseRoute(NAIROBI, points);
    const byId = new Map(points.map((p) => [p.id, p]));
    const path = [NAIROBI, ...r.order.map((id) => byId.get(id)!)];
    assert.equal(hasCrossing(path), false, `optimised order ${r.order.join("→")} still crosses`);
    assert.ok(pathLength(path) <= pathLength([NAIROBI, ...nn]), "optimised path is no longer than NN");
  });

  it("never does worse than nearest-neighbour on a scattered day", () => {
    for (let seed = 1; seed <= 5; seed++) {
      const points = Array.from({ length: 8 }, (_, i) =>
        at(NAIROBI, Math.sin(seed * 7 + i * 1.3) * 0.03, Math.cos(seed * 3 + i * 2.1) * 0.03, `S${seed}P${i}`),
      );
      const nn = nearestNeighbour(NAIROBI, points);
      const r = optimiseRoute(NAIROBI, points);
      const byId = new Map(points.map((p) => [p.id, p]));
      const path = [NAIROBI, ...r.order.map((id) => byId.get(id)!)];
      assert.ok(pathLength(path) <= pathLength([NAIROBI, ...nn]) + 1, `seed ${seed}`);
      assert.equal(hasCrossing(path), false, `seed ${seed} crosses`);
    }
  });

  it("uses the first point as origin when no start is given", () => {
    const points = [at(NAIROBI, 0, 0, "A"), at(NAIROBI, 0.01, 0, "B")];
    const r = optimiseRoute(null, points);
    assert.equal(r.order[0], "A");
    assert.equal(r.legs[0].legDistanceM, 0);
  });
});
