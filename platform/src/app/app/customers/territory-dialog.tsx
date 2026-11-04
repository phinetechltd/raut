"use client";

import { useState } from "react";

import {
  apiClient,
  useFormSubmit,
  Button,
  Field,
  Input,
  ModalButton,
} from "@/components/ui";

/** Create a territory with a circular fence. Polygon fences are edited on the map in the routing module. */
export function TerritoryDialog() {
  return (
    <ModalButton
      label="+ New territory"
      title="New territory"
      description="A circular fence to start: centre coordinates plus a radius. Group customers by it, then verify check-ins inside it."
      variant="secondary"
      width="max-w-lg"
    >
      {(close) => <TerritoryForm onClose={() => close()} />}
    </ModalButton>
  );
}

const COLOURS = ["#076C80", "#2A8110", "#B45309", "#7C3AED", "#1F6FB2", "#BE185D"];

function TerritoryForm({ onClose }: { onClose: () => void }) {
  const { busy, error, submit } = useFormSubmit();
  const [form, setForm] = useState({
    name: "",
    code: "",
    colour: COLOURS[0],
    centerLat: "",
    centerLng: "",
    radiusKm: "3",
  });
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));

  async function save() {
    await submit(async () => {
      const lat = Number(form.centerLat);
      const lng = Number(form.centerLng);
      return await apiClient("/api/v1/territories", {
        method: "POST",
        body: {
          name: form.name.trim(),
          code: form.code.trim(),
          colour: form.colour,
          ...(Number.isFinite(lat) && Number.isFinite(lng) && form.centerLat.trim() !== "" && form.centerLng.trim() !== ""
            ? { centerLat: lat, centerLng: lng, radiusM: Math.round(Number(form.radiusKm) * 1000) }
            : {}),
        },
      });
    }, { onSuccess: onClose });
  }

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name" htmlFor="ter-name" required>
          <Input id="ter-name" value={form.name} onChange={(e) => set("name", e.target.value)} required minLength={2} placeholder="Nairobi Central" />
        </Field>
        <Field label="Code" htmlFor="ter-code" required hint="Short code, e.g. NBO-C">
          <Input id="ter-code" value={form.code} onChange={(e) => set("code", e.target.value)} required />
        </Field>
      </div>

      <Field label="Colour" htmlFor="ter-colour" hint="Used for fences on the map and pins in the list">
        <div className="flex items-center gap-2">
          {COLOURS.map((c) => (
            <button
              key={c}
              type="button"
              aria-label={`Territory colour ${c}`}
              onClick={() => set("colour", c)}
              className={`h-7 w-7 rounded-full transition-transform ${form.colour === c ? "scale-110 ring-2 ring-focus ring-offset-2 ring-offset-surface" : ""}`}
              style={{ background: c }}
            />
          ))}
        </div>
      </Field>

      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Centre latitude" htmlFor="ter-lat">
          <Input id="ter-lat" type="number" step="any" value={form.centerLat} onChange={(e) => set("centerLat", e.target.value)} placeholder="-1.2864" />
        </Field>
        <Field label="Centre longitude" htmlFor="ter-lng">
          <Input id="ter-lng" type="number" step="any" value={form.centerLng} onChange={(e) => set("centerLng", e.target.value)} placeholder="36.8172" />
        </Field>
        <Field label="Radius (km)" htmlFor="ter-radius">
          <Input id="ter-radius" type="number" min={0.1} max={200} step="0.1" value={form.radiusKm} onChange={(e) => set("radiusKm", e.target.value)} />
        </Field>
      </div>

      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <div className="flex items-center justify-end gap-2 border-t border-border pt-3">
        <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={busy || !form.name.trim() || !form.code.trim()}>
          {busy ? "Saving…" : "Create territory"}
        </Button>
      </div>
    </form>
  );
}
