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
  Textarea,
} from "@/components/ui";

export interface Option {
  id: string;
  name: string;
}
export interface StageOption extends Option {
  kind: string;
}

const SOURCES = [
  ["", "— source —"],
  ["REFERRAL", "Referral"],
  ["WEB", "Website"],
  ["FIELD", "Field visit"],
  ["CALL", "Phone call"],
  ["EVENT", "Event"],
  ["OTHER", "Other"],
] as const;

// ── leads ──────────────────────────────────────────────────────────────────

export function NewLeadDialog({ reps }: { reps: Option[] }) {
  return (
    <ModalButton label="+ New lead" title="New lead" description="Capture a prospect before they become a customer." width="max-w-lg">
      {(close) => <LeadForm reps={reps} onClose={close} />}
    </ModalButton>
  );
}

function LeadForm({ reps, onClose }: { reps: Option[]; onClose: (saved: boolean) => void }) {
  const router = useRouter();
  const { busy, error, submit } = useFormSubmit();
  const [f, setF] = useState({ name: "", contactName: "", phone: "", email: "", source: "", ownerId: "", notes: "" });
  const set = (k: keyof typeof f, v: string) => setF((s) => ({ ...s, [k]: v }));

  async function save() {
    await submit(
      () =>
        apiClient("/api/v1/leads", {
          method: "POST",
          body: {
            name: f.name.trim(),
            contactName: f.contactName || null,
            phone: f.phone || null,
            email: f.email || null,
            source: f.source || null,
            ownerId: f.ownerId || null,
            notes: f.notes || null,
          },
        }),
      { onSuccess: () => { onClose(true); router.refresh(); } },
    );
  }

  return (
    <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name" htmlFor="lead-name" required>
          <Input id="lead-name" value={f.name} onChange={(e) => set("name", e.target.value)} required minLength={2} placeholder="Business or person" />
        </Field>
        <Field label="Contact person" htmlFor="lead-contact">
          <Input id="lead-contact" value={f.contactName} onChange={(e) => set("contactName", e.target.value)} />
        </Field>
        <Field label="Phone" htmlFor="lead-phone">
          <Input id="lead-phone" value={f.phone} onChange={(e) => set("phone", e.target.value)} placeholder="+254…" />
        </Field>
        <Field label="Email" htmlFor="lead-email">
          <Input id="lead-email" type="email" value={f.email} onChange={(e) => set("email", e.target.value)} />
        </Field>
        <Field label="Source" htmlFor="lead-source">
          <Select id="lead-source" value={f.source} onChange={(e) => set("source", e.target.value)}>
            {SOURCES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </Select>
        </Field>
        <Field label="Owner" htmlFor="lead-owner">
          <Select id="lead-owner" value={f.ownerId} onChange={(e) => set("ownerId", e.target.value)}>
            <option value="">— unassigned —</option>
            {reps.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </Select>
        </Field>
      </div>
      <Field label="Notes" htmlFor="lead-notes">
        <Textarea id="lead-notes" rows={2} value={f.notes} onChange={(e) => set("notes", e.target.value)} />
      </Field>
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <div className="flex justify-end gap-2 border-t border-border pt-3">
        <Button type="button" variant="ghost" onClick={() => onClose(false)} disabled={busy}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={busy || !f.name.trim()}>{busy ? "Saving…" : "Create lead"}</Button>
      </div>
    </form>
  );
}

export function ConvertLeadButton({ leadId, leadName }: { leadId: string; leadName: string }) {
  const router = useRouter();
  const { busy, error, submit } = useFormSubmit();
  const [open, setOpen] = useState(false);
  const [withDeal, setWithDeal] = useState(true);
  const [title, setTitle] = useState(`${leadName} opportunity`);
  const [value, setValue] = useState("");

  async function convert() {
    const ok = await submit(
      () =>
        apiClient(`/api/v1/leads/${leadId}/convert`, {
          method: "POST",
          body: { createDeal: withDeal, dealTitle: title, dealValueCents: Math.round(Number(value || 0) * 100) },
        }),
      {},
    );
    if (ok) { setOpen(false); router.refresh(); }
  }

  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>Convert</Button>
      <Modal open={open} onClose={() => setOpen(false)} title={`Convert ${leadName}`} width="max-w-md">
        <div className="space-y-3">
          <p className="text-sm text-content-secondary">Creates a customer from this lead. You can also open a first deal.</p>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={withDeal} onChange={(e) => setWithDeal(e.target.checked)} />
            Open a deal in the pipeline
          </label>
          {withDeal ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Deal title" htmlFor="conv-title">
                <Input id="conv-title" value={title} onChange={(e) => setTitle(e.target.value)} />
              </Field>
              <Field label="Value (KES)" htmlFor="conv-value">
                <Input id="conv-value" type="number" min={0} step="1" value={value} onChange={(e) => setValue(e.target.value)} />
              </Field>
            </div>
          ) : null}
          {error ? <p className="text-sm text-danger">{error}</p> : null}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>Cancel</Button>
            <Button variant="primary" disabled={busy} onClick={() => void convert()}>{busy ? "Converting…" : "Convert lead"}</Button>
          </div>
        </div>
      </Modal>
    </>
  );
}

