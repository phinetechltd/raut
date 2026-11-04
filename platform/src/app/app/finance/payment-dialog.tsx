"use client";

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

interface Option {
  id: string;
  name: string;
  balanceCents?: number;
}

/**
 * Record a payment against a customer. Without lane allocations the payment
 * allocates oldest-due-first server-side — the ledger and the receivable
 * update in one transaction, and the optional invoice id scopes it.
 */
export function PaymentDialog({
  customers,
  presetCustomerId,
  buttonLabel = "+ Record payment",
  buttonVariant = "primary",
}: {
  customers: Option[];
  presetCustomerId?: string;
  buttonLabel?: string;
  buttonVariant?: "primary" | "secondary" | "ghost" | "danger";
}) {
  return (
    <ModalButton
      label={buttonLabel}
      title="Record a payment"
      description="Oldest-due-first allocation is automatic unless an invoice is named."
      variant={buttonVariant}
      width="max-w-lg"
    >
      {(close) => (
        <PaymentForm customers={customers} presetCustomerId={presetCustomerId} onClose={() => close()} />
      )}
    </ModalButton>
  );
}

function PaymentForm({
  customers,
  presetCustomerId,
  onClose,
}: {
  customers: Option[];
  presetCustomerId?: string;
  onClose: () => void;
}) {
  const { busy, error, submit } = useFormSubmit();
  const [form, setForm] = useState({
    customerId: presetCustomerId ?? customers[0]?.id ?? "",
    amount: "",
    method: "MPESA",
    reference: "",
    paidAt: new Date().toISOString().slice(0, 10),
    note: "",
  });
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));

  async function save() {
    await submit(async () => {
      return await apiClient("/api/v1/payments", {
        method: "POST",
        body: {
          customerId: form.customerId,
          amountCents: Math.round((Number(form.amount) || 0) * 100),
          method: form.method,
          reference: form.reference || undefined,
          paidAt: form.paidAt,
          note: form.note || undefined,
          clientUuid: crypto.randomUUID(),
        },
      });
    }, { onSuccess: onClose });
  }

  const preset = customers.find((c) => c.id === form.customerId);

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <Field label="Customer" htmlFor="pay-customer" required>
        <Select
          id="pay-customer"
          value={form.customerId}
          onChange={(e) => set("customerId", e.target.value)}
          disabled={!!presetCustomerId}
        >
          {customers.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </Select>
      </Field>
      {preset?.balanceCents != null && (
        <p className="text-sm text-content-muted">
          Outstanding balance: <strong>{(preset.balanceCents / 100).toLocaleString("en-KE", { style: "currency", currency: "KES" })}</strong>
        </p>
      )}
      <div className="grid grid-cols-2 gap-3">
        <Field label="Amount (KES)" htmlFor="pay-amount" required>
          <Input id="pay-amount" type="number" min={0.01} step="0.01" value={form.amount} onChange={(e) => set("amount", e.target.value)} required />
        </Field>
        <Field label="Method" htmlFor="pay-method">
          <Select id="pay-method" value={form.method} onChange={(e) => set("method", e.target.value)}>
            <option value="MPESA">M-Pesa</option>
            <option value="CASH">Cash</option>
            <option value="BANK">Bank transfer</option>
            <option value="CHEQUE">Cheque</option>
          </Select>
        </Field>
        <Field label="Reference" htmlFor="pay-ref" hint="M-Pesa code, cheque number…">
          <Input id="pay-ref" value={form.reference} onChange={(e) => set("reference", e.target.value)} />
        </Field>
        <Field label="Date paid" htmlFor="pay-date">
          <Input id="pay-date" type="date" value={form.paidAt} onChange={(e) => set("paidAt", e.target.value)} required />
        </Field>
      </div>
      <Field label="Note" htmlFor="pay-note">
        <Textarea id="pay-note" rows={2} value={form.note} onChange={(e) => set("note", e.target.value)} />
      </Field>

      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <div className="flex items-center justify-end gap-2 border-t border-border pt-3">
        <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={busy || !form.customerId || !(Number(form.amount) > 0)}>
          {busy ? "Recording…" : "Record payment"}
        </Button>
      </div>
    </form>
  );
}
