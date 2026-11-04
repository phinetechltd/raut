/**
 * Map provider selection.
 *
 * The console (and the field app's "Directions" links) can run on
 * OpenStreetMap or Google Maps. Which one is an administrator's decision, made
 * per company and stored in the `Setting` table; the deployment supplies a
 * platform-wide default and, optionally, a shared Google Maps key.
 *
 * Everything in this file is pure and safe to import from client components.
 * Database access lives in `src/server/maps.ts`.
 *
 * Why OpenStreetMap is the default: it carries no key, no quota and no
 * contract, so a fresh deployment shows real maps before anyone has set up a
 * Google Cloud project. Google Maps is offered because customers ask for it —
 * Kenyan premises are often better labelled there — but it is opt-in, and
 * when it is chosen without a usable key the map falls back to OpenStreetMap
 * instead of rendering a grey box.
 */

export const MAP_PROVIDERS = ["OSM", "GOOGLE"] as const;
export type MapProvider = (typeof MAP_PROVIDERS)[number];

export const MAP_PROVIDER_LABELS: Record<MapProvider, string> = {
  OSM: "OpenStreetMap",
  GOOGLE: "Google Maps",
};

/** `Setting.key` values. Namespaced so other settings can share the table. */
export const MAP_SETTING_KEYS = {
  provider: "maps.provider",
  googleApiKey: "maps.google_api_key",
  googleMapId: "maps.google_map_id",
} as const;

export function isMapProvider(value: unknown): value is MapProvider {
  return typeof value === "string" && (MAP_PROVIDERS as readonly string[]).includes(value);
}

/** Accepts "google", "Google Maps", "osm", "openstreetmap" …; null for anything else. */
export function normaliseProvider(value: unknown): MapProvider | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toUpperCase().replace(/[\s_-]+/g, "");
  if (v === "GOOGLE" || v === "GOOGLEMAPS") return "GOOGLE";
  if (v === "OSM" || v === "OPENSTREETMAP" || v === "OPENMAP" || v === "LEAFLET") return "OSM";
  return null;
}

/**
 * Browser keys for the Maps JavaScript API have had the same shape for over a
 * decade: `AIza` followed by 35 URL-safe characters. Checking it here turns
 * "the map is grey" into "that is not a Google API key" at save time.
 */
export const GOOGLE_API_KEY_PATTERN = /^AIza[0-9A-Za-z_-]{35}$/;

export function isPlausibleGoogleApiKey(value: string): boolean {
  return GOOGLE_API_KEY_PATTERN.test(value.trim());
}

/** Map IDs are short opaque identifiers from the Cloud console. */
export const GOOGLE_MAP_ID_PATTERN = /^[A-Za-z0-9_-]{4,64}$/;

export function isPlausibleGoogleMapId(value: string): boolean {
  return GOOGLE_MAP_ID_PATTERN.test(value.trim());
}

/** `AIzaSyD…Q4k` — enough to recognise a key, never enough to use it. */
export function maskKey(key: string | null | undefined): string | null {
  if (!key) return null;
  if (key.length <= 10) return "••••";
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}

// ── resolution ─────────────────────────────────────────────────────────

/** What a company has stored. Nulls mean "inherit the platform default". */
export interface StoredMapSettings {
  provider: MapProvider | null;
  googleApiKey: string | null;
  googleMapId: string | null;
}

/** What the deployment supplies through the environment. */
export interface PlatformMapDefaults {
  provider: MapProvider;
  googleApiKey: string | null;
  googleMapId: string | null;
}

export interface GoogleMapOptions {
  apiKey: string;
  /** Required for Advanced Markers in production; DEMO_MAP_ID is used when absent. */
  mapId: string | null;
}

/** The decision, with enough provenance for a settings screen to explain it. */
export interface MapConfig {
  /** What is actually rendered. */
  provider: MapProvider;
  /** What the administrator asked for (may differ from `provider` on fallback). */
  requested: MapProvider;
  providerSource: "company" | "platform";
  google: (GoogleMapOptions & { keySource: "company" | "platform" }) | null;
  /** True when a Google key exists somewhere, whether or not Google is selected. */
  googleAvailable: boolean;
  /** Set when the request could not be honoured, in words an admin can act on. */
  warning: string | null;
}

export function resolveMapConfig(
  stored: StoredMapSettings,
  defaults: PlatformMapDefaults,
): MapConfig {
  const requested = stored.provider ?? defaults.provider;
  const providerSource = stored.provider ? "company" : "platform";

  const apiKey = stored.googleApiKey || defaults.googleApiKey || null;
  const keySource: "company" | "platform" = stored.googleApiKey ? "company" : "platform";
  const mapId = stored.googleMapId || defaults.googleMapId || null;

  if (requested === "GOOGLE" && apiKey) {
    return {
      provider: "GOOGLE",
      requested,
      providerSource,
      google: { apiKey, mapId, keySource },
      googleAvailable: true,
      warning: null,
    };
  }

  return {
    provider: "OSM",
    requested,
    providerSource,
    google: null,
    googleAvailable: Boolean(apiKey),
    warning:
      requested === "GOOGLE"
        ? "Google Maps is selected but no API key is configured, so OpenStreetMap is shown instead."
        : null,
  };
}

/** The subset a map component needs. Safe to serialise into a page. */
export interface MapClientConfig {
  provider: MapProvider;
  google: GoogleMapOptions | null;
}

export function toClientConfig(config: MapConfig): MapClientConfig {
  return {
    provider: config.provider,
    google: config.google ? { apiKey: config.google.apiKey, mapId: config.google.mapId } : null,
  };
}

// ── external links ─────────────────────────────────────────────────────
// Mirrored in mobile/raut_field/lib/core/map_links.dart. Keep the two in step.

export interface LatLngLike {
  lat: number;
  lng: number;
}

const fix = (n: number) => n.toFixed(6);

/** Opens the point in the provider's own site or app, for a "View on map" link. */
export function externalMapUrl(provider: MapProvider, point: LatLngLike): string {
  const lat = fix(point.lat);
  const lng = fix(point.lng);
  return provider === "GOOGLE"
    ? `https://www.google.com/maps/search/?api=1&query=${lat}%2C${lng}`
    : `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=17/${lat}/${lng}`;
}

/** Turn-by-turn directions to the point from wherever the device is. */
export function directionsUrl(provider: MapProvider, point: LatLngLike): string {
  const lat = fix(point.lat);
  const lng = fix(point.lng);
  return provider === "GOOGLE"
    ? `https://www.google.com/maps/dir/?api=1&destination=${lat}%2C${lng}`
    : // OSM has no universal directions deep link; its site routes from the
      // "to" marker once the user picks a start.
      `https://www.openstreetmap.org/directions?to=${lat}%2C${lng}#map=15/${lat}/${lng}`;
}
