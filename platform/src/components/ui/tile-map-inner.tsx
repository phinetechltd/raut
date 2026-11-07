"use client";

import "leaflet/dist/leaflet.css";
import { useEffect, useRef } from "react";

import {
  DEFAULT_EMPTY_CENTER,
  allCoordinates,
  dotPinHtml,
  pathPointsOf,
  popupHtml,
  resolveThemeColours,
  sequencePinHtml,
  toneColour,
  vehiclePinHtml,
  type TileMapProps,
} from "./map-shared";

export type { TileMapProps } from "./map-shared";

/**
 * OpenStreetMap basemap through Leaflet — no API key and no contract.
 *
 * Pins, territory fences and route legs come from stored coordinates. Leaflet
 * owns the container's DOM, so the caller mounts this client-only (see the
 * wrapper in tile-map.tsx) and re-renders by prop-driven reconciliation in the
 * effect below rather than by letting React diff inside the map.
 */
export default function TileMapInner({
  points,
  polygons = [],
  path = [],
  tracks = [],
  height = 380,
  zoom = 13,
  emptyCenter = DEFAULT_EMPTY_CENTER,
}: TileMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<import("leaflet").Map | null>(null);
  const layerRef = useRef<import("leaflet").LayerGroup | null>(null);

  // Mount once: create the Leaflet map and the tile layer.
  useEffect(() => {
    let cancelled = false;
    let cleanup: (() => void) | null = null;

    (async () => {
      const L = await import("leaflet");
      if (cancelled || !containerRef.current || mapRef.current) return;

      const map = L.map(containerRef.current, {
        zoomControl: true,
        scrollWheelZoom: true,
        worldCopyJump: false,
        // The fade runs on animation frames, which stop in a background tab. Tiles
        // would load and stay invisible, leaving pins on an empty map.
        fadeAnimation: false,
      }).setView([emptyCenter.lat, emptyCenter.lng], zoom - 2);

      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors',
        className: "raut-tiles",
      }).addTo(map);

      const layer = L.layerGroup().addTo(map);
      mapRef.current = map;
      layerRef.current = layer;

      cleanup = () => {
        map.remove();
        mapRef.current = null;
        layerRef.current = null;
      };
    })();

    return () => {
      cancelled = true;
      cleanup?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reconcile data → layers whenever the props change.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      const L = await import("leaflet");
      const map = mapRef.current;
      const layer = layerRef.current;
      if (cancelled || !map || !layer) return;

      layer.clearLayers();
      const theme = resolveThemeColours();

      for (const poly of polygons) {
        if (poly.vertices.length < 3) continue;
        L.polygon(
          poly.vertices.map(([lat, lng]) => [lat, lng] as [number, number]),
          {
            color: poly.colour,
            weight: 2,
            dashArray: "7 5",
            fillColor: poly.colour,
            fillOpacity: 0.08,
          },
        ).addTo(layer);
      }

      // Driven trails go under the plan: solid, so the dashed plan reads as
      // the intention and the solid line as what happened.
      for (const track of tracks) {
        if (track.coords.length < 2) continue;
        L.polyline(track.coords, {
          color: track.colour,
          weight: 3,
          opacity: 0.7,
          lineCap: "round",
          lineJoin: "round",
        }).addTo(layer);
      }

      const pathPoints = pathPointsOf(points, path);
      if (pathPoints.length > 1) {
        L.polyline(pathPoints.map((p) => [p.lat, p.lng] as [number, number]), {
          color: toneColour(theme, "neutral"),
          weight: 3.5,
          opacity: 0.85,
          dashArray: "9 6",
          lineCap: "round",
        }).addTo(layer);
      }

      for (const p of points) {
        const colour = toneColour(theme, p.tone);

        if (p.kind === "vehicle") {
          const icon = L.divIcon({
            className: "raut-vehicle-marker",
            html: vehiclePinHtml(colour, theme),
            iconSize: [26, 26],
            iconAnchor: [13, 13],
          });
          L.marker([p.lat, p.lng], { icon, zIndexOffset: 1000 })
            .bindPopup(popupHtml(p))
            .addTo(layer);
        } else if (p.sequence) {
          const icon = L.divIcon({
            className: "raut-seq-marker",
            html: sequencePinHtml(p.sequence, colour, theme),
            iconSize: [22, 22],
            iconAnchor: [11, 11],
          });
          L.marker([p.lat, p.lng], { icon })
            .bindPopup(popupHtml(p))
            .addTo(layer);
        } else {
          const icon = L.divIcon({
            className: "raut-dot-marker",
            html: dotPinHtml(colour, theme),
            iconSize: [15, 15],
            iconAnchor: [7.5, 7.5],
          });
          L.marker([p.lat, p.lng], { icon })
            .bindPopup(popupHtml(p))
            .addTo(layer);
        }
      }

      const all = allCoordinates(points, polygons, tracks);
      if (all.length === 1) {
        map.setView(all[0], zoom);
      } else if (all.length > 1) {
        map.fitBounds(L.latLngBounds(all), { padding: [28, 28] });
      }
      window.setTimeout(() => mapRef.current?.invalidateSize(), 60);
    })();

    return () => {
      cancelled = true;
    };
  }, [points, polygons, path, tracks, zoom]);

  return (
    <div
      ref={containerRef}
      className="raut-tilemap w-full overflow-hidden rounded-xl border border-border shadow-sm"
      style={{ height, background: "var(--surface-sunken)" }}
      role="region"
      aria-label={`Map with ${points.length} pin(s)`}
    />
  );
}
