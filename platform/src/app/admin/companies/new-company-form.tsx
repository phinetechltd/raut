"use client";

import { useActionState, useState } from "react";

import { formatKES } from "@/lib/money";
import { CORE_PLATFORM_PRICE_CENTS, MODULE_LIST } from "@/lib/modules";

import { createCompanyAction, type ActionState } from "../actions";

export function NewCompanyForm() {
  const [state, action, pending] = useActionState<ActionState, FormData>(
    createCompanyAction,
    {},
  );
  const [selected, setSelected] = useState<string[]>([]);

  const modulesTotal = MODULE_LIST.filter((m) => selected.includes(m.key)).reduce(
    (sum, m) => sum + m.priceCents,
    0,
  );

  function toggle(key: string) {
    setSelected((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key],
    );
  }

  return (
    <form action={action} className="rounded-lg border border-border bg-surface shadow-sm space-y-6 p-5">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <div>
          <label className="mb-1 block text-sm font-medium" htmlFor="name">Company name *</label>
          <input id="name" name="name" required className="h-10 w-full rounded border border-border bg-surface px-3 text-base" placeholder="Acme Distributors Ltd" />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium" htmlFor="slug">Slug</label>
          <input id="slug" name="slug" className="h-10 w-full rounded border border-border bg-surface px-3 text-base" placeholder="acme (auto from name)" />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium" htmlFor="taxPin">KRA PIN</label>
          <input id="taxPin" name="taxPin" className="h-10 w-full rounded border border-border bg-surface px-3 text-base" placeholder="P051234567X" />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium" htmlFor="email">Company email</label>
          <input id="email" name="email" type="email" className="h-10 w-full rounded border border-border bg-surface px-3 text-base" />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium" htmlFor="phone">Phone</label>
          <input id="phone" name="phone" className="h-10 w-full rounded border border-border bg-surface px-3 text-base" placeholder="+254…" />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium" htmlFor="seatLimit">User seats</label>
          <input
            id="seatLimit"
            name="seatLimit"
            type="number"
            min={1}
            max={10000}
            defaultValue={50}
            className="h-10 w-full rounded border border-border bg-surface px-3 text-base"
          />
        </div>
        <div className="sm:col-span-2 lg:col-span-3">
          <label className="mb-1 block text-sm font-medium" htmlFor="address">Address</label>
          <input id="address" name="address" className="h-10 w-full rounded border border-border bg-surface px-3 text-base" />
        </div>
      </div>

      <div>
        <p className="mb-1 block text-sm font-medium">Administrator account</p>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <input name="adminName" required className="h-10 w-full rounded border border-border bg-surface px-3 text-base" placeholder="Full name *" />
          <input name="adminEmail" type="email" required className="h-10 w-full rounded border border-border bg-surface px-3 text-base" placeholder="Email *" />
          <input name="adminPhone" className="h-10 w-full rounded border border-border bg-surface px-3 text-base" placeholder="Phone" />
          <input
            name="adminPassword"
            type="password"
            required
            minLength={8}
            className="h-10 w-full rounded border border-border bg-surface px-3 text-base"
            placeholder="Password (min 8) *"
          />
        </div>
      </div>

      <div>
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
          <p className="label mb-0">Modules to license</p>
          <p className="text-content-muted text-xs">
            Core platform {formatKES(CORE_PLATFORM_PRICE_CENTS)} + modules{" "}
            {formatKES(modulesTotal)} ={" "}
            <span className="font-semibold text-accent">
              {formatKES(CORE_PLATFORM_PRICE_CENTS + modulesTotal)}
            </span>
          </p>
        </div>

        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {MODULE_LIST.map((m) => {
            const checked = selected.includes(m.key);
            return (
              <label
                key={m.key}
                className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm transition-colors ${
                  checked ? "border-brand-500 bg-brand-500/5" : ""
                }`}
                style={!checked ? { borderColor: "var(--border)" } : undefined}
              >
                <input
                  type="checkbox"
                  name="modules"
                  value={m.key}
                  checked={checked}
                  onChange={() => toggle(m.key)}
                  className="mt-0.5"
                />
                <span className="min-w-0">
                  <span className="block truncate font-medium">
                    <span className="text-content-muted mr-1.5">{m.ordinal}</span>
                    {m.name}
                  </span>
                  <span className="text-content-muted block text-xs">{formatKES(m.priceCents)}</span>
                </span>
              </label>
            );
          })}
        </div>
      </div>

      {state.error ? (
        <p role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">
          {state.error}
        </p>
      ) : null}
      {state.success ? (
        <p role="status" className="rounded-lg bg-accent/10 px-3 py-2 text-sm text-accent">
          {state.success}
        </p>
      ) : null}

      <button type="submit" className="inline-flex h-10 items-center justify-center rounded bg-accent px-4 text-base font-medium text-white transition-colors hover:bg-accent-hover" disabled={pending}>
        {pending ? "Creating…" : "Create company"}
      </button>
    </form>
  );
}
