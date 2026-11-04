"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";

import { MAP_PROVIDER_LABELS, type MapClientConfig } from "@/lib/maps";

import type { TileMapProps } from "./map-shared";

export type { TileMapProps } from "./map-shared";

/**
 * The console's map. Picks the basemap the company's administrator chose —
 * OpenStreetMap (Leaflet) or Google Maps — and renders it client-only, since
 * both libraries own their container's DOM and must stay out of React's
 * hydration diff. `next/dynamic` with ssr:false is only legal in client
 * components, hence the wrapper.
 *
 * Pages obtain `map` from `mapConfigFor(companyId)` on the server and pass it
 * down. With no `map` the component is OpenStreetMap, so a page that forgets
 * still renders.
 */
const TileMapInner = dynamic(() => import("./tile-map-inner"), {
  ssr: false,
  loading: () => <MapSkeleton height={360} />,
});

const GoogleMapInner = dynamic(() => import("./google-map-inner"), {
  ssr: false,
  loading: () => <MapSkeleton height={360} />,
});

function MapSkeleton({ height }: { height: number }) {
  return (
    <div
      className="grid w-full place-items-center rounded-xl border border-border bg-surface-sunken"
      style={{ height }}
      aria-busy="true"
      aria-label="Loading map"
    >
      <span className="text-sm text-content-muted">Loading map…</span>
    </div>
  );
}

export interface TileMapComponentProps extends TileMapProps {
  map?: MapClientConfig | null;
}

export function TileMap({ map, ...props }: TileMapComponentProps) {
  // Set when Google could not be used after all; the map then re-renders on
  // OpenStreetMap and says so, rather than leaving a grey panel.
  const [fallbackReason, setFallbackReason] = useState<string | null>(null);
  const provider = map?.provider;
  const apiKey = map?.google?.apiKey;
  useEffect(() => setFallbackReason(null), [provider, apiKey]);

  const google = map?.provider === "GOOGLE" && map.google && !fallbackReason ? map.google : null;

  return (
    <div className="space-y-1.5">
      {google ? (
        <GoogleMapInner {...props} google={google} onUnavailable={setFallbackReason} />
      ) : (
        <TileMapInner {...props} />
      )}
      {fallbackReason ? (
        <p role="status" className="text-xs text-content-muted">
          {MAP_PROVIDER_LABELS.GOOGLE} is unavailable ({fallbackReason}); showing{" "}
          {MAP_PROVIDER_LABELS.OSM} instead. Check the key under Settings → Maps.
        </p>
      ) : null}
    </div>
  );
}
