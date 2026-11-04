"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Badge, Button, Callout, Card, Field, Input, SectionHeading, TileMap } from "@/components/ui";
import type { MapPoint } from "@/components/ui";
import {
  MAP_PROVIDER_LABELS,
  type MapClientConfig,
  type MapProvider,
} from "@/lib/maps";

import type { MapSettingsView } from "@/app/api/v1/settings/maps/route";

/**
 * Settings → Maps.
 *
 * One decision — which basemap — plus the Google credentials that decision
 * may need. The preview underneath renders through the very same component
 * the rest of the console uses, so if the key is wrong the admin sees Google
 * refuse it here, on this screen, and not on a rep's route page tomorrow.
 */
export function MapsForm({
  initial,
  preview,
  previewPoints,
}: {
  initial: MapSettingsView;
  preview: MapClientConfig;
  previewPoints: MapPoint[];
}) {
  const router = useRouter();
  const [view, setView] = useState(initial);
  const [provider, setProvider] = useState<MapProvider | "">(view.stored.provider ?? "");
  const [apiKey, setApiKey] = useState("");
  const [removeKey, setRemoveKey] = useState(false);
  const [mapId, setMapId] = useState(view.stored.googleMapId ?? "");
  const [message, setMessage] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [pending, start] = useTransition();

  const platformLabel = MAP_PROVIDER_LABELS[view.platform.defaultProvider];
  const effectiveLabel = MAP_PROVIDER_LABELS[view.effective.provider];
  const hasStoredKey = Boolean(view.stored.googleApiKeyHint);
  const googlePossible = hasStoredKey || view.platform.hasGoogleApiKey || apiKey.trim().length > 0;

  function save() {
    start(async () => {
      setMessage(null);
      const body: Record<string, unknown> = {
        provider: provider === "" ? null : provider,
        googleMapId: mapId,
      };
      if (removeKey) body.googleApiKey = "";
      else if (apiKey.trim()) body.googleApiKey = apiKey.trim();

      const res = await fetch("/api/v1/settings/maps", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage({ tone: "danger", text: json?.error?.message ?? "Could not save map settings" });
        return;
      }
      setView(json.data as MapSettingsView);
      setApiKey("");
      setRemoveKey(false);
      setMessage({ tone: "success", text: "Saved. Every map in the console now uses this setting." });
      // The Maps JavaScript API is loaded once per page with one key, so a
      // changed key or provider needs a fresh page to show in the preview.
      router.refresh();
    });
  }

  return (
    <div className="space-y-6">
      <Card className="p-5">
        <SectionHeading
          title="Map provider"
          description="Used by every map in the console — customers, field activity and routes — and by the field app's Directions buttons."
        />

        <div className="mt-4 flex flex-wrap items-center gap-2 text-sm">
          <span className="text-content-muted">Currently showing</span>
          <Badge tone={view.effective.provider === "GOOGLE" ? "accent" : "neutral"}>{effectiveLabel}</Badge>
          <span className="text-content-muted">
            {view.effective.providerSource === "company"
              ? "— chosen by this company"
              : `— the platform default (${platformLabel})`}
            {view.effective.provider === "GOOGLE" && view.effective.googleKeySource
              ? `, on ${view.effective.googleKeySource === "company" ? "this company's" : "the platform's"} key`
              : ""}
          </span>
        </div>

        {view.effective.warning ? (
          <div className="mt-4">
            <Callout tone="warning">{view.effective.warning}</Callout>
          </div>
        ) : null}

        <form
          className="mt-5 space-y-5"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <fieldset className="space-y-2">
            <legend className="mb-1 block text-sm font-medium">Basemap</legend>
            {[
              { value: "" as const, title: `Platform default (${platformLabel})`, blurb: "Follow whatever the platform administrator sets." },
              { value: "OSM" as const, title: MAP_PROVIDER_LABELS.OSM, blurb: "Community-maintained map tiles. No key, no quota, no cost." },
              { value: "GOOGLE" as const, title: MAP_PROVIDER_LABELS.GOOGLE, blurb: "Google's basemap and business labels. Needs a Google Maps API key with billing enabled." },
            ].map((opt) => (
              <label
                key={opt.value || "default"}
                className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 ${
                  provider === opt.value ? "border-accent/50 bg-accent/5" : "border-border"
                }`}
              >
                <input
                  type="radio"
                  name="provider"
                  className="mt-1"
                  value={opt.value}
                  checked={provider === opt.value}
                  onChange={() => setProvider(opt.value)}
                />
                <span>
                  <span className="block text-sm font-medium">{opt.title}</span>
                  <span className="block text-xs text-content-muted">{opt.blurb}</span>
                </span>
              </label>
            ))}
          </fieldset>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Google Maps API key"
              hint={
                hasStoredKey
                  ? `A key is stored (${view.stored.googleApiKeyHint}). Leave blank to keep it.`
                  : view.platform.hasGoogleApiKey
                    ? "Optional — the platform provides a key. Add your own to bill usage to your account."
                    : "A browser key from Google Cloud with the Maps JavaScript API enabled."
              }
            >
              <Input
                type="password"
                autoComplete="off"
                value={apiKey}
                disabled={removeKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={hasStoredKey ? "•••••• (unchanged)" : "AIza…"}
              />
              {hasStoredKey ? (
                <label className="mt-2 flex items-center gap-2 text-xs text-content-muted">
                  <input
                    type="checkbox"
                    checked={removeKey}
                    onChange={(e) => {
                      setRemoveKey(e.target.checked);
                      if (e.target.checked) setApiKey("");
                    }}
                  />
                  Remove this company&apos;s stored key
                </label>
              ) : null}
            </Field>

            <Field
              label="Google Map ID (optional)"
              hint="From Google Cloud → Map management. Needed for production use of styled pins; without one Google's demo map style is used."
            >
              <Input
                value={mapId}
                autoComplete="off"
                onChange={(e) => setMapId(e.target.value)}
                placeholder={view.platform.hasGoogleMapId ? "Platform default in use" : ""}
              />
            </Field>
          </div>

          {provider === "GOOGLE" && !googlePossible ? (
            <Callout tone="warning">
              Google Maps needs an API key. Paste one above, or ask your platform administrator to set
              one for all companies.
            </Callout>
          ) : null}

          <Callout tone="info" title="Keep the key restricted">
            In Google Cloud, restrict the key to this console&apos;s web address (an HTTP referrer
            restriction) and to the Maps JavaScript API. The key is sent to every browser that opens
            a map, which is how Google&apos;s maps work — restriction is what stops someone else
            billing your account with it.
          </Callout>

          {message ? <Callout tone={message.tone}>{message.text}</Callout> : null}

          <div className="flex gap-2">
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : "Save map settings"}
            </Button>
          </div>
        </form>
      </Card>

      <div>
        <SectionHeading
          title="Preview"
          description={`What the console draws right now, on ${effectiveLabel}. Branch pins are shown where captured.`}
        />
        <TileMap points={previewPoints} map={preview} height={320} />
      </div>
    </div>
  );
}
