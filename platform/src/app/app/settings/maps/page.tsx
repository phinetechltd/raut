import { notFound } from "next/navigation";

import { PageHeader } from "@/components/ui";
import type { MapPoint } from "@/components/ui";
import { db } from "@/lib/db";
import {
  MAP_PROVIDERS,
  MAP_PROVIDER_LABELS,
  maskKey,
  toClientConfig,
} from "@/lib/maps";
import { can } from "@/lib/rbac";
import { requireTenant } from "@/lib/session";
import { mapConfigFor, platformMapDefaults, readStoredMapSettings } from "@/server/maps";

import { MapsForm } from "./maps-form";

export const dynamic = "force-dynamic";

/**
 * Settings → Maps. Which basemap this company's console and field app use.
 *
 * Gated like the payments page: a rep's API call is refused anyway, but a
 * form that renders and then fails on save teaches people the system is
 * flaky, so the page 404s for anyone without `settings:write`.
 */
export default async function MapSettingsPage() {
  const { companyId, principal } = await requireTenant();
  if (!can(principal, "settings:write")) notFound();

  const [stored, effective, branches] = await Promise.all([
    readStoredMapSettings(companyId),
    mapConfigFor(companyId),
    db.branch.findMany({
      where: { companyId, latitude: { not: null }, longitude: { not: null } },
      select: { id: true, name: true, latitude: true, longitude: true, isPrimary: true },
      orderBy: { name: "asc" },
    }),
  ]);
  const platform = platformMapDefaults();

  const previewPoints: MapPoint[] = branches.map((b) => ({
    id: b.id,
    lat: b.latitude!,
    lng: b.longitude!,
    label: b.name,
    tone: b.isPrimary ? "success" : "neutral",
  }));

  return (
    <>
      <PageHeader
        title="Maps"
        description="Choose between OpenStreetMap and Google Maps for every map Raut draws for this company."
      />
      <MapsForm
        initial={{
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
        }}
        preview={toClientConfig(effective)}
        previewPoints={previewPoints}
      />
    </>
  );
}
