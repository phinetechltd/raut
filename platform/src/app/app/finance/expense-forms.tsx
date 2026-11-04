"use client";

import { useState } from "react";

import {
  apiClient,
  useFormSubmit,
  Button,
  Field,
  Input,
  ModalButton,
  Modal,
  Select,
  Textarea,
} from "@/components/ui";

interface Option {
  id: string;
  name: string;
}

/** Back-office expense — journal-inked to the cash account it came from. */
export function ExpenseDialog({ categories, buttonLabel }: { categories: Option[]; buttonLabel?: string }) {
  return (
    <ModalButton
      label={buttonLabel ?? "+ New expense"}
      title="New expense"
      description="Recorded as submitted for approval. Approved expenses hit the ledger."
      width="max-w-lg"
    >
      {(close) => <ExpenseForm categories={categories} onClose={() => close()} />}
    </ModalButton>
  );
}

function ExpenseForm({ categories, onClose }: { categories: Option[]; onClose: () => void }) {
  const { busy, error, submit } = useFormSubmit();
  const [form, setForm] = useState({
    description: "",
    amount: "",
    categoryId: categories[0]?.id ?? "",
    incurredAt: new Date().toISOString().slice(0, 10),
    paymentMethod: "CASH",
    note: "",
  });
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));

  async function save() {
    await submit(async () => {
      return await apiClient("/api/v1/expenses", {
        method: "POST",
        body: {
          description: form.description.trim(),
          amountCents: Math.round((Number(form.amount) || 0) * 100),
          categoryId: form.categoryId || undefined,
          incurredAt: form.incurredAt,
          paymentMethod: form.paymentMethod,
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
      <Field label="Description" htmlFor="exp-desc" required>
        <Input id="exp-desc" value={form.description} onChange={(e) => set("description", e.target.value)} required minLength={2} placeholder="Fuel for Kisumu route" />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Amount (KES)" htmlFor="exp-amount" required>
          <Input id="exp-amount" type="number" min={0.01} step="0.01" value={form.amount} onChange={(e) => set("amount", e.target.value)} required />
        </Field>
        <Field label="Date incurred" htmlFor="exp-date" required>
          <Input id="exp-date" type="date" value={form.incurredAt} onChange={(e) => set("incurredAt", e.target.value)} required />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Category" htmlFor="exp-cat">
          <Select id="exp-cat" value={form.categoryId} onChange={(e) => set("categoryId", e.target.value)}>
            <option value="">— uncategorised —</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </Select>
        </Field>
        <Field label="Paid by" htmlFor="exp-method">
          <Select id="exp-method" value={form.paymentMethod} onChange={(e) => set("paymentMethod", e.target.value)}>
            <option value="CASH">Cash</option>
            <option value="MPESA">M-Pesa</option>
            <option value="BANK">Bank transfer</option>
            <option value="PETTY_CASH">Petty cash</option>
          </Select>
        </Field>
      </div>

      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <div className="flex items-center justify-end gap-2 border-t border-border pt-3">
        <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={busy || !form.description.trim() || !(Number(form.amount) > 0)}>
          {busy ? "Saving…" : "Submit expense"}
        </Button>
      </div>
    </form>
  );
}

/** Approve / reject a submitted claim. The API posts ledger entries on approve. */
export function ExpenseDecisionButtons({ expenseId, amountTitle }: { expenseId: string; amountTitle: string }) {
  const { busy, error, submit } = useFormSubmit();
  const [rejectOpen, setRejectOpen] = useState(false);
  const [reason, setReason] = useState("");

  const decide = async (decision: "APPROVED" | "REJECTED") => {
    const ok = await submit(
      () =>
        apiClient(`/api/v1/expenses/${expenseId}/decision`, {
          method: "POST",
          body: { decision, reason: decision === "REJECTED" ? reason || undefined : undefined },
        }),
      {},
    );
    if (ok) setRejectOpen(false);
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex gap-1">
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => void decide("APPROVED")}>
          Approve
        </Button>
        <Button size="sm" variant="ghost" className="text-danger" disabled={busy} onClick={() => setRejectOpen(true)}>
          Reject
        </Button>
      </div>
      {error ? <p className="text-xs text-danger">{error}</p> : null}
      <Modal open={rejectOpen} onClose={() => setRejectOpen(false)} title={`Reject ${amountTitle}?`} width="max-w-sm">
        <div className="space-y-3">
          <Field label="Reason" htmlFor="exp-reject-reason">
            <Textarea id="exp-reject-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Receipt missing, policy…" />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setRejectOpen(false)} disabled={busy}>Cancel</Button>
            <Button variant="danger" size="sm" disabled={busy} onClick={() => void decide("REJECTED")}>
              {busy ? "Working…" : "Reject claim"}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
