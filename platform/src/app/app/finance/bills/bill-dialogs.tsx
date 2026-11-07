"use client";

import { useRef, useState } from "react";

import { Button, Field, Input, ModalButton, Select, apiClient, useFormSubmit } from "@/components/ui";
import { parseAmountToCents } from "@/lib/accounting";

interface Option {
  id: string;
  name: string;
}

const money = (cents: number) =>
  (cents / 100).toLocaleString("en-KE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function NewBillDialog({
  suppliers,
  expenseAccounts,
  today,
}: {
  suppliers: Option[];
  expenseAccounts: Option[];
  today: string;
}) {
  return (
    <ModalButton
      label="+ Enter a bill"
      title="Enter a supplier bill"
      description="Records what is owed and the input VAT you can claim. Copy the figures from the supplier's tax invoice."
      width="max-w-lg"
    >
      {(close) => <BillForm suppliers={suppliers} expenseAccounts={expenseAccounts} today={today} onClose={close} />}
    </ModalButton>
  );
}

function BillForm({
  suppliers,
  expenseAccounts,
  today,
  onClose,
}: {
  suppliers: Option[];
  expenseAccounts: Option[];
  today: string;
  onClose: () => void;
}) {
  const { busy, error, submit } = useFormSubmit();
  const [supplierId, setSupplierId] = useState("");
  const [supplierRef, setSupplierRef] = useState("");
  const [issueDate, setIssueDate] = useState(today);
  const [dueDate, setDueDate] = useState("");
  const [net, setNet] = useState("");
  const [tax, setTax] = useState("");
  const [account, setAccount] = useState("");

  const netCents = parseAmountToCents(net);
  const taxCents = parseAmountToCents(tax);
  const total = (netCents ?? 0) + (taxCents ?? 0);
  const valid = supplierId && supplierRef.trim() && netCents !== null && taxCents !== null && total > 0;

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        void submit(
          () =>
            apiClient("/api/v1/supplier-invoices", {
              method: "POST",
              body: {
                supplierId,
                supplierRef: supplierRef.trim(),
                issueDate,
                dueDate: dueDate || null,
                netCents: netCents ?? 0,
                taxCents: taxCents ?? 0,
                expenseAccountId: account || null,
              },
            }),
          { onSuccess: onClose },
        );
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Supplier" htmlFor="bl-supplier" required>
          <Select id="bl-supplier" value={supplierId} onChange={(e) => setSupplierId(e.target.value)} required>
            <option value="">Choose supplier…</option>
            {suppliers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Supplier's invoice number" htmlFor="bl-ref" required>
          <Input id="bl-ref" value={supplierRef} onChange={(e) => setSupplierRef(e.target.value)} maxLength={60} required />
        </Field>
        <Field label="Invoice date" htmlFor="bl-date" required>
          <Input id="bl-date" type="date" value={issueDate} max={today} onChange={(e) => setIssueDate(e.target.value)} required />
        </Field>
        <Field label="Due date" htmlFor="bl-due" hint="Blank uses the supplier's terms">
          <Input id="bl-due" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
        </Field>
        <Field label="Amount excluding VAT" htmlFor="bl-net" required>
          <Input id="bl-net" inputMode="decimal" className="text-right" value={net} onChange={(e) => setNet(e.target.value)} required />
        </Field>
        <Field label="VAT" htmlFor="bl-tax" hint="As shown on the invoice">
          <Input id="bl-tax" inputMode="decimal" className="text-right" value={tax} onChange={(e) => setTax(e.target.value)} />
        </Field>
      </div>
      <Field label="What is this bill for?" htmlFor="bl-account">
        <Select id="bl-account" value={account} onChange={(e) => setAccount(e.target.value)}>
          <option value="">Stock received through a goods receipt</option>
          {expenseAccounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </Select>
      </Field>
      <p className="text-sm font-semibold">Bill total {money(total)}</p>
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <div className="flex items-center justify-end gap-2 border-t border-border pt-3">
        <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={busy || !valid}>
          {busy ? "Saving…" : "Save bill"}
        </Button>
      </div>
    </form>
  );
}

export function PayBillDialog({
  id,
  number,
  outstandingCents,
  today,
}: {
  id: string;
  number: string;
  outstandingCents: number;
  today: string;
}) {
  return (
    <ModalButton label="Pay" title={`Pay ${number}`} description={`${money(outstandingCents)} outstanding.`} variant="ghost" width="max-w-md">
      {(close) => <PayForm id={id} outstandingCents={outstandingCents} today={today} onClose={close} />}
    </ModalButton>
  );
}

function PayForm({
  id,
  outstandingCents,
  today,
  onClose,
}: {
  id: string;
  outstandingCents: number;
  today: string;
  onClose: () => void;
}) {
  const { busy, error, submit } = useFormSubmit();
  const clientUuid = useRef(crypto.randomUUID());
  const [amount, setAmount] = useState((outstandingCents / 100).toFixed(2));
  const [paidAt, setPaidAt] = useState(today);
  const [account, setAccount] = useState<"BANK" | "CASH">("BANK");
  const [reference, setReference] = useState("");
  const cents = parseAmountToCents(amount);

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        void submit(
          () =>
            apiClient(`/api/v1/supplier-invoices/${id}/payments`, {
              method: "POST",
              body: {
                amountCents: cents ?? 0,
                paidAt,
                account,
                reference: reference.trim() || null,
                clientUuid: clientUuid.current,
              },
            }),
          { onSuccess: onClose },
        );
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Amount" htmlFor="pb-amount" required>
          <Input id="pb-amount" inputMode="decimal" className="text-right" value={amount} onChange={(e) => setAmount(e.target.value)} required />
        </Field>
        <Field label="Date paid" htmlFor="pb-date" required>
          <Input id="pb-date" type="date" value={paidAt} max={today} onChange={(e) => setPaidAt(e.target.value)} required />
        </Field>
        <Field label="Paid from" htmlFor="pb-account" required>
          <Select id="pb-account" value={account} onChange={(e) => setAccount(e.target.value as "BANK" | "CASH")}>
            <option value="BANK">Bank</option>
            <option value="CASH">Cash</option>
          </Select>
        </Field>
        <Field label="Reference" htmlFor="pb-ref">
          <Input id="pb-ref" value={reference} onChange={(e) => setReference(e.target.value)} maxLength={60} />
        </Field>
      </div>
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <div className="flex items-center justify-end gap-2 border-t border-border pt-3">
        <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={busy || !cents || cents > outstandingCents}>
          {busy ? "Saving…" : "Record payment"}
        </Button>
      </div>
    </form>
  );
}

/** Only an unpaid bill can be voided: paid money has to be dealt with first. */
export function VoidBillDialog({ id, number }: { id: string; number: string }) {
  return (
    <ModalButton label="Void" title={`Void ${number}`} description="For a bill entered by mistake. Its ledger entry is reversed today." variant="ghost" width="max-w-md">
      {(close) => <VoidForm id={id} onClose={close} />}
    </ModalButton>
  );
}

function VoidForm({ id, onClose }: { id: string; onClose: () => void }) {
  const { busy, error, submit } = useFormSubmit();
  const [reason, setReason] = useState("");
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        void submit(() => apiClient(`/api/v1/supplier-invoices/${id}/void`, { method: "POST", body: { reason: reason.trim() } }), {
          onSuccess: onClose,
        });
      }}
    >
      <Field label="Reason" htmlFor="vb-reason" required>
        <Input id="vb-reason" value={reason} onChange={(e) => setReason(e.target.value)} minLength={3} maxLength={200} required />
      </Field>
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" variant="danger" disabled={busy || reason.trim().length < 3}>
          {busy ? "Voiding…" : "Void bill"}
        </Button>
      </div>
    </form>
  );
}
