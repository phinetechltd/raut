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

export interface UserShape {
  id?: string;
  name: string;
  email?: string;
  phone?: string | null;
  role: string;
  branchId?: string | null;
  status: string;
}

const ROLES = [
  { value: "COMPANY_ADMIN", label: "Company Admin" },
  { value: "BRANCH_MANAGER", label: "Branch Manager" },
  { value: "SALES_MANAGER", label: "Sales Manager" },
  { value: "ACCOUNTANT", label: "Accountant" },
  { value: "STOREKEEPER", label: "Storekeeper" },
  { value: "FIELD_REP", label: "Field Sales Rep" },
];

/** Invite a user (create) or edit their role/branch/contact details. */
export function UserDialog({
  mode,
  user,
  branches,
  canSee,
}: {
  mode: "create" | "edit";
  user?: UserShape;
  branches: Option[];
  canSee?: { seatsUsed: number; seatsLimit: number };
}) {
  const seatHint =
    mode === "create" && canSee
      ? `${canSee.seatsUsed} of ${canSee.seatsLimit} licensed seats in use.`
      : undefined;

  return (
    <ModalButton
      label={mode === "create" ? "+ Invite user" : "Edit"}
      title={mode === "create" ? "Invite a user" : `Edit ${user?.name ?? "user"}`}
      description={seatHint}
      variant={mode === "edit" ? "ghost" : "primary"}
      width="max-w-xl"
    >
      {(close) => <UserForm mode={mode} user={user} branches={branches} onClose={() => close()} />}
    </ModalButton>
  );
}

function UserForm({
  mode,
  user,
  branches,
  onClose,
}: {
  mode: "create" | "edit";
  user?: UserShape;
  branches: Option[];
  onClose: () => void;
}) {
  const { busy, error, submit } = useFormSubmit();
  const [form, setForm] = useState({
    name: user?.name ?? "",
    email: user?.email ?? "",
    phone: user?.phone ?? "",
    role: user?.role ?? "FIELD_REP",
    branchId: user?.branchId ?? "",
    password: "",
  });
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));

  async function save() {
    await submit(async () => {
      const body: Record<string, unknown> = {
        name: form.name.trim(),
        phone: form.phone || null,
        role: form.role,
        branchId: form.branchId || null,
      };
      if (mode === "create") {
        body.email = form.email.trim().toLowerCase();
        body.password = form.password;
        return await apiClient("/api/v1/users", { method: "POST", body });
      }
      if (form.password) body.password = form.password;
      return await apiClient(`/api/v1/users/${user!.id}`, { method: "PATCH", body });
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
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Full name" htmlFor="usr-name" required>
          <Input id="usr-name" value={form.name} onChange={(e) => set("name", e.target.value)} required minLength={2} />
        </Field>
        <Field label="Email" htmlFor="usr-email" required={mode === "create"} hint={mode === "edit" ? "Sign-in identity — not editable" : undefined}>
          <Input
            id="usr-email"
            type="email"
            value={form.email}
            onChange={(e) => set("email", e.target.value)}
            required={mode === "create"}
            disabled={mode === "edit"}
          />
        </Field>
        <Field label="Phone" htmlFor="usr-phone">
          <Input id="usr-phone" value={form.phone} onChange={(e) => set("phone", e.target.value)} placeholder="+254…" />
        </Field>
        <Field label="Branch" htmlFor="usr-branch">
          <Select id="usr-branch" value={form.branchId} onChange={(e) => set("branchId", e.target.value)}>
            <option value="">— head office —</option>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </Select>
        </Field>
        <Field label="Role" htmlFor="usr-role" required>
          <Select id="usr-role" value={form.role} onChange={(e) => set("role", e.target.value)}>
            {ROLES.map((r) => (
              <option key={r.value} value={r.value}>{r.label}</option>
            ))}
          </Select>
        </Field>
        <Field
          label={mode === "create" ? "Temporary password" : "New password"}
          htmlFor="usr-password"
          required={mode === "create"}
          hint={mode === "edit" ? "Leave blank to keep the current one" : "At least 8 characters; share it with them directly"}
        >
          <Input
            id="usr-password"
            type="password"
            value={form.password}
            onChange={(e) => set("password", e.target.value)}
            required={mode === "create"}
            minLength={mode === "create" ? 8 : undefined}
            autoComplete="new-password"
          />
        </Field>
      </div>

      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <div className="flex items-center justify-end gap-2 border-t border-border pt-3">
        <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button
          type="submit"
          variant="primary"
          disabled={
            busy ||
            !form.name.trim() ||
            (mode === "create" && (!form.email.trim() || form.password.length < 8))
          }
        >
          {busy ? "Saving…" : mode === "create" ? "Invite user" : "Save changes"}
        </Button>
      </div>
    </form>
  );
}

/** Suspend / reactivate a user account. Suspension revokes access immediately. */
export function UserStatusButton({ user }: { user: UserShape & { id: string } }) {
  const router = useRouter();
  const { busy, error, submit } = useFormSubmit();
  const [open, setOpen] = useState(false);
  const suspending = user.status !== "SUSPENDED";

  return (
    <>
      <Button
        variant={suspending ? "ghost" : "secondary"}
        size="sm"
        onClick={() => setOpen(true)}
      >
        {suspending ? "Suspend" : "Reactivate"}
      </Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={`${suspending ? "Suspend" : "Reactivate"} ${user.name}?`}
        width="max-w-md"
      >
        <div className="space-y-3">
          <p className="text-sm text-content-secondary">
            {suspending
              ? "They are signed out on their next request and cannot log in until reactivated. Their history stays intact."
              : "They can sign in again immediately. The seat limit still applies."}
          </p>
          {error ? <p className="text-sm text-danger">{error}</p> : null}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>Cancel</Button>
            <Button
              variant={suspending ? "danger" : "primary"}
              disabled={busy}
              onClick={async () => {
                const ok = await submit(
                  () =>
                    apiClient(`/api/v1/users/${user.id}`, {
                      method: "PATCH",
                      body: { status: suspending ? "SUSPENDED" : "ACTIVE" },
                    }),
                  {},
                );
                if (ok) setOpen(false);
                router.refresh();
              }}
            >
              {busy ? "Working…" : suspending ? "Suspend account" : "Reactivate account"}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
