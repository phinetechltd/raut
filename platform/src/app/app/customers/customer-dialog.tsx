"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import {
  apiClient,
  useFormSubmit,
  Button,
  Field,
  Input,
  Modal,
  ModalButton,
  Select,
} from "@/components/ui";

export interface CustomerShape {
  id?: string;
  name: string;
  code?: string;
  type: string;
  segment: string;
  phone?: string | null;
  email?: string | null;
  town?: string | null;
  address?: string | null;
  creditLimitCents: number;
  paymentTermsDays: number;
  territoryId?: string | null;
  assignedRepId?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  geofenceRadiusM?: number;
  status?: string;
  notes?: string | null;
}

interface Option {
  id: string;
  name: string;
}

/**
 * Create/edit customer form. Money is keyed in KES and converted to cents at
 * submit; the server schema takes cents (1 KES = 100).
 */
export function CustomerDialog({
  mode,
  customer,
  territories,
  reps,
  buttonVariant = "primary",
  buttonLabel,
}: {
  mode: "create" | "edit";
  customer?: CustomerShape;
  territories: Option[];
  reps: Option[];
  buttonVariant?: "primary" | "secondary" | "ghost" | "danger";
  buttonLabel?: string;
}) {
  const title = mode === "create" ? "New customer" : `Edit ${customer?.name ?? "customer"}`;
  return (
    <ModalButton
      label={buttonLabel ?? (mode === "create" ? "+ New customer" : "Edit")}
      title={title}
      description={
        mode === "create"
          ? "The code is assigned automatically; GPS pins can be captured from the field app."
          : "Changes are applied immediately and audited."
      }
      variant={buttonVariant}
      width="max-w-2xl"
    >
      {(close) => (
        <CustomerForm
          mode={mode}
          customer={customer}
          territories={territories}
          reps={reps}
          onClose={close}
        />
      )}
    </ModalButton>
  );
}

