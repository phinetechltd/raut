import "server-only";

import { db } from "@/lib/db";
import {
  MAP_SETTING_KEYS,
  normaliseProvider,
  resolveMapConfig,
  type MapConfig,
  type MapProvider,
  type PlatformMapDefaults,
  type StoredMapSettings,
} from "@/lib/maps";

/**
 * Map provider settings — the database half of `src/lib/maps.ts`.
 *
 * Stored per company in the generic `Setting` table rather than as columns:
 * a basemap choice is configuration, not domain data, and the table exists
 * for exactly this. A company with no rows inherits the platform defaults.
 *
 * The Google key stored here is a *browser* key. It is sent to every console
 * page that draws a map, because that is how the Maps JavaScript API works,
 * so it is not treated as a secret in the vault sense — but it is a billable
 * credential, and the settings screens tell admins to restrict it to the
 * console's domain in Google Cloud. It is never written to the audit log.
 */

const KEYS = Object.values(MAP_SETTING_KEYS);

export function platformMapDefaults(): PlatformMapDefaults {
  return {
    provider: normaliseProvider(process.env.MAPS_DEFAULT_PROVIDER) ?? "OSM",
    googleApiKey: process.env.GOOGLE_MAPS_API_KEY?.trim() || null,
    googleMapId: process.env.GOOGLE_MAPS_MAP_ID?.trim() || null,
  };
}

export async function readStoredMapSettings(companyId: string): Promise<StoredMapSettings> {
  const rows = await db.setting.findMany({
    where: { companyId, key: { in: KEYS } },
    select: { key: true, value: true },
  });
  const byKey = new Map(rows.map((r) => [r.key, r.value]));

  return {
    provider: normaliseProvider(byKey.get(MAP_SETTING_KEYS.provider)),
    googleApiKey: byKey.get(MAP_SETTING_KEYS.googleApiKey)?.trim() || null,
    googleMapId: byKey.get(MAP_SETTING_KEYS.googleMapId)?.trim() || null,
  };
}

/** The effective configuration for a company — what its pages should render. */
export async function mapConfigFor(companyId: string): Promise<MapConfig> {
  const stored = await readStoredMapSettings(companyId);
  return resolveMapConfig(stored, platformMapDefaults());
}

export interface MapSettingsPatch {
  /** `null` reverts the company to the platform default. */
  provider?: MapProvider | null;
  /** `null` removes the company's stored key; `undefined` leaves it alone. */
  googleApiKey?: string | null;
  googleMapId?: string | null;
}

/**
 * Applies a partial update. Each field is independently "set", "clear" or
 * "leave alone", so a form that only changes the provider cannot wipe a key
 * the admin did not retype.
 */
export async function saveMapSettings(
  companyId: string,
  patch: MapSettingsPatch,
): Promise<StoredMapSettings> {
  const ops: Array<ReturnType<typeof upsert> | ReturnType<typeof clear>> = [];

  if (patch.provider !== undefined) {
    ops.push(
      patch.provider === null
        ? clear(companyId, MAP_SETTING_KEYS.provider)
        : upsert(companyId, MAP_SETTING_KEYS.provider, patch.provider),
    );
  }
  if (patch.googleApiKey !== undefined) {
    const value = patch.googleApiKey?.trim();
    ops.push(
      value
        ? upsert(companyId, MAP_SETTING_KEYS.googleApiKey, value)
        : clear(companyId, MAP_SETTING_KEYS.googleApiKey),
    );
  }
  if (patch.googleMapId !== undefined) {
    const value = patch.googleMapId?.trim();
    ops.push(
      value
        ? upsert(companyId, MAP_SETTING_KEYS.googleMapId, value)
        : clear(companyId, MAP_SETTING_KEYS.googleMapId),
    );
  }

  if (ops.length > 0) await db.$transaction(ops);
  return readStoredMapSettings(companyId);
}

function upsert(companyId: string, key: string, value: string) {
  return db.setting.upsert({
    where: { companyId_key: { companyId, key } },
    create: { companyId, key, value },
    update: { value },
  });
}

function clear(companyId: string, key: string) {
  return db.setting.deleteMany({ where: { companyId, key } });
}
