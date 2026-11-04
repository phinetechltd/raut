"use client";

import { useState } from "react";

import {
  apiClient,
  useFormSubmit,
  Button,
  Field,
  Input,
  ModalButton,
  Select,
} from "@/components/ui";

interface Option {
  id: string;
  name: string;
}

/**
 * Plan a route. The optimiser (nearest-neighbour + 2-opt pass) runs on the
 * server: this dialog picks the rep, the day and the territory to cover, and
 * the server sequences the stops and optionally creates the visits.
 */
export function RoutePlanDialog({
  reps,
  territories,
}: {
  reps: Option[];
  territories: Option[];
}) {
  return (
    <ModalButton
      label="+ Plan route"
      title="Plan a route"
      description="Stops are sequenced by distance from the rep's start, then held stable for the day. Optionally creates the visits."
      width="max-w-lg"
    >
      {(close) => <RouteForm reps={reps} territories={territories} onClose={() => close()} />}
    </ModalButton>
  );
}

function RouteForm({
  reps,
  territories,
  onClose,
}: {
  reps: Option[];
  territories: Option[];
  onClose: () => void;
}) {
  const { busy, error, submit } = useFormSubmit();
  const [form, setForm] = useState({
    repId: reps[0]?.id ?? "",
    routeDate: new Date().toISOString().slice(0, 10),
    name: "",
    territoryId: territories[0]?.id ?? "",
    startHour: "8",
    serviceMinutes: "20",
    createVisits: true,
  });
  const set = (k: keyof typeof form, v: string | boolean) => setForm((f) => ({ ...f, [k]: v }));

  async function save() {
    await submit(async () => {
      return await apiClient("/api/v1/routes", {
        method: "POST",
        body: {
          repId: form.repId,
          routeDate: form.routeDate,
          name: form.name || undefined,
          territoryId: form.territoryId || undefined,
          startHour: Number(form.startHour),
          serviceMinutes: Number(form.serviceMinutes),
          createVisits: form.createVisits,
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
        <Field label="Rep" htmlFor="rt-rep" required>
          <Select id="rt-rep" value={form.repId} onChange={(e) => set("repId", e.target.value)}>
            {reps.map((r) => (
              <option key={r.id} value={r.id}>{r.name}</option>
            ))}
          </Select>
        </Field>
        <Field label="Route date" htmlFor="rt-date" required>
          <Input id="rt-date" type="date" value={form.routeDate} onChange={(e) => set("routeDate", e.target.value)} required />
        </Field>
        <Field label="Territory to cover" htmlFor="rt-territory">
          <Select id="rt-territory" value={form.territoryId} onChange={(e) => set("territoryId", e.target.value)}>
            <option value="">— whole territory area —</option>
            {territories.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </Select>
        </Field>
        <Field label="Day name" htmlFor="rt-name" hint="Shown on the rep's phone">
          <Input id="rt-name" value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="Nairobi Central — Tuesday" />
        </Field>
        <Field label="Start hour" htmlFor="rt-start">
          <Select id="rt-start" value={form.startHour} onChange={(e) => set("startHour", e.target.value)}>
            {[6, 7, 8, 9, 10].map((h) => (
              <option key={h} value={h}>{String(h).padStart(2, "0")}:00</option>
            ))}
          </Select>
        </Field>
        <Field label="Minutes per stop" htmlFor="rt-service">
          <Select id="rt-service" value={form.serviceMinutes} onChange={(e) => set("serviceMinutes", e.target.value)}>
            {[10, 15, 20, 30, 45].map((m) => (
              <option key={m} value={m}>{m} min</option>
            ))}
          </Select>
        </Field>
      </div>

      <label className="flex items-center gap-2 text-sm font-medium">
        <input type="checkbox" checked={form.createVisits} onChange={(e) => set("createVisits", e.target.checked)} />
        Create the visit for every stop (recommended — drives the rep's day)
      </label>

      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <div className="flex items-center justify-end gap-2 border-t border-border pt-3">
        <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={busy || !form.repId}>
          {busy ? "Planning…" : "Plan route"}
        </Button>
      </div>
    </form>
  );
}
