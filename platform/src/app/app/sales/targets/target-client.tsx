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

interface Option {
  id: string;
  name: string;
}

function monthStart(d = new Date()) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString().slice(0, 10);
}
function monthEnd(d = new Date()) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
}

export function TargetDialog({ reps }: { reps: Option[] }) {
  return (
    <ModalButton label="+ Set target" title="Set a sales target" description="Per rep and period. Achievement is read from the books; commission is a share of sales achieved." width="max-w-lg">
      {(close) => <TargetForm reps={reps} onClose={close} />}
    </ModalButton>
  );
}

function TargetForm({ reps, onClose }: { reps: Option[]; onClose: (saved: boolean) => void }) {
  const router = useRouter();
  const { busy, error, submit } = useFormSubmit();
  const [f, setF] = useState({
    repId: reps[0]?.id ?? "",
    period: "MONTHLY",
    periodStart: monthStart(),
    periodEnd: monthEnd(),
    sales: "",
    collection: "",
    visits: "",
    newCustomers: "",
    commissionPct: "",
  });
  const set = (k: keyof typeof f, v: string) => setF((s) => ({ ...s, [k]: v }));

  async function save() {
    await submit(
      () =>
        apiClient("/api/v1/sales/targets", {
          method: "POST",
          body: {
            repId: f.repId || null,
            period: f.period,
            periodStart: f.periodStart,
            periodEnd: f.periodEnd,
            targetSalesCents: Math.round(Number(f.sales || 0) * 100),
            targetCollectionCents: Math.round(Number(f.collection || 0) * 100),
            targetVisits: Number(f.visits || 0),
            targetNewCustomers: Number(f.newCustomers || 0),
            commissionRateBp: Math.round(Number(f.commissionPct || 0) * 100),
          },
        }),
      { onSuccess: () => { onClose(true); router.refresh(); } },
    );
  }

  return (
    <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Rep" htmlFor="t-rep">
          <Select id="t-rep" value={f.repId} onChange={(e) => set("repId", e.target.value)}>
            <option value="">Whole company</option>
            {reps.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </Select>
        </Field>
        <Field label="Period" htmlFor="t-period">
          <Select id="t-period" value={f.period} onChange={(e) => set("period", e.target.value)}>
            <option value="MONTHLY">Monthly</option>
            <option value="QUARTERLY">Quarterly</option>
            <option value="ANNUAL">Annual</option>
          </Select>
        </Field>
        <Field label="From" htmlFor="t-start" required>
          <Input id="t-start" type="date" value={f.periodStart} onChange={(e) => set("periodStart", e.target.value)} required />
        </Field>
        <Field label="To" htmlFor="t-end" required>
          <Input id="t-end" type="date" value={f.periodEnd} onChange={(e) => set("periodEnd", e.target.value)} required />
        </Field>
        <Field label="Sales target (KES)" htmlFor="t-sales">
          <Input id="t-sales" type="number" min={0} step="1" value={f.sales} onChange={(e) => set("sales", e.target.value)} />
        </Field>
        <Field label="Collection target (KES)" htmlFor="t-coll">
          <Input id="t-coll" type="number" min={0} step="1" value={f.collection} onChange={(e) => set("collection", e.target.value)} />
        </Field>
        <Field label="Visits target" htmlFor="t-visits">
          <Input id="t-visits" type="number" min={0} step="1" value={f.visits} onChange={(e) => set("visits", e.target.value)} />
        </Field>
        <Field label="New customers target" htmlFor="t-newc">
          <Input id="t-newc" type="number" min={0} step="1" value={f.newCustomers} onChange={(e) => set("newCustomers", e.target.value)} />
        </Field>
        <Field label="Commission (% of sales)" htmlFor="t-comm" hint="e.g. 2.5">
          <Input id="t-comm" type="number" min={0} max={100} step="0.1" value={f.commissionPct} onChange={(e) => set("commissionPct", e.target.value)} />
        </Field>
      </div>
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <div className="flex justify-end gap-2 border-t border-border pt-3">
        <Button type="button" variant="ghost" onClick={() => onClose(false)} disabled={busy}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={busy}>{busy ? "Saving…" : "Set target"}</Button>
      </div>
    </form>
  );
}

export function DeleteTargetButton({ id }: { id: string }) {
  const router = useRouter();
  const { busy, submit } = useFormSubmit();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>Remove</Button>
      <Modal open={open} onClose={() => setOpen(false)} title="Remove this target?" width="max-w-sm">
        <div className="space-y-3">
          <p className="text-sm text-content-secondary">The achievement figures stay in the books; only the target is removed.</p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>Cancel</Button>
            <Button variant="danger" disabled={busy} onClick={async () => {
              const ok = await submit(() => apiClient(`/api/v1/sales/targets/${id}`, { method: "DELETE" }), {});
              if (ok) { setOpen(false); router.refresh(); }
            }}>{busy ? "Removing…" : "Remove target"}</Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