function CustomerForm({
  mode,
  customer,
  territories,
  reps,
  onClose,
}: {
  mode: "create" | "edit";
  customer?: CustomerShape;
  territories: Option[];
  reps: Option[];
  onClose: (saved: boolean) => void;
}) {
  const { busy, error, submit } = useFormSubmit();
  const router = useRouter();
  const [form, setForm] = useState({
    name: customer?.name ?? "",
    code: customer?.code ?? "",
    type: customer?.type ?? "RETAIL",
    segment: customer?.segment ?? "C",
    phone: customer?.phone ?? "",
    email: customer?.email ?? "",
    town: customer?.town ?? "",
    address: customer?.address ?? "",
    creditLimit: ((customer?.creditLimitCents ?? 0) / 100).toString(),
    paymentTermsDays: String(customer?.paymentTermsDays ?? 0),
    territoryId: customer?.territoryId ?? "",
    assignedRepId: customer?.assignedRepId ?? "",
    latitude: customer?.latitude != null ? String(customer.latitude) : "",
    longitude: customer?.longitude != null ? String(customer.longitude) : "",
    geofenceRadiusM: String(customer?.geofenceRadiusM ?? 150),
    status: customer?.status ?? "ACTIVE",
  });

  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const num = (raw: string): number | undefined => {
    if (raw.trim() === "") return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  };

  async function save() {
    await submit(async () => {
      const body: Record<string, unknown> = {
        name: form.name.trim(),
        type: form.type,
        segment: form.segment,
        phone: form.phone || null,
        email: form.email || null,
        town: form.town || null,
        address: form.address || null,
        creditLimitCents: Math.round(Number(form.creditLimit || 0) * 100),
        paymentTermsDays: Number(form.paymentTermsDays || 0),
        territoryId: form.territoryId || null,
        assignedRepId: form.assignedRepId || null,
        latitude: num(form.latitude) ?? null,
        longitude: num(form.longitude) ?? null,
        geofenceRadiusM: num(form.geofenceRadiusM) ?? 150,
      };
      if (mode === "create") {
        body.code = form.code || undefined;
        body.clientUuid = crypto.randomUUID();
        return await apiClient("/api/v1/customers", { method: "POST", body });
      }
      body.status = form.status;
      return await apiClient(`/api/v1/customers/${customer!.id}`, { method: "PATCH", body });
    }, {
      onSuccess: () => {
        onClose(true);
        router.refresh();
      },
    });
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
        <Field label="Name" htmlFor="cust-name" required>
          <Input id="cust-name" value={form.name} onChange={(e) => set("name", e.target.value)} required minLength={2} />
        </Field>
        {mode === "create" ? (
          <Field label="Code" htmlFor="cust-code" hint="Leave blank to auto-assign">
            <Input id="cust-code" value={form.code} onChange={(e) => set("code", e.target.value)} />
          </Field>
        ) : (
          <Field label="Status" htmlFor="cust-status">
            <Select id="cust-status" value={form.status} onChange={(e) => set("status", e.target.value)}>
              <option value="ACTIVE">Active</option>
              <option value="DORMANT">Dormant</option>
              <option value="BLOCKED">Blocked</option>
            </Select>
          </Field>
        )}
        <Field label="Type" htmlFor="cust-type">
          <Select id="cust-type" value={form.type} onChange={(e) => set("type", e.target.value)}>
            <option value="RETAIL">Retail</option>
            <option value="WHOLESALE">Wholesale</option>
            <option value="DISTRIBUTOR">Distributor</option>
            <option value="INSTITUTION">Institution</option>
          </Select>
        </Field>
        <Field label="Segment" htmlFor="cust-segment">
          <Select id="cust-segment" value={form.segment} onChange={(e) => set("segment", e.target.value)}>
            <option value="A">A — high value</option>
            <option value="B">B — growing</option>
            <option value="C">C — standard</option>
          </Select>
        </Field>
        <Field label="Phone" htmlFor="cust-phone">
          <Input id="cust-phone" value={form.phone} onChange={(e) => set("phone", e.target.value)} placeholder="+254…" />
        </Field>
        <Field label="Email" htmlFor="cust-email">
          <Input id="cust-email" type="email" value={form.email} onChange={(e) => set("email", e.target.value)} />
        </Field>
        <Field label="Town" htmlFor="cust-town">
          <Input id="cust-town" value={form.town} onChange={(e) => set("town", e.target.value)} />
        </Field>
        <Field label="Address" htmlFor="cust-address">
          <Input id="cust-address" value={form.address} onChange={(e) => set("address", e.target.value)} />
        </Field>
        <Field label="Credit limit (KES)" htmlFor="cust-credit">
          <Input id="cust-credit" type="number" min={0} step="1" value={form.creditLimit} onChange={(e) => set("creditLimit", e.target.value)} />
        </Field>
        <Field label="Payment terms (days)" htmlFor="cust-terms" hint="0 means cash on delivery">
          <Input id="cust-terms" type="number" min={0} max={180} step="1" value={form.paymentTermsDays} onChange={(e) => set("paymentTermsDays", e.target.value)} />
        </Field>
        <Field label="Territory" htmlFor="cust-territory">
          <Select id="cust-territory" value={form.territoryId} onChange={(e) => set("territoryId", e.target.value)}>
            <option value="">— unassigned —</option>
            {territories.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </Select>
        </Field>
        <Field label="Assigned rep" htmlFor="cust-rep">
          <Select id="cust-rep" value={form.assignedRepId} onChange={(e) => set("assignedRepId", e.target.value)}>
            <option value="">— unassigned —</option>
            {reps.map((r) => (
              <option key={r.id} value={r.id}>{r.name}</option>
            ))}
          </Select>
        </Field>
      </div>

      <details className="rounded-lg border border-border bg-surface-sunken px-3 py-2">
        <summary className="cursor-pointer select-none text-sm font-medium">GPS pin &amp; geofence</summary>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <Field label="Latitude" htmlFor="cust-lat">
            <Input id="cust-lat" type="number" step="any" value={form.latitude} onChange={(e) => set("latitude", e.target.value)} placeholder="-1.29" />
          </Field>
          <Field label="Longitude" htmlFor="cust-lng">
            <Input id="cust-lng" type="number" step="any" value={form.longitude} onChange={(e) => set("longitude", e.target.value)} placeholder="36.82" />
          </Field>
          <Field label="Fence radius (m)" htmlFor="cust-radius">
            <Input id="cust-radius" type="number" min={20} max={5000} step="1" value={form.geofenceRadiusM} onChange={(e) => set("geofenceRadiusM", e.target.value)} />
          </Field>
        </div>
      </details>

      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <div className="flex items-center justify-end gap-2 border-t border-border pt-3">
        <Button type="button" variant="ghost" onClick={() => onClose(false)} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={busy || !form.name.trim()}>
          {busy ? "Saving…" : mode === "create" ? "Create customer" : "Save changes"}
        </Button>
      </div>
    </form>
  );
}

/** Delete a customer — hard delete for fresh records, deactivate (BLOCKED) once history exists. */
export function CustomerDeleteButton({ id, name }: { id: string; name: string }) {
  const router = useRouter();
  const { busy, error, submit } = useFormSubmit();
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button variant="danger" size="sm" onClick={() => setOpen(true)}>
        Delete
      </Button>
      <Modal open={open} onClose={() => setOpen(false)} title={`Delete ${name}?`} width="max-w-md">
        <div className="space-y-3">
          <p className="text-sm text-content-secondary">
            If this customer has invoices or orders, the account is deactivated
            instead of removed, so the books stay intact.
          </p>
          {error ? <p className="text-sm text-danger">{error}</p> : null}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>Cancel</Button>
            <Button
              variant="danger"
              disabled={busy}
              onClick={async () => {
                const ok = await submit(
                  () => apiClient(`/api/v1/customers/${id}`, { method: "DELETE" }),
                  {},
                );
                if (ok) {
                  setOpen(false);
                  router.push("/app/customers");
                }
              }}
            >
              {busy ? "Deleting…" : "Delete customer"}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
