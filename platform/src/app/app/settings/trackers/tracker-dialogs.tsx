"use client";

import { useState } from "react";

import {
  Button,
  Callout,
  Field,
  Input,
  ModalButton,
  Select,
  apiClient,
  useFormSubmit,
} from "@/components/ui";

interface Option {
  id: string;
  name: string;
}

/** The one and only showing of a key. Nothing on the server can reproduce it. */
function RevealKey({ apiKey, onDone }: { apiKey: string; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-4">
      <Callout tone="warning" title="Copy this key now">
        It is shown only once. If it is lost, rotate the key and update the tracker platform.
      </Callout>
      <code className="block break-all rounded-lg border border-border bg-surface-sunken p-3 font-mono text-xs">
        {apiKey}
      </code>
      <div className="flex items-center justify-end gap-2 border-t border-border pt-3">
        <Button
          type="button"
          variant="secondary"
          onClick={() => {
            void navigator.clipboard.writeText(apiKey).then(() => setCopied(true));
          }}
        >
          {copied ? "Copied" : "Copy key"}
        </Button>
        <Button type="button" variant="primary" onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  );
}

export function NewIntegrationDialog() {
  return (
    <ModalButton
      label="+ New API key"
      title="Connect a tracker platform"
      description="Issue a key for one tracker platform or batch of devices. Each can be revoked on its own."
      width="max-w-md"
    >
      {(close) => <NewIntegrationForm onClose={close} />}
    </ModalButton>
  );
}

function NewIntegrationForm({ onClose }: { onClose: () => void }) {
  const { busy, error, submit } = useFormSubmit();
  const [name, setName] = useState("");
  const [provider, setProvider] = useState("GENERIC");
  const [apiKey, setApiKey] = useState<string | null>(null);

  if (apiKey) return <RevealKey apiKey={apiKey} onDone={onClose} />;

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        void submit(async () => {
          const result = await apiClient<{ apiKey: string }>("/api/v1/tracking/integrations", {
            method: "POST",
            body: { name: name.trim(), provider },
          });
          if (result.ok && result.data) setApiKey(result.data.apiKey);
          return result;
        });
      }}
    >
      <Field label="Name" htmlFor="ti-name" required hint="Who or what will use this key">
        <Input
          id="ti-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          minLength={2}
          maxLength={60}
          placeholder="Fleet GPS gateway"
        />
      </Field>
      <Field label="Sends data as" htmlFor="ti-provider">
        <Select id="ti-provider" value={provider} onChange={(e) => setProvider(e.target.value)}>
          <option value="GENERIC">Raut position format</option>
          <option value="TRACCAR">Traccar position forwarding</option>
        </Select>
      </Field>
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <div className="flex items-center justify-end gap-2 border-t border-border pt-3">
        <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={busy || name.trim().length < 2}>
          {busy ? "Issuing…" : "Issue key"}
        </Button>
      </div>
    </form>
  );
}

export function IntegrationActions({ id, name, active }: { id: string; name: string; active: boolean }) {
  return (
    <div className="flex items-center justify-end gap-1">
      <ModalButton
        label="Rotate"
        title={`Rotate the key for ${name}`}
        description="The current key stops working immediately. Trackers stay offline until the new key is in place."
        variant="ghost"
        width="max-w-md"
      >
        {(close) => <RotateForm id={id} onClose={close} />}
      </ModalButton>
      <ModalButton
        label={active ? "Revoke" : "Restore"}
        title={active ? `Revoke the key for ${name}` : `Restore the key for ${name}`}
        description={
          active
            ? "Reports using this key are refused from now on. History already stored stays."
            : "The existing key starts working again."
        }
        variant="ghost"
        width="max-w-md"
      >
        {(close) => <ToggleForm id={id} active={active} onClose={close} />}
      </ModalButton>
    </div>
  );
}

