"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { apiClient, useFormSubmit, Button, Field, Input, Modal, ModalButton, Select, Textarea } from "@/components/ui";

interface Option { id: string; name: string }

export function MeetingDialog({ customers }: { customers: Option[] }) {
  return (
    <ModalButton label="+ Schedule meeting" title="Schedule an online meeting" description="Creates a Jitsi room. You can email the customer the join link afterwards." width="max-w-lg">
      {(close) => <MeetingForm customers={customers} onClose={close} />}
    </ModalButton>
  );
}

function MeetingForm({ customers, onClose }: { customers: Option[]; onClose: (saved: boolean) => void }) {
  const router = useRouter();
  const { busy, error, submit } = useFormSubmit();
  const now = new Date(Date.now() + 60 * 60 * 1000);
  const [f, setF] = useState({
    title: "",
    customerId: "",
    date: now.toISOString().slice(0, 10),
    time: now.toTimeString().slice(0, 5),
    durationMin: "30",
    notes: "",
  });
  const set = (k: keyof typeof f, v: string) => setF((s) => ({ ...s, [k]: v }));

  async function save() {
    await submit(
      () =>
        apiClient("/api/v1/meetings", {
          method: "POST",
          body: {
            title: f.title.trim(),
            customerId: f.customerId || null,
            scheduledAt: new Date(`${f.date}T${f.time}:00`).toISOString(),
            durationMin: Number(f.durationMin || 30),
            notes: f.notes || null,
          },
        }),
      { onSuccess: () => { onClose(true); router.refresh(); } },
    );
  }

  return (
    <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <Field label="Title" htmlFor="m-title" required>
        <Input id="m-title" value={f.title} onChange={(e) => set("title", e.target.value)} required minLength={2} placeholder="e.g. Product demo" />
      </Field>
      <Field label="Customer" htmlFor="m-cust" hint="Optional — needed to email an invite">
        <Select id="m-cust" value={f.customerId} onChange={(e) => set("customerId", e.target.value)}>
          <option value="">— none —</option>
          {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
      </Field>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Date" htmlFor="m-date" required>
          <Input id="m-date" type="date" value={f.date} onChange={(e) => set("date", e.target.value)} required />
        </Field>
        <Field label="Time" htmlFor="m-time" required>
          <Input id="m-time" type="time" value={f.time} onChange={(e) => set("time", e.target.value)} required />
        </Field>
        <Field label="Minutes" htmlFor="m-dur">
          <Input id="m-dur" type="number" min={5} max={480} step="5" value={f.durationMin} onChange={(e) => set("durationMin", e.target.value)} />
        </Field>
      </div>
      <Field label="Notes" htmlFor="m-notes">
        <Textarea id="m-notes" rows={2} value={f.notes} onChange={(e) => set("notes", e.target.value)} />
      </Field>
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <div className="flex justify-end gap-2 border-t border-border pt-3">
        <Button type="button" variant="ghost" onClick={() => onClose(false)} disabled={busy}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={busy || !f.title.trim()}>{busy ? "Scheduling…" : "Schedule"}</Button>
      </div>
    </form>
  );
}

export function InviteButton({ id, disabled }: { id: string; disabled?: boolean }) {
  const { busy, error, submit } = useFormSubmit();
  const [done, setDone] = useState(false);
  if (disabled) return null;
  return (
    <span className="inline-flex items-center gap-2">
      <Button
        variant="secondary"
        size="sm"
        disabled={busy || done}
        onClick={async () => {
          const ok = await submit(() => apiClient(`/api/v1/meetings/${id}/invite`, { method: "POST" }), {});
          if (ok) setDone(true);
        }}
      >
        {done ? "Invite sent" : busy ? "Sending…" : "Email invite"}
      </Button>
      {error ? <span className="text-xs text-danger">{error}</span> : null}
    </span>
  );
}

export function CancelMeetingButton({ id }: { id: string }) {
  const router = useRouter();
  const { busy, submit } = useFormSubmit();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>Cancel</Button>
      <Modal open={open} onClose={() => setOpen(false)} title="Cancel this meeting?" width="max-w-sm">
        <div className="space-y-3">
          <p className="text-sm text-content-secondary">The room link stops being offered. This cannot be undone.</p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>Keep it</Button>
            <Button variant="danger" disabled={busy} onClick={async () => {
              const ok = await submit(() => apiClient(`/api/v1/meetings/${id}`, { method: "PATCH", body: { status: "CANCELLED" } }), {});
              if (ok) { setOpen(false); router.refresh(); }
            }}>{busy ? "Cancelling…" : "Cancel meeting"}</Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
