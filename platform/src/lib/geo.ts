/**
 * Geo utilities for Modules 07 (Smart Routing) and 08 (Geofencing).
 *
 * Everything here runs in-process. The proposal excludes third-party APIs from
 * the platform price, so route optimisation and fence checks must not depend on
 * a Google Directions or Mapbox contract.
 */

export interface LatLng {
  lat: number;
  lng: number;
}

const EARTH_RADIUS_M = 6_371_000;

const toRad = (deg: number) => (deg * Math.PI) / 180;

/** Great-circle distance in metres. */
export function haversineM(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;

  return Math.round(2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h))));
}

/**
 * Straight-line distance under-reports real driving distance. Kenyan urban and
 * peri-urban road networks run roughly 1.35× the crow-flight distance, so
 * planning figures use that factor. It is a planning estimate, not a promise.
 */
export const ROAD_WINDING_FACTOR = 1.35;

/** Average field vehicle speed assumption, km/h, for ETA estimates. */
export const PLANNING_SPEED_KMH = 26;

export function roadDistanceM(a: LatLng, b: LatLng): number {
  return Math.round(haversineM(a, b) * ROAD_WINDING_FACTOR);
}

export function travelMinutes(distanceM: number): number {
  return Math.round((distanceM / 1000 / PLANNING_SPEED_KMH) * 60);
}

// ── geofencing ─────────────────────────────────────────────────────────

/** Circular fence test — used for customer pins. */
export function isWithinRadius(
  point: LatLng,
  centre: LatLng,
  radiusM: number,
): boolean {
  return haversineM(point, centre) <= radiusM;
}

/**
 * Ray-casting point-in-polygon. `polygon` is a list of [lat, lng] vertices;
 * the ring is closed implicitly. Longitude/latitude are treated as planar,
 * which is accurate enough at territory scale (tens of km).
 */
export function isInsidePolygon(point: LatLng, polygon: LatLng[]): boolean {
  if (polygon.length < 3) return false;

  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].lng;
    const yi = polygon[i].lat;
    const xj = polygon[j].lng;
    const yj = polygon[j].lat;

    const intersects =
      yi > point.lat !== yj > point.lat &&
      point.lng < ((xj - xi) * (point.lat - yi)) / (yj - yi) + xi;

    if (intersects) inside = !inside;
  }
  return inside;
}

/** Parses the JSON boundary column into vertices, tolerating malformed data. */
export function parseBoundary(raw: string | null | undefined): LatLng[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (p): p is [number, number] =>
          Array.isArray(p) &&
          p.length >= 2 &&
          Number.isFinite(p[0]) &&
          Number.isFinite(p[1]),
      )
      .map(([lat, lng]) => ({ lat, lng }));
  } catch {
    return [];
  }
}

export interface TerritoryFence {
  boundary?: string | null;
  centerLat?: number | null;
  centerLng?: number | null;
  radiusM?: number | null;
}

/**
 * A territory is fenced by its polygon when one is drawn, otherwise by its
 * centre + radius. Returns false when neither is configured, so an unfenced
 * territory never silently rejects a rep.
 */
export function isInsideTerritory(point: LatLng, territory: TerritoryFence): boolean {
  const polygon = parseBoundary(territory.boundary);
  if (polygon.length >= 3) return isInsidePolygon(point, polygon);

  if (
    territory.centerLat != null &&
    territory.centerLng != null &&
    territory.radiusM != null
  ) {
    return isWithinRadius(
      point,
      { lat: territory.centerLat, lng: territory.centerLng },
      territory.radiusM,
    );
  }
  return false;
}

export interface VisitVerification {
  verified: boolean;
  distanceM: number | null;
  reason: string;
}

/**
 * Module 08's core rule: a check-in counts only if it happened at the customer.
 * GPS accuracy is folded into the allowance, otherwise a rep standing at the
 * shop door with a 60 m fix gets marked absent by their own handset.
 */