function RotateForm({ id, onClose }: { id: string; onClose: () => void }) {
  const { busy, error, submit } = useFormSubmit();
  const [apiKey, setApiKey] = useState<string | null>(null);
  if (apiKey) return <RevealKey apiKey={apiKey} onDone={onClose} />;
  return (
    <div className="space-y-4">
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button
          type="button"
          variant="danger"
          disabled={busy}
          onClick={() => {
            void submit(async () => {
              const result = await apiClient<{ apiKey: string }>(`/api/v1/tracking/integrations/${id}`, {
                method: "PATCH",
                body: { rotate: true },
              });
              if (result.ok && result.data) setApiKey(result.data.apiKey);
              return result;
            });
          }}
        >
          {busy ? "Rotating…" : "Rotate key"}
        </Button>
      </div>
    </div>
  );
}

function ToggleForm({ id, active, onClose }: { id: string; active: boolean; onClose: () => void }) {
  const { busy, error, submit } = useFormSubmit();
  return (
    <div className="space-y-4">
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button
          type="button"
          variant={active ? "danger" : "primary"}
          disabled={busy}
          onClick={() => {
            void submit(
              () => apiClient(`/api/v1/tracking/integrations/${id}`, { method: "PATCH", body: { active: !active } }),
              { onSuccess: onClose },
            );
          }}
        >
          {busy ? "Saving…" : active ? "Revoke key" : "Restore key"}
        </Button>
      </div>
    </div>
  );
}

export interface DeviceShape {
  id?: string;
  externalId: string;
  label: string | null;
  vehicleId: string | null;
  active: boolean;
}

/** Add a device by IMEI, or match one that has already reported to its van. */
export function DeviceDialog({
  mode,
  device,
  vehicles,
}: {
  mode: "create" | "edit";
  device?: DeviceShape;
  vehicles: Option[];
}) {
  return (
    <ModalButton
      label={mode === "create" ? "+ Add device" : device?.vehicleId ? "Edit" : "Assign"}
      title={mode === "create" ? "Add a tracker device" : `Tracker ${device?.externalId ?? ""}`}
      description="One tracker per vehicle. Positions are stored once a vehicle is assigned."
      variant={mode === "create" ? "secondary" : "ghost"}
      width="max-w-md"
    >
      {(close) => <DeviceForm mode={mode} device={device} vehicles={vehicles} onClose={close} />}
    </ModalButton>
  );
}

function DeviceForm({
  mode,
  device,
  vehicles,
  onClose,
}: {
  mode: "create" | "edit";
  device?: DeviceShape;
  vehicles: Option[];
  onClose: () => void;
}) {
  const { busy, error, submit } = useFormSubmit();
  const [externalId, setExternalId] = useState(device?.externalId ?? "");
  const [label, setLabel] = useState(device?.label ?? "");
  const [vehicleId, setVehicleId] = useState(device?.vehicleId ?? "");
  const [active, setActive] = useState(device?.active ?? true);

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        void submit(
          () =>
            mode === "create"
              ? apiClient("/api/v1/tracking/devices", {
                  method: "POST",
                  body: { externalId: externalId.trim(), label: label.trim() || null, vehicleId: vehicleId || null },
                })
              : apiClient(`/api/v1/tracking/devices/${device!.id}`, {
                  method: "PATCH",
                  body: { label: label.trim() || null, vehicleId: vehicleId || null, active },
                }),
          { onSuccess: onClose },
        );
      }}
    >
      {mode === "create" ? (
        <Field label="Device ID" htmlFor="td-id" required hint="The IMEI or unique ID the tracker reports">
          <Input
            id="td-id"
            value={externalId}
            onChange={(e) => setExternalId(e.target.value)}
            required
            minLength={3}
            maxLength={64}
            className="font-mono"
          />
        </Field>
      ) : null}
      <Field label="Vehicle" htmlFor="td-vehicle">
        <Select id="td-vehicle" value={vehicleId} onChange={(e) => setVehicleId(e.target.value)}>
          <option value="">— not assigned —</option>
          {vehicles.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Label" htmlFor="td-label">
        <Input id="td-label" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={60} placeholder="Under the dashboard" />
      </Field>
      {mode === "edit" ? (
        <label className="flex items-center gap-2 text-sm font-medium">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
          Active — switched-off devices have their reports ignored
        </label>
      ) : null}
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <div className="flex items-center justify-end gap-2 border-t border-border pt-3">
        <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={busy || (mode === "create" && externalId.trim().length < 3)}>
          {busy ? "Saving…" : "Save"}
        </Button>
      </div>
    </form>
  );
}