export function LeadStatusSelect({ leadId, status }: { leadId: string; status: string }) {
  const router = useRouter();
  const { busy, submit } = useFormSubmit();
  if (status === "CONVERTED") return <span className="text-xs text-content-muted">Converted</span>;
  return (
    <Select
      aria-label="Lead status"
      value={status}
      disabled={busy}
      onChange={async (e) => {
        const ok = await submit(() => apiClient(`/api/v1/leads/${leadId}`, { method: "PATCH", body: { status: e.target.value } }), {});
        if (ok) router.refresh();
      }}
    >
      <option value="NEW">New</option>
      <option value="WORKING">Working</option>
      <option value="DISCARDED">Discarded</option>
    </Select>
  );
}

// ── deals ──────────────────────────────────────────────────────────────────

export function NewDealDialog({ customers, reps, stages }: { customers: Option[]; reps: Option[]; stages: StageOption[] }) {
  return (
    <ModalButton label="+ New deal" title="New deal" description="An opportunity moving through the pipeline." width="max-w-lg">
      {(close) => <DealForm customers={customers} reps={reps} stages={stages} onClose={close} />}
    </ModalButton>
  );
}

function DealForm({ customers, reps, stages, onClose }: { customers: Option[]; reps: Option[]; stages: StageOption[]; onClose: (saved: boolean) => void }) {
  const router = useRouter();
  const { busy, error, submit } = useFormSubmit();
  const openStages = stages.filter((s) => s.kind === "OPEN");
  const [f, setF] = useState({ title: "", customerId: "", stageId: openStages[0]?.id ?? "", value: "", ownerId: "", expectedCloseAt: "" });
  const set = (k: keyof typeof f, v: string) => setF((s) => ({ ...s, [k]: v }));

  async function save() {
    await submit(
      () =>
        apiClient("/api/v1/deals", {
          method: "POST",
          body: {
            title: f.title.trim(),
            customerId: f.customerId || null,
            stageId: f.stageId || undefined,
            valueCents: Math.round(Number(f.value || 0) * 100),
            ownerId: f.ownerId || null,
            expectedCloseAt: f.expectedCloseAt || null,
          },
        }),
      { onSuccess: () => { onClose(true); router.refresh(); } },
    );
  }

  return (
    <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <Field label="Title" htmlFor="deal-title" required>
        <Input id="deal-title" value={f.title} onChange={(e) => set("title", e.target.value)} required minLength={2} placeholder="e.g. Monthly depot supply" />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Customer" htmlFor="deal-customer">
          <Select id="deal-customer" value={f.customerId} onChange={(e) => set("customerId", e.target.value)}>
            <option value="">— none yet —</option>
            {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </Field>
        <Field label="Stage" htmlFor="deal-stage">
          <Select id="deal-stage" value={f.stageId} onChange={(e) => set("stageId", e.target.value)}>
            {openStages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
        </Field>
        <Field label="Value (KES)" htmlFor="deal-value">
          <Input id="deal-value" type="number" min={0} step="1" value={f.value} onChange={(e) => set("value", e.target.value)} />
        </Field>
        <Field label="Owner" htmlFor="deal-owner">
          <Select id="deal-owner" value={f.ownerId} onChange={(e) => set("ownerId", e.target.value)}>
            <option value="">— unassigned —</option>
            {reps.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </Select>
        </Field>
        <Field label="Expected close" htmlFor="deal-close">
          <Input id="deal-close" type="date" value={f.expectedCloseAt} onChange={(e) => set("expectedCloseAt", e.target.value)} />
        </Field>
      </div>
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <div className="flex justify-end gap-2 border-t border-border pt-3">
        <Button type="button" variant="ghost" onClick={() => onClose(false)} disabled={busy}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={busy || !f.title.trim()}>{busy ? "Saving…" : "Create deal"}</Button>
      </div>
    </form>
  );
}

/** Inline stage mover on a deal card. Landing on Won/Lost closes the deal. */
export function DealStageSelect({ dealId, stageId, stages }: { dealId: string; stageId: string; stages: StageOption[] }) {
  const router = useRouter();
  const { busy, submit } = useFormSubmit();
  return (
    <Select
      aria-label="Move deal to stage"
      value={stageId}
      disabled={busy}
      onChange={async (e) => {
        const ok = await submit(() => apiClient(`/api/v1/deals/${dealId}/move`, { method: "POST", body: { stageId: e.target.value } }), {});
        if (ok) router.refresh();
      }}
    >
      {stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
    </Select>
  );
}

// ── tasks ──────────────────────────────────────────────────────────────────

export function NewTaskDialog({ users, customers, label = "+ New task", customerId }: { users: Option[]; customers?: Option[]; label?: string; customerId?: string }) {
  return (
    <ModalButton label={label} title="New task" description="A follow-up or to-do, assignable to a teammate." width="max-w-lg">
      {(close) => <TaskForm users={users} customers={customers} fixedCustomerId={customerId} onClose={close} />}
    </ModalButton>
  );
}

function TaskForm({ users, customers, fixedCustomerId, onClose }: { users: Option[]; customers?: Option[]; fixedCustomerId?: string; onClose: (saved: boolean) => void }) {
  const router = useRouter();
  const { busy, error, submit } = useFormSubmit();
  const [f, setF] = useState({ title: "", dueAt: "", priority: "NORMAL", assignedToId: "", customerId: fixedCustomerId ?? "", description: "" });
  const set = (k: keyof typeof f, v: string) => setF((s) => ({ ...s, [k]: v }));

  async function save() {
    await submit(
      () =>
        apiClient("/api/v1/tasks", {
          method: "POST",
          body: {
            title: f.title.trim(),
            dueAt: f.dueAt || null,
            priority: f.priority,
            assignedToId: f.assignedToId || null,
            customerId: f.customerId || null,
            description: f.description || null,
          },
        }),
      { onSuccess: () => { onClose(true); router.refresh(); } },
    );
  }

  return (
    <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <Field label="Title" htmlFor="task-title" required>
        <Input id="task-title" value={f.title} onChange={(e) => set("title", e.target.value)} required minLength={2} />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Due" htmlFor="task-due">
          <Input id="task-due" type="datetime-local" value={f.dueAt} onChange={(e) => set("dueAt", e.target.value)} />
        </Field>
        <Field label="Priority" htmlFor="task-priority">
          <Select id="task-priority" value={f.priority} onChange={(e) => set("priority", e.target.value)}>
            <option value="LOW">Low</option>
            <option value="NORMAL">Normal</option>
            <option value="HIGH">High</option>
          </Select>
        </Field>
        <Field label="Assign to" htmlFor="task-assignee">
          <Select id="task-assignee" value={f.assignedToId} onChange={(e) => set("assignedToId", e.target.value)}>
            <option value="">— me —</option>
            {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </Select>
        </Field>
        {customers && !fixedCustomerId ? (
          <Field label="Customer" htmlFor="task-customer">
            <Select id="task-customer" value={f.customerId} onChange={(e) => set("customerId", e.target.value)}>
              <option value="">— none —</option>
              {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </Field>
        ) : null}
      </div>
      <Field label="Notes" htmlFor="task-notes">
        <Textarea id="task-notes" rows={2} value={f.description} onChange={(e) => set("description", e.target.value)} />
      </Field>
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <div className="flex justify-end gap-2 border-t border-border pt-3">
        <Button type="button" variant="ghost" onClick={() => onClose(false)} disabled={busy}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={busy || !f.title.trim()}>{busy ? "Saving…" : "Create task"}</Button>
      </div>
    </form>
  );
}

export function TaskStatusButton({ taskId, status }: { taskId: string; status: string }) {
  const router = useRouter();
  const { busy, submit } = useFormSubmit();
  const done = status === "DONE";
  return (
    <Button
      variant={done ? "ghost" : "secondary"}
      size="sm"
      disabled={busy}
      onClick={async () => {
        const ok = await submit(
          () => apiClient(`/api/v1/tasks/${taskId}`, { method: "PATCH", body: { status: done ? "OPEN" : "DONE" } }),
          {},
        );
        if (ok) router.refresh();
      }}
    >
      {done ? "Reopen" : "Mark done"}
    </Button>
  );
}
