"use client";

import { useActionState, useState } from "react";

import { MAP_PROVIDER_LABELS, type MapProvider } from "@/lib/maps";

import { setMapSettingsAction, type ActionState } from "../../actions";

/**
 * Super Admin's view of a tenant's map provider. Same decision as the
 * tenant's own Settings → Maps screen, exposed here so a company can be put
 * on Google Maps during onboarding without signing in as them.
 */
export function MapSettingsControl({
  companyId,
  stored,
  effective,
  platform,
}: {
  companyId: string;
  stored: { provider: MapProvider | null; googleApiKeyHint: string | null; googleMapId: string | null };
  effective: {
    provider: MapProvider;
    providerSource: "company" | "platform";
    googleKeySource: "company" | "platform" | null;
    warning: string | null;
  };
  platform: { defaultProvider: MapProvider; hasGoogleApiKey: boolean };
}) {
  const [state, action, pending] = useActionState<ActionState, FormData>(
    setMapSettingsAction,
    {},
  );
  const [removeKey, setRemoveKey] = useState(false);

  return (
    <form action={action} className="rounded-lg border border-border bg-surface p-5 shadow-sm">
      <input type="hidden" name="companyId" value={companyId} />

      <p className="text-sm">
        Showing <span className="font-medium">{MAP_PROVIDER_LABELS[effective.provider]}</span>
        <span className="text-content-muted">
          {effective.providerSource === "company"
            ? " — set by this company"
            : ` — platform default (${MAP_PROVIDER_LABELS[platform.defaultProvider]})`}
          {effective.provider === "GOOGLE" && effective.googleKeySource
            ? `, on ${effective.googleKeySource === "company" ? "the company's" : "the platform's"} key`
            : ""}
        </span>
      </p>
      {effective.warning ? (
        <p className="mt-2 text-xs text-warning">{effective.warning}</p>
      ) : null}

      <div className="mt-4 grid gap-4 sm:grid-cols-3">
        <label className="block text-sm">
          <span className="mb-1 block font-medium">Basemap</span>
          <select name="provider" defaultValue={stored.provider ?? ""} className="input">
            <option value="">Platform default ({MAP_PROVIDER_LABELS[platform.defaultProvider]})</option>
            <option value="OSM">{MAP_PROVIDER_LABELS.OSM}</option>
            <option value="GOOGLE">{MAP_PROVIDER_LABELS.GOOGLE}</option>
          </select>
        </label>

        <label className="block text-sm">
          <span className="mb-1 block font-medium">Google API key</span>
          <input
            name="googleApiKey"
            type="password"
            autoComplete="off"
            disabled={removeKey}
            className="input"
            placeholder={
              stored.googleApiKeyHint
                ? `${stored.googleApiKeyHint} (unchanged)`
                : platform.hasGoogleApiKey
                  ? "Optional — platform key available"
                  : "AIza…"
            }
          />
          {stored.googleApiKeyHint ? (
            <span className="mt-1 flex items-center gap-2 text-xs text-content-muted">
              <input
                type="checkbox"
                name="removeKey"
                checked={removeKey}
                onChange={(e) => setRemoveKey(e.target.checked)}
              />
              Remove the company&apos;s key
            </span>
          ) : null}
        </label>

        <label className="block text-sm">
          <span className="mb-1 block font-medium">Google Map ID</span>
          <input
            name="googleMapId"
            autoComplete="off"
            defaultValue={stored.googleMapId ?? ""}
            className="input"
            placeholder="Optional"
          />
        </label>
      </div>

      <div className="mt-4 flex items-center gap-3">
        <button type="submit" disabled={pending} className="btn bg-accent px-3 py-1.5 text-xs text-white hover:opacity-90">
          {pending ? "Saving…" : "Save map settings"}
        </button>
        {state.success ? <span className="text-xs text-accent">{state.success}</span> : null}
        {state.error ? <span className="text-xs text-danger">{state.error}</span> : null}
      </div>
    </form>
  );
}
