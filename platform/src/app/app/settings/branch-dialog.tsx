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

export interface BranchShape {
  id?: string;
  name: string;
  code?: string;
  phone?: string | null;
  address?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  active?: boolean;
}

export function BranchDialog({
  mode,
  branch,
}: {
  mode: "create" | "edit";
  branch?: BranchShape;
}) {
  return (
    <ModalButton
      label={mode === "create" ? "+ New branch" : "Edit"}
      title={mode === "create" ? "New branch" : `Edit ${branch?.name ?? "branch"}`}
      variant={mode === "edit" ? "ghost" : "secondary"}
      width="max-w-md"
    >
      {(close) => <BranchForm mode={mode} branch={branch} onClose={() => close()} />}
    </ModalButton>
  );
}

function BranchForm({
  mode,
  branch,
  onClose,
}: {
  mode: "create" | "edit";
  branch?: BranchShape;
  onClose: () => void;
}) {
  const { busy, error, submit } = useFormSubmit();
  const [form, setForm] = useState({
    name: branch?.name ?? "",
    code: branch?.code ?? "",
    phone: branch?.phone ?? "",
    address: branch?.address ?? "",
    latitude: branch?.latitude != null ? String(branch.latitude) : "",
    longitude: branch?.longitude != null ? String(branch.longitude) : "",
    active: branch?.active ?? true,
  });
  const set = (k: keyof typeof form, v: string | boolean) => setForm((f) => ({ ...f, [k]: v }));

  const numStr = (s: string) => {
    if (s.trim() === "") return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  };

  async function save() {
    await submit(async () => {
      const body: Record<string, unknown> = {
        name: form.name.trim(),
        phone: form.phone || null,
        address: form.address || null,
        latitude: numStr(form.latitude),
        longitude: numStr(form.longitude),
      };
      if (mode === "create") {
        body.code = form.code.trim();
        return await apiClient("/api/v1/branches", { method: "POST", body });
      }
      body.active = form.active;
      return await apiClient(`/api/v1/branches/${branch!.id}`, { method: "PATCH", body });
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
      <Field label="Branch name" htmlFor="br-name" required>
        <Input id="br-name" value={form.name} onChange={(e) => set("name", e.target.value)} required minLength={2} placeholder="Mombasa" />
      </Field>
      {mode === "create" ? (
        <Field label="Code" htmlFor="br-code" required hint="Short uppercase code, e.g. MBA">
          <Input id="br-code" value={form.code} onChange={(e) => set("code", e.target.value)} required />
        </Field>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Phone" htmlFor="br-phone">
          <Input id="br-phone" value={form.phone} onChange={(e) => set("phone", e.target.value)} placeholder="+254…" />
        </Field>
        <Field label="Address" htmlFor="br-address">
          <Input id="br-address" value={form.address} onChange={(e) => set("address", e.target.value)} />
        </Field>
        <Field label="Latitude" htmlFor="br-lat">
          <Input id="br-lat" type="number" step="any" value={form.latitude} onChange={(e) => set("latitude", e.target.value)} />
        </Field>
        <Field label="Longitude" htmlFor="br-lng">
          <Input id="br-lng" type="number" step="any" value={form.longitude} onChange={(e) => set("longitude", e.target.value)} />
        </Field>
      </div>
      {mode === "edit" ? (
        <label className="flex items-center gap-2 text-sm font-medium">
          <input type="checkbox" checked={form.active} onChange={(e) => set("active", e.target.checked)} />
          Active
        </label>
      ) : null}

      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <div className="flex items-center justify-end gap-2 border-t border-border pt-3">
        <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={busy || !form.name.trim() || (mode === "create" && !form.code.trim())}>
          {busy ? "Saving…" : mode === "create" ? "Create branch" : "Save changes"}
        </Button>
      </div>
    </form>
  );
}
