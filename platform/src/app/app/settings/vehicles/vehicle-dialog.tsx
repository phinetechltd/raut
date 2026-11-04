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
import { VEHICLE_TYPE_LABELS, VEHICLE_TYPES } from "@/lib/vehicles";

export interface VehicleShape {
  id?: string;
  plate: string;
  make?: string | null;
  model?: string | null;
  type?: string;
  branchId?: string | null;
  defaultRepId?: string | null;
  odometerKm?: number | null;
  active?: boolean;
}

interface Option {
  id: string;
  name: string;
}

/**
 * Add or edit a company vehicle. Plates are unique per company; the server
 * normalises case and spacing so "kda 123a" and "KDA 123A" are the same van.
 */
export function VehicleDialog({
  mode,
  vehicle,
  branches,
  reps,
}: {
  mode: "create" | "edit";
  vehicle?: VehicleShape;
  branches: Option[];
  reps: Option[];
}) {
  return (
    <ModalButton
      label={mode === "create" ? "+ Add vehicle" : "Edit"}
      title={mode === "create" ? "Add a vehicle" : `Edit ${vehicle?.plate ?? "vehicle"}`}
      description="Routes are planned against a vehicle, and its GPS trail is kept per plate."
      variant={mode === "edit" ? "ghost" : "primary"}
      width="max-w-md"
    >
      {(close) => (
        <VehicleForm mode={mode} vehicle={vehicle} branches={branches} reps={reps} onClose={() => close()} />
      )}
    </ModalButton>
  );
}

function VehicleForm({
  mode,
  vehicle,
  branches,
  reps,
  onClose,
}: {
  mode: "create" | "edit";
  vehicle?: VehicleShape;
  branches: Option[];
  reps: Option[];
  onClose: () => void;
}) {
  const { busy, error, submit } = useFormSubmit();
  const [form, setForm] = useState({
    plate: vehicle?.plate ?? "",
    make: vehicle?.make ?? "",
    model: vehicle?.model ?? "",
    type: vehicle?.type ?? "VAN",
    branchId: vehicle?.branchId ?? "",
    defaultRepId: vehicle?.defaultRepId ?? "",
    odometerKm: vehicle?.odometerKm != null ? String(vehicle.odometerKm) : "",
    active: vehicle?.active ?? true,
  });
  const set = (k: keyof typeof form, v: string | boolean) => setForm((f) => ({ ...f, [k]: v }));

  async function save() {
    await submit(async () => {
      const odometer = form.odometerKm.trim() === "" ? null : Number(form.odometerKm);
      const body: Record<string, unknown> = {
        plate: form.plate.trim(),
        make: form.make.trim() || null,
        model: form.model.trim() || null,
        type: form.type,
        branchId: form.branchId || null,
        defaultRepId: form.defaultRepId || null,
        odometerKm: odometer != null && Number.isFinite(odometer) ? Math.round(odometer) : null,
      };
      if (mode === "create") {
        return await apiClient("/api/v1/vehicles", { method: "POST", body });
      }
      body.active = form.active;
      return await apiClient(`/api/v1/vehicles/${vehicle!.id}`, { method: "PATCH", body });
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
        <Field label="Registration plate" htmlFor="vh-plate" required hint="e.g. KDA 123A">
          <Input
            id="vh-plate"
            value={form.plate}
            onChange={(e) => set("plate", e.target.value)}
            required
            minLength={3}
            maxLength={16}
            placeholder="KDA 123A"
            className="uppercase"
          />
        </Field>
        <Field label="Type" htmlFor="vh-type">
          <Select id="vh-type" value={form.type} onChange={(e) => set("type", e.target.value)}>
            {VEHICLE_TYPES.map((t) => (
              <option key={t} value={t}>{VEHICLE_TYPE_LABELS[t]}</option>
            ))}
          </Select>
        </Field>
        <Field label="Make" htmlFor="vh-make">
          <Input id="vh-make" value={form.make} onChange={(e) => set("make", e.target.value)} placeholder="Toyota" />
        </Field>
        <Field label="Model" htmlFor="vh-model">
          <Input id="vh-model" value={form.model} onChange={(e) => set("model", e.target.value)} placeholder="Hiace" />
        </Field>
        <Field label="Home branch" htmlFor="vh-branch">
          <Select id="vh-branch" value={form.branchId} onChange={(e) => set("branchId", e.target.value)}>
            <option value="">— none —</option>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </Select>
        </Field>
        <Field label="Usual driver" htmlFor="vh-rep" hint="Routes for this rep default to this vehicle">
          <Select id="vh-rep" value={form.defaultRepId} onChange={(e) => set("defaultRepId", e.target.value)}>
            <option value="">— unassigned —</option>
            {reps.map((r) => (
              <option key={r.id} value={r.id}>{r.name}</option>
            ))}
          </Select>
        </Field>
        <Field label="Odometer (km)" htmlFor="vh-odo">
          <Input
            id="vh-odo"
            type="number"
            inputMode="numeric"
            min={0}
            step={1}
            value={form.odometerKm}
            onChange={(e) => set("odometerKm", e.target.value)}
          />
        </Field>
      </div>

      {mode === "edit" ? (
        <label className="flex items-center gap-2 text-sm font-medium">
          <input type="checkbox" checked={form.active} onChange={(e) => set("active", e.target.checked)} />
          Active — retired vehicles keep their history but cannot be planned on
        </label>
      ) : null}

      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <div className="flex items-center justify-end gap-2 border-t border-border pt-3">
        <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={busy || form.plate.trim().length < 3}>
          {busy ? "Saving…" : mode === "create" ? "Add vehicle" : "Save changes"}
        </Button>
      </div>
    </form>
  );
}
