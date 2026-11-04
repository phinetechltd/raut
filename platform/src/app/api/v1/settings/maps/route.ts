import { z } from "zod";

import { ApiError, handler, parseBody } from "@/lib/api";
import { auditAs } from "@/lib/audit";
import {
  MAP_PROVIDERS,
  MAP_PROVIDER_LABELS,
  isPlausibleGoogleApiKey,
  isPlausibleGoogleMapId,
  maskKey,
  resolveMapConfig,
} from "@/lib/maps";
import { companyIdOf } from "@/lib/tenant";
import {
  mapConfigFor,
  platformMapDefaults,
  readStoredMapSettings,
  saveMapSettings,
} from "@/server/maps";

export const dynamic = "force-dynamic";

/**
 * A company's map provider: OpenStreetMap or Google Maps.
 *
 * GET returns what is stored, what the platform supplies, and the effective
 * result with its provenance, so the settings screen can say "Google Maps, on
 * the platform's key" rather than leaving the admin to work it out. The stored
 * Google key is returned masked; the full key only ever travels inside a
 * rendered map page, where the Maps JavaScript API needs it anyway.
 */
async function describe(companyId: string) {
  const [stored, effective] = await Promise.all([
    readStoredMapSettings(companyId),
    mapConfigFor(companyId),
  ]);
  const platform = platformMapDefaults();

  return {
    providers: MAP_PROVIDERS.map((key) => ({ key, label: MAP_PROVIDER_LABELS[key] })),
    stored: {
      provider: stored.provider,
      googleApiKeyHint: maskKey(stored.googleApiKey),
      googleMapId: stored.googleMapId,
    },
    platform: {
      defaultProvider: platform.provider,
      hasGoogleApiKey: Boolean(platform.googleApiKey),
      hasGoogleMapId: Boolean(platform.googleMapId),
    },
    effective: {
      provider: effective.provider,
      requested: effective.requested,
      providerSource: effective.providerSource,
      googleAvailable: effective.googleAvailable,
      googleKeySource: effective.google?.keySource ?? null,
      googleMapId: effective.google?.mapId ?? null,
      warning: effective.warning,
    },
  };
}

export type MapSettingsView = Awaited<ReturnType<typeof describe>>;

export const GET = handler({ permission: "settings:write" }, async ({ principal }) =>
  describe(companyIdOf(principal)),
);

const putSchema = z.object({
  /** `null` reverts to the platform default. */
  provider: z.enum(MAP_PROVIDERS).nullable().optional(),
  /** Empty string removes the stored key; omitted leaves it unchanged. */
  googleApiKey: z.string().max(200).optional(),
  googleMapId: z.string().max(100).optional(),
});

export const PUT = handler({ permission: "settings:write" }, async ({ principal, request }) => {
  const body = await parseBody(request, putSchema);
  const companyId = companyIdOf(principal);

  const apiKey = body.googleApiKey?.trim();
  if (apiKey && !isPlausibleGoogleApiKey(apiKey)) {
    throw new ApiError(
      422,
      "INVALID_GOOGLE_KEY",
      "That does not look like a Google Maps browser key. Keys start with “AIza” and are 39 characters long.",
    );
  }
  const mapId = body.googleMapId?.trim();
  if (mapId && !isPlausibleGoogleMapId(mapId)) {
    throw new ApiError(422, "INVALID_GOOGLE_MAP_ID", "That does not look like a Google Map ID.");
  }

  // Refuse a choice that cannot be honoured, rather than saving it and
  // silently showing OpenStreetMap. The admin finds out now, on this screen.
  if (body.provider === "GOOGLE") {
    const current = await readStoredMapSettings(companyId);
    const after = resolveMapConfig(
      {
        provider: "GOOGLE",
        googleApiKey:
          body.googleApiKey === undefined ? current.googleApiKey : apiKey || null,
        googleMapId: body.googleMapId === undefined ? current.googleMapId : mapId || null,
      },
      platformMapDefaults(),
    );
    if (!after.google) {
      throw new ApiError(
        422,
        "GOOGLE_KEY_REQUIRED",
        "Add a Google Maps API key before switching to Google Maps. Your platform administrator can also set one for every company.",
      );
    }
  }

  await saveMapSettings(companyId, {
    provider: body.provider,
    googleApiKey: body.googleApiKey === undefined ? undefined : apiKey || null,
    googleMapId: body.googleMapId === undefined ? undefined : mapId || null,
  });

  // The key is a billable credential: record that it changed, never what it is.
  await auditAs(
    principal,
    "UPDATE",
    "Setting",
    "maps",
    {
      provider: body.provider,
      googleApiKey:
        body.googleApiKey === undefined ? "unchanged" : apiKey ? "replaced" : "removed",
      googleMapId:
        body.googleMapId === undefined ? "unchanged" : mapId ? "set" : "removed",
    },
    request,
  );

  return describe(companyId);
});
