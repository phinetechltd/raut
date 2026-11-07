"use client";

import { useMemo, useRef, useState } from "react";

import { Button, Field, Input, ModalButton, Select, Textarea, apiClient, useFormSubmit } from "@/components/ui";
import { parseAmountToCents } from "@/lib/accounting";

export interface AccountOption {
  id: string;
  label: string;
}

interface Row {
  key: number;
  accountId: string;
  debit: string;
  credit: string;
  memo: string;
}

const money = (cents: number) =>
  (cents / 100).toLocaleString("en-KE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** A manual journal. It can only be saved when it balances. */
export function JournalDialog({ accounts, today }: { accounts: AccountOption[]; today: string }) {
  return (
    <ModalButton
      label="+ New journal"
      title="New journal entry"
      description="Debits and credits must be equal. Receivables, payables and stock are changed through their own documents."
      width="max-w-3xl"
    >
      {(close) => <JournalForm accounts={accounts} today={today} onClose={close} />}
    </ModalButton>
  );
}

function JournalForm({ accounts, today, onClose }: { accounts: AccountOption[]; today: string; onClose: () => void }) {
  const { busy, error, submit } = useFormSubmit();
  const nextKey = useRef(2);
  // One reference per form, so a double click or a retried save posts only once.
  const clientUuid = useRef(crypto.randomUUID());
  const [date, setDate] = useState(today);
  const [memo, setMemo] = useState("");
  const [rows, setRows] = useState<Row[]>([
    { key: 0, accountId: "", debit: "", credit: "", memo: "" },
    { key: 1, accountId: "", debit: "", credit: "", memo: "" },
  ]);

  const update = (key: number, patch: Partial<Row>) =>
    setRows((current) => current.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  const totals = useMemo(() => {
    let debit = 0;
    let credit = 0;
    let valid = true;
    for (const row of rows) {
      const d = parseAmountToCents(row.debit);
      const c = parseAmountToCents(row.credit);
      if (d === null || c === null) {
        valid = false;
        continue;
      }
      debit += d;
      credit += c;
    }
    return { debit, credit, valid };
  }, [rows]);

  const difference = totals.debit - totals.credit;
  const complete =
    totals.valid &&
    difference === 0 &&
    totals.debit > 0 &&
    memo.trim().length >= 3 &&
    rows.every((r) => r.accountId && ((parseAmountToCents(r.debit) ?? 0) > 0) !== ((parseAmountToCents(r.credit) ?? 0) > 0));

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        void submit(
          () =>
            apiClient("/api/v1/finance/journal", {
              method: "POST",
              body: {
                date,
                memo: memo.trim(),
                clientUuid: clientUuid.current,
                lines: rows.map((r) => ({
                  accountId: r.accountId,
                  debitCents: parseAmountToCents(r.debit) ?? 0,
                  creditCents: parseAmountToCents(r.credit) ?? 0,
                  memo: r.memo.trim() || null,
                })),
              },
            }),
          { onSuccess: onClose },
        );
      }}
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Date" htmlFor="jv-date" required>
          <Input id="jv-date" type="date" value={date} max={today} onChange={(e) => setDate(e.target.value)} required />
        </Field>
        <div className="sm:col-span-2">
          <Field label="Narration" htmlFor="jv-memo" required hint="Why this entry is being made">
            <Textarea id="jv-memo" rows={1} value={memo} onChange={(e) => setMemo(e.target.value)} maxLength={200} required />
          </Field>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-content-muted">
              <th className="pb-1 pr-2 font-medium">Account</th>
              <th className="pb-1 pr-2 font-medium">Line note</th>
              <th className="pb-1 pr-2 text-right font-medium">Debit</th>
              <th className="pb-1 pr-2 text-right font-medium">Credit</th>
              <th className="pb-1">
                <span className="sr-only">Remove</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={row.key}>
                <td className="py-1 pr-2">
                  <Select
                    aria-label={`Account, line ${index + 1}`}
                    value={row.accountId}
                    onChange={(e) => update(row.key, { accountId: e.target.value })}
                  >
                    <option value="">Choose account…</option>
                    {accounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.label}
                      </option>
                    ))}
                  </Select>
                </td>
                <td className="py-1 pr-2">
                  <Input
                    aria-label={`Note, line ${index + 1}`}
                    value={row.memo}
                    maxLength={120}
                    onChange={(e) => update(row.key, { memo: e.target.value })}
                  />
                </td>
                <td className="w-32 py-1 pr-2">
                  <Input
                    aria-label={`Debit, line ${index + 1}`}
                    inputMode="decimal"
                    className="text-right"
                    value={row.debit}
                    onChange={(e) => update(row.key, { debit: e.target.value, credit: e.target.value ? "" : row.credit })}
                  />
                </td>
                <td className="w-32 py-1 pr-2">
                  <Input
                    aria-label={`Credit, line ${index + 1}`}
                    inputMode="decimal"
                    className="text-right"
                    value={row.credit}
                    onChange={(e) => update(row.key, { credit: e.target.value, debit: e.target.value ? "" : row.debit })}
                  />
                </td>
                <td className="py-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={rows.length <= 2}
                    aria-label={`Remove line ${index + 1}`}
                    onClick={() => setRows((current) => current.filter((r) => r.key !== row.key))}
                  >
                    ×
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-border font-semibold">
              <td className="py-2 pr-2" colSpan={2}>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setRows((current) => [...current, { key: nextKey.current, accountId: "", debit: "", credit: "", memo: "" }]);
                    nextKey.current += 1;
                  }}
                >
                  + Add line
                </Button>
              </td>
              <td className="tabular py-2 pr-2 text-right">{money(totals.debit)}</td>
              <td className="tabular py-2 pr-2 text-right">{money(totals.credit)}</td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>

      <p role="status" className={difference === 0 ? "text-sm text-content-muted" : "text-sm text-danger"}>
        {!totals.valid
          ? "One of the amounts is not a valid number."
          : difference === 0
            ? "This entry balances."
            : `Out of balance by ${money(Math.abs(difference))}.`}
      </p>

      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <div className="flex items-center justify-end gap-2 border-t border-border pt-3">
        <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={busy || !complete}>
          {busy ? "Posting…" : "Post journal"}
        </Button>
      </div>
    </form>
  );
}

/** A posted journal is never changed. Correcting one writes its mirror image. */
export function ReverseJournalDialog({ id, number }: { id: string; number: string }) {
  return (
    <ModalButton
      label="Reverse"
      title={`Reverse ${number}`}
      description="This posts an equal and opposite entry dated today. The original stays on the record."
      variant="secondary"
      width="max-w-md"
    >
      {(close) => <ReverseForm id={id} onClose={close} />}
    </ModalButton>
  );
}

function ReverseForm({ id, onClose }: { id: string; onClose: () => void }) {
  const { busy, error, submit } = useFormSubmit();
  const [reason, setReason] = useState("");
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        void submit(
          () => apiClient(`/api/v1/finance/journal/${id}/reverse`, { method: "POST", body: { reason: reason.trim() } }),
          { onSuccess: onClose },
        );
      }}
    >
      <Field label="Reason" htmlFor="rv-reason" required>
        <Input id="rv-reason" value={reason} onChange={(e) => setReason(e.target.value)} minLength={3} maxLength={200} required />
      </Field>
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" variant="danger" disabled={busy || reason.trim().length < 3}>
          {busy ? "Reversing…" : "Reverse journal"}
        </Button>
      </div>
    </form>
  );
}
