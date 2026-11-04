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
  Textarea,
} from "@/components/ui";

interface Option {
  id: string;
  name: string;
}

/** Schedule a visit. Reps can only schedule for themselves — the server gates it — so the rep picker shows for managers only. */
export function VisitDialog({
  customers,
  reps,
  selfIsRep,
}: {
  customers: Option[];
  reps: Option[];
  selfIsRep: boolean;
}) {
  return (
    <ModalButton
      label="+ Schedule visit"
      title="Schedule a visit"
      description="A rep only sees their own customers; the schedule is what the route holds stable."
      width="max-w-lg"
    >
      {(close) => <VisitForm customers={customers} reps={reps} selfIsRep={selfIsRep} onClose={() => close()} />}
    </ModalButton>
  );
}

function VisitForm({
  customers,
  reps,
  selfIsRep,
  onClose,
}: {
  customers: Option[];
  reps: Option[];
  selfIsRep: boolean;
  onClose: () => void;
}) {
  const { busy, error, submit } = useFormSubmit();
  const tomorrow = new Date(Date.now() + 86_400_000);
  const [form, setForm] = useState({
    customerId: customers[0]?.id ?? "",
    repId: reps[0]?.id ?? "",
    date: tomorrow.toISOString().slice(0, 10),
    time: "09:00",
    purpose: "SALES",
    notes: "",
  });
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));

  async function save() {
    await submit(async () => {
      return await apiClient("/api/v1/visits", {
        method: "POST",
        body: {
          customerId: form.customerId,
          ...(selfIsRep ? {} : { repId: form.repId || undefined }),
          scheduledAt: new Date(`${form.date}T${form.time}:00`).toISOString(),
          purpose: form.purpose,
          notes: form.notes || undefined,
          clientUuid: crypto.randomUUID(),
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
      <Field label="Customer" htmlFor="vis-customer" required>
        <Select id="vis-customer" value={form.customerId} onChange={(e) => set("customerId", e.target.value)}>
          {customers.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </Select>
      </Field>
      {!selfIsRep && (
        <Field label="Rep" htmlFor="vis-rep" required>
          <Select id="vis-rep" value={form.repId} onChange={(e) => set("repId", e.target.value)}>
            {reps.map((r) => (
              <option key={r.id} value={r.id}>{r.name}</option>
            ))}
          </Select>
        </Field>
      )}
      <div className="grid grid-cols-2 gap-3">
        <Field label="Date" htmlFor="vis-date" required>
          <Input id="vis-date" type="date" value={form.date} onChange={(e) => set("date", e.target.value)} required />
        </Field>
        <Field label="Time" htmlFor="vis-time" required>
          <Input id="vis-time" type="time" value={form.time} onChange={(e) => set("time", e.target.value)} required />
        </Field>
      </div>
      <Field label="Purpose" htmlFor="vis-purpose">
        <Select id="vis-purpose" value={form.purpose} onChange={(e) => set("purpose", e.target.value)}>
          <option value="SALES">Sales</option>
          <option value="COLLECTION">Collection</option>
          <option value="DELIVERY">Delivery</option>
          <option value="PROSPECTING">Prospecting</option>
          <option value="SUPPORT">Support</option>
        </Select>
      </Field>
      <Field label="Notes" htmlFor="vis-notes">
        <Textarea id="vis-notes" rows={2} value={form.notes} onChange={(e) => set("notes", e.target.value)} />
      </Field>

      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <div className="flex items-center justify-end gap-2 border-t border-border pt-3">
        <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={busy || !form.customerId}>
          {busy ? "Scheduling…" : "Schedule visit"}
        </Button>
      </div>
    </form>
  );
}
