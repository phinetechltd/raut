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

export interface SupplierShape {
  id?: string;
  name: string;
  code?: string;
  contactName?: string | null;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  taxPin?: string | null;
  paymentTermsDays: number;
  status?: string;
}

export function SupplierDialog({
  mode,
  supplier,
}: {
  mode: "create" | "edit";
  supplier?: SupplierShape;
}) {
  return (
    <ModalButton
      label={mode === "create" ? "+ New supplier" : "Edit"}
      title={mode === "create" ? "New supplier" : `Edit ${supplier?.name ?? "supplier"}`}
      description={mode === "create" ? "The code is assigned automatically." : undefined}
      variant={mode === "edit" ? "ghost" : "primary"}
      width="max-w-xl"
    >
      {(close) => <SupplierForm mode={mode} supplier={supplier} onClose={() => close()} />}
    </ModalButton>
  );
}

function SupplierForm({
  mode,
  supplier,
  onClose,
}: {
  mode: "create" | "edit";
  supplier?: SupplierShape;
  onClose: () => void;
}) {
  const { busy, error, submit } = useFormSubmit();
  const [form, setForm] = useState({
    name: supplier?.name ?? "",
    code: supplier?.code ?? "",
    contactName: supplier?.contactName ?? "",
    phone: supplier?.phone ?? "",
    email: supplier?.email ?? "",
    address: supplier?.address ?? "",
    taxPin: supplier?.taxPin ?? "",
    paymentTermsDays: String(supplier?.paymentTermsDays ?? 30),
    status: supplier?.status ?? "ACTIVE",
  });
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));

  async function save() {
    await submit(async () => {
      const body: Record<string, unknown> = {
        name: form.name.trim(),
        contactName: form.contactName || null,
        phone: form.phone || null,
        email: form.email || null,
        address: form.address || null,
        taxPin: form.taxPin || null,
        paymentTermsDays: Number(form.paymentTermsDays || 0),
      };
      if (mode === "create") {
        body.code = form.code || undefined;
        return await apiClient("/api/v1/suppliers", { method: "POST", body });
      }
      body.status = form.status;
      return await apiClient(`/api/v1/suppliers/${supplier!.id}`, { method: "PATCH", body });
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
        <Field label="Name" htmlFor="sup-name" required>
          <Input id="sup-name" value={form.name} onChange={(e) => set("name", e.target.value)} required minLength={2} />
        </Field>
        {mode === "create" ? (
          <Field label="Code" htmlFor="sup-code" hint="Leave blank to auto-assign">
            <Input id="sup-code" value={form.code} onChange={(e) => set("code", e.target.value)} />
          </Field>
        ) : (
          <Field label="Status" htmlFor="sup-status">
            <Select id="sup-status" value={form.status} onChange={(e) => set("status", e.target.value)}>
              <option value="ACTIVE">Active</option>
              <option value="SUSPENDED">Suspended</option>
            </Select>
          </Field>
        )}
        <Field label="Contact person" htmlFor="sup-contact">
          <Input id="sup-contact" value={form.contactName} onChange={(e) => set("contactName", e.target.value)} />
        </Field>
        <Field label="Phone" htmlFor="sup-phone">
          <Input id="sup-phone" value={form.phone} onChange={(e) => set("phone", e.target.value)} placeholder="+254…" />
        </Field>
        <Field label="Email" htmlFor="sup-email">
          <Input id="sup-email" type="email" value={form.email} onChange={(e) => set("email", e.target.value)} />
        </Field>
        <Field label="Payment terms (days)" htmlFor="sup-terms">
          <Input id="sup-terms" type="number" min={0} max={180} step="1" value={form.paymentTermsDays} onChange={(e) => set("paymentTermsDays", e.target.value)} />
        </Field>
        <Field label="KRA PIN" htmlFor="sup-pin">
          <Input id="sup-pin" value={form.taxPin} onChange={(e) => set("taxPin", e.target.value)} />
        </Field>
        <Field label="Address" htmlFor="sup-address">
          <Input id="sup-address" value={form.address} onChange={(e) => set("address", e.target.value)} />
        </Field>
      </div>

      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <div className="flex items-center justify-end gap-2 border-t border-border pt-3">
        <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={busy || !form.name.trim()}>
          {busy ? "Saving…" : mode === "create" ? "Create supplier" : "Save changes"}
        </Button>
      </div>
    </form>
  );
}
