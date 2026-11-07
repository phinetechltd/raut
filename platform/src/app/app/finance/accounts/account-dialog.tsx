"use client";

import { useState } from "react";

import { Button, Field, Input, ModalButton, Select, apiClient, useFormSubmit } from "@/components/ui";
import { ACCOUNT_TYPES, ACCOUNT_TYPE_LABELS, accountCodeProblem, type AccountTypeName } from "@/lib/accounting";

export function NewAccountDialog() {
  return (
    <ModalButton label="+ New account" title="Add an account" description="The first digit of the code says what kind of account it is." width="max-w-md">
      {(close) => <NewAccountForm onClose={close} />}
    </ModalButton>
  );
}

function NewAccountForm({ onClose }: { onClose: () => void }) {
  const { busy, error, submit } = useFormSubmit();
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [type, setType] = useState<AccountTypeName>("EXPENSE");
  const problem = code ? accountCodeProblem(code, type) : null;

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        void submit(
          () => apiClient("/api/v1/finance/accounts", { method: "POST", body: { code: code.trim(), name: name.trim(), type } }),
          { onSuccess: onClose },
        );
      }}
    >
      <Field label="Type" htmlFor="ac-type" required>
        <Select id="ac-type" value={type} onChange={(e) => setType(e.target.value as AccountTypeName)}>
          {ACCOUNT_TYPES.map((t) => (
            <option key={t} value={t}>
              {ACCOUNT_TYPE_LABELS[t]}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Code" htmlFor="ac-code" required hint={problem ?? "4 to 6 digits, for example 6100"}>
        <Input id="ac-code" value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" className="font-mono" required />
      </Field>
      <Field label="Name" htmlFor="ac-name" required>
        <Input id="ac-name" value={name} onChange={(e) => setName(e.target.value)} minLength={2} maxLength={80} placeholder="Rent" required />
      </Field>
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <div className="flex items-center justify-end gap-2 border-t border-border pt-3">
        <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={busy || !code || Boolean(problem) || name.trim().length < 2}>
          {busy ? "Saving…" : "Add account"}
        </Button>
      </div>
    </form>
  );
}

export function EditAccountDialog({
  id,
  code,
  name,
  active,
  system,
}: {
  id: string;
  code: string;
  name: string;
  active: boolean;
  system: boolean;
}) {
  return (
    <ModalButton label="Edit" title={`Account ${code}`} variant="ghost" width="max-w-md">
      {(close) => <EditAccountForm id={id} initialName={name} initialActive={active} system={system} onClose={close} />}
    </ModalButton>
  );
}

function EditAccountForm({
  id,
  initialName,
  initialActive,
  system,
  onClose,
}: {
  id: string;
  initialName: string;
  initialActive: boolean;
  system: boolean;
  onClose: () => void;
}) {
  const { busy, error, submit } = useFormSubmit();
  const [name, setName] = useState(initialName);
  const [active, setActive] = useState(initialActive);
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        void submit(
          () => apiClient(`/api/v1/finance/accounts/${id}`, { method: "PATCH", body: { name: name.trim(), active } }),
          { onSuccess: onClose },
        );
      }}
    >
      <Field label="Name" htmlFor="ae-name" required>
        <Input id="ae-name" value={name} onChange={(e) => setName(e.target.value)} minLength={2} maxLength={80} required />
      </Field>
      {system ? (
        <p className="text-sm text-content-muted">Automatic posting uses this account, so it cannot be retired.</p>
      ) : (
        <label className="flex items-center gap-2 text-sm font-medium">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
          Active — an account must be empty before it can be retired
        </label>
      )}
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <div className="flex items-center justify-end gap-2 border-t border-border pt-3">
        <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={busy || name.trim().length < 2}>
          {busy ? "Saving…" : "Save"}
        </Button>
      </div>
    </form>
  );
}