export function verifyVisitLocation(
  checkIn: LatLng,
  customer: { latitude: number | null; longitude: number | null; geofenceRadiusM: number },
  accuracyM?: number | null,
): VisitVerification {
  if (customer.latitude == null || customer.longitude == null) {
    return {
      verified: false,
      distanceM: null,
      reason: "Customer has no GPS pin captured",
    };
  }

  const distanceM = haversineM(checkIn, {
    lat: customer.latitude,
    lng: customer.longitude,
  });
  const allowance = customer.geofenceRadiusM + Math.min(accuracyM ?? 0, 100);

  return distanceM <= allowance
    ? { verified: true, distanceM, reason: `Check-in ${distanceM}m from customer pin` }
    : {
        verified: false,
        distanceM,
        reason: `Check-in ${distanceM}m from customer pin, outside ${allowance}m allowance`,
      };
}

// ── route optimisation (Module 07) ─────────────────────────────────────

export interface RoutePoint extends LatLng {
  id: string;
}

export interface OptimisedRoute {
  order: string[];
  legs: Array<{ id: string; legDistanceM: number; legMin: number }>;
  totalDistanceM: number;
  totalMin: number;
}

/**
 * Nearest-neighbour construction followed by 2-opt improvement.
 *
 * Exact TSP is not worth solving for a rep's day — routes are 5–20 stops and
 * the road-winding estimate already dominates the error. Nearest-neighbour
 * alone leaves obvious crossings, which reps notice and distrust, so the 2-opt
 * pass earns its keep; it converges in milliseconds at this size.
 */
export function optimiseRoute(
  start: LatLng | null,
  points: RoutePoint[],
): OptimisedRoute {
  if (points.length === 0) {
    return { order: [], legs: [], totalDistanceM: 0, totalMin: 0 };
  }

  const origin = start ?? points[0];

  // 1. Nearest-neighbour construction
  const remaining = [...points];
  const tour: RoutePoint[] = [];
  let cursor: LatLng = origin;

  while (remaining.length > 0) {
    let bestIdx = 0;
    let bestDist = Number.POSITIVE_INFINITY;
    for (let i = 0; i < remaining.length; i++) {
      const d = haversineM(cursor, remaining[i]);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    const [next] = remaining.splice(bestIdx, 1);
    tour.push(next);
    cursor = next;
  }

  // 2. 2-opt: repeatedly reverse a segment when doing so shortens the path.
  const pathLength = (seq: RoutePoint[]): number => {
    let total = haversineM(origin, seq[0]);
    for (let i = 0; i < seq.length - 1; i++) {
      total += haversineM(seq[i], seq[i + 1]);
    }
    return total;
  };

  let improved = true;
  let guard = 0;
  while (improved && guard < 60) {
    improved = false;
    guard++;
    for (let i = 0; i < tour.length - 1; i++) {
      for (let j = i + 1; j < tour.length; j++) {
        const candidate = [
          ...tour.slice(0, i),
          ...tour.slice(i, j + 1).reverse(),
          ...tour.slice(j + 1),
        ];
        if (pathLength(candidate) + 1 < pathLength(tour)) {
          tour.splice(0, tour.length, ...candidate);
          improved = true;
        }
      }
    }
  }

  // 3. Emit legs using the road-distance estimate reps will actually drive.
  const legs: OptimisedRoute["legs"] = [];
  let prev: LatLng = origin;
  let totalDistanceM = 0;
  let totalMin = 0;

  for (const stop of tour) {
    const legDistanceM = roadDistanceM(prev, stop);
    const legMin = travelMinutes(legDistanceM);
    legs.push({ id: stop.id, legDistanceM, legMin });
    totalDistanceM += legDistanceM;
    totalMin += legMin;
    prev = stop;
  }

  return {
    order: tour.map((p) => p.id),
    legs,
    totalDistanceM,
    totalMin,
  };
}

/** Bounding box for a set of points, used to frame the console map. */
export function boundsOf(points: LatLng[]): {
  north: number;
  south: number;
  east: number;
  west: number;
  centre: LatLng;
} | null {
  if (points.length === 0) return null;
  let north = -90;
  let south = 90;
  let east = -180;
  let west = 180;
  for (const p of points) {
    north = Math.max(north, p.lat);
    south = Math.min(south, p.lat);
    east = Math.max(east, p.lng);
    west = Math.min(west, p.lng);
  }
  return {
    north,
    south,
    east,
    west,
    centre: { lat: (north + south) / 2, lng: (east + west) / 2 },
  };
}
