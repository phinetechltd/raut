"use client";
/// <reference types="google.maps" />

import { useEffect, useRef } from "react";

import type { GoogleMapOptions } from "@/lib/maps";

import { loadGoogleMaps, onGoogleMapsUnavailable } from "./google-maps-loader";
import {
  DEFAULT_EMPTY_CENTER,
  allCoordinates,
  dotPinHtml,
  escapeHtml,
  pathPointsOf,
  resolveThemeColours,
  sequencePinHtml,
  toneColour,
  type TileMapProps,
} from "./map-shared";

/**
 * Google Maps basemap — the Maps JavaScript API, driven by the same props as
 * the Leaflet renderer so pages do not know which one they got.
 *
 * Advanced Markers are used for pins because they take arbitrary HTML, which
 * lets the numbered stop pin be the very same markup Leaflet mounts. They
 * require a Map ID; the admin can supply one, and until then Google's
 * DEMO_MAP_ID keeps the map working in development.
 *
 * `onUnavailable` is called when Google rejects the key or the script never
 * arrives. The wrapper then swaps to OpenStreetMap, so a billing lapse
 * degrades to a different basemap rather than a blank panel.
 */
export default function GoogleMapInner({
  points,
  polygons = [],
  path = [],
  height = 380,
  zoom = 13,
  emptyCenter = DEFAULT_EMPTY_CENTER,
  google: options,
  onUnavailable,
}: TileMapProps & { google: GoogleMapOptions; onUnavailable: (reason: string) => void }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const overlaysRef = useRef<Array<{ remove: () => void }>>([]);
  const infoRef = useRef<google.maps.InfoWindow | null>(null);
  // Resolves once the map exists, so the reconcile effect can wait on it.
  const mapReadyRef = useRef<Promise<google.maps.Map | null> | null>(null);
  // Once Google has rejected the key it tears the map's DOM down itself.
  // Touching markers after that throws from inside Google's code, so every
  // path that would call into the API checks this first.
  const deadRef = useRef(false);

  const clearOverlays = () => {
    const overlays = overlaysRef.current;
    overlaysRef.current = [];
    if (deadRef.current) return;
    for (const o of overlays) {
      try {
        o.remove();
      } catch {
        // A marker whose map Google already destroyed; nothing left to remove.
      }
    }
  };

  // Mount once: load the API and create the map.
  useEffect(() => {
    let cancelled = false;
    const stopListening = onGoogleMapsUnavailable((reason) => {
      deadRef.current = true;
      if (!cancelled) onUnavailable(reason);
    });

    mapReadyRef.current = loadGoogleMaps(options.apiKey)
      .then(async (g) => {
        await g.maps.importLibrary("maps");
        await g.maps.importLibrary("marker");
        if (cancelled || !containerRef.current || mapRef.current) return mapRef.current;

        const map = new g.maps.Map(containerRef.current, {
          center: emptyCenter,
          zoom: zoom - 2,
          mapId: options.mapId ?? "DEMO_MAP_ID",
          mapTypeControl: false,
          streetViewControl: false,
          fullscreenControl: true,
          clickableIcons: false,
          backgroundColor: "transparent",
        });
        mapRef.current = map;
        infoRef.current = new g.maps.InfoWindow();

        // Draw nothing until the first tiles arrive. Tiles only come when
        // Google has accepted the key, and a rejected key makes Google tear
        // the map's DOM down asynchronously — markers created before that
        // moment then throw from inside Google's own code. Waiting costs a
        // few hundred milliseconds on a good key and avoids the race entirely
        // on a bad one.
        const accepted = await new Promise<boolean>((resolve) => {
          const once = g.maps.event.addListenerOnce(map, "tilesloaded", () => {
            stop();
            resolve(true);
          });
          const stop = onGoogleMapsUnavailable(() => {
            once.remove();
            resolve(false);
          });
        });
        return accepted && !cancelled ? map : null;
      })
      .catch((error: unknown) => {
        deadRef.current = true;
        if (!cancelled) onUnavailable(error instanceof Error ? error.message : String(error));
        return null;
      });

    return () => {
      cancelled = true;
      stopListening();
      clearOverlays();
      if (!deadRef.current) {
        try {
          infoRef.current?.close();
        } catch {
          // Same as above: Google may already have torn the window down.
        }
      }
      infoRef.current = null;
      // The API has no destroy(); dropping the reference and the DOM node is
      // the documented way to release a map.
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reconcile data → overlays whenever the props change.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      const map = await mapReadyRef.current;
      if (cancelled || !map || deadRef.current) return;
      const g = (window as Window & { google?: typeof google }).google;
      if (!g) return;
      const { AdvancedMarkerElement } = (await g.maps.importLibrary(
        "marker",
      )) as google.maps.MarkerLibrary;
      if (cancelled || deadRef.current) return;

      clearOverlays();
      const theme = resolveThemeColours();
      const info = infoRef.current;

      try {
        drawOverlays({ g, map, AdvancedMarkerElement, theme, info });
      } catch (error) {
        // Google rejecting the key mid-draw surfaces here as a TypeError from
        // inside its own code. Treat it as the provider being unavailable.
        deadRef.current = true;
        onUnavailable(error instanceof Error ? error.message : "Google Maps failed while drawing");
      }
    })();

    function drawOverlays({
      g,
      map,
      AdvancedMarkerElement,
      theme,
      info,
    }: {
      g: typeof google;
      map: google.maps.Map;
      AdvancedMarkerElement: typeof google.maps.marker.AdvancedMarkerElement;
      theme: ReturnType<typeof resolveThemeColours>;
      info: google.maps.InfoWindow | null;
    }) {
      for (const poly of polygons) {
        if (poly.vertices.length < 3) continue;
        const polygon = new g.maps.Polygon({
          map,
          paths: poly.vertices.map(([lat, lng]) => ({ lat, lng })),
          strokeColor: poly.colour,
          strokeOpacity: 0.9,
          strokeWeight: 2,
          fillColor: poly.colour,
          fillOpacity: 0.08,
          clickable: false,
        });
        overlaysRef.current.push({ remove: () => polygon.setMap(null) });
      }

      const pathPoints = pathPointsOf(points, path);
      if (pathPoints.length > 1) {
        // Dashed line: a zero-opacity stroke carrying a repeated dash symbol.
        const line = new g.maps.Polyline({
          map,
          path: pathPoints.map((p) => ({ lat: p.lat, lng: p.lng })),
          strokeOpacity: 0,
          clickable: false,
          icons: [
            {
              icon: {
                path: "M 0,-1 0,1",
                strokeOpacity: 0.85,
                strokeColor: toneColour(theme, "neutral"),
                strokeWeight: 3.5,
                scale: 3,
              },
              offset: "0",
              repeat: "15px",
            },
          ],
        });
        overlaysRef.current.push({ remove: () => line.setMap(null) });
      }

      for (const p of points) {
        const colour = toneColour(theme, p.tone);
        const content = document.createElement("div");
        content.className = p.sequence ? "raut-seq-marker" : "raut-dot-marker";
        content.innerHTML = p.sequence
          ? sequencePinHtml(p.sequence, colour, theme)
          : dotPinHtml(colour, theme);
        // Leaflet anchors its icons at the centre; Advanced Markers anchor at
        // the bottom-centre. Shift so both renderers put the dot on the point.
        content.style.transform = p.sequence ? "translateY(11px)" : "translateY(7.5px)";

        const marker = new AdvancedMarkerElement({
          map,
          position: { lat: p.lat, lng: p.lng },
          content,
          title: p.label,
        });
        marker.addEventListener("gmp-click", () => {
          if (!info || deadRef.current) return;
          info.setContent(
            `<div class="raut-gm-popup"><strong>${escapeHtml(p.label)}</strong>${
              p.sequence ? `<br>Stop ${p.sequence}` : ""
            }</div>`,
          );
          info.open({ map, anchor: marker });
        });
        overlaysRef.current.push({
          remove: () => {
            marker.map = null;
          },
        });
      }

      const all = allCoordinates(points, polygons);
      if (all.length === 1) {
        map.setCenter({ lat: all[0][0], lng: all[0][1] });
        map.setZoom(zoom);
      } else if (all.length > 1) {
        const bounds = new g.maps.LatLngBounds();
        for (const [lat, lng] of all) bounds.extend({ lat, lng });
        map.fitBounds(bounds, 28);
      }
    }

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points, polygons, path, zoom]);

  return (
    <div
      ref={containerRef}
      className="raut-tilemap raut-tilemap-google w-full overflow-hidden rounded-xl border border-border shadow-sm"
      style={{ height, background: "var(--surface-sunken)" }}
      role="region"
      aria-label={`Map with ${points.length} pin(s)`}
    />
  );
}
