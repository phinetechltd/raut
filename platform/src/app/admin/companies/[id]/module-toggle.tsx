"use client";

import { useActionState } from "react";

import { formatKES } from "@/lib/money";

import { setStatusAction, toggleModuleAction, type ActionState } from "../../actions";

export function ModuleToggle({
  companyId,
  moduleKey,
  name,
  ordinal,
  priceCents,
  features,
  enabled,
}: {
  companyId: string;
  moduleKey: string;
  name: string;
  ordinal: string;
  priceCents: number;
  features: string[];
  enabled: boolean;
}) {
  const [state, action, pending] = useActionState<ActionState, FormData>(
    toggleModuleAction,
    {},
  );

  return (
    <form
      action={action}
      className={`rounded-lg border p-4 transition-colors ${
        enabled ? "border-accent/40 bg-accent/5" : ""
      }`}
      style={!enabled ? { borderColor: "var(--border)" } : undefined}
    >
      <input type="hidden" name="companyId" value={companyId} />
      <input type="hidden" name="moduleKey" value={moduleKey} />
      <input type="hidden" name="enabled" value={String(!enabled)} />

      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">
            <span className="text-content-muted mr-1.5">{ordinal}</span>
            {name}
          </p>
          <p className="text-content-muted text-xs">{formatKES(priceCents)}</p>
        </div>
        <button
          type="submit"
          disabled={pending}
          className={`btn shrink-0 px-3 py-1 text-xs ${
            enabled
              ? "border border-danger/40 text-danger hover:bg-danger/10"
              : "bg-accent text-white hover:bg-accent-hover"
          }`}
        >
          {pending ? "…" : enabled ? "Disable" : "Enable"}
        </button>
      </div>

      <ul className="text-content-muted mt-3 space-y-1 text-xs">
        {features.map((f) => (
          <li key={f} className="flex items-start gap-1.5">
            <span
              className={`mt-1.5 h-1 w-1 shrink-0 rounded-full ${
                enabled ? "bg-accent" : "bg-current opacity-40"
              }`}
            />
            {f}
          </li>
        ))}
      </ul>

      {state.error ? <p className="mt-2 text-xs text-danger">{state.error}</p> : null}
    </form>
  );
}

export function StatusControl({
  companyId,
  status,
}: {
  companyId: string;
  status: string;
}) {
  const [state, action, pending] = useActionState<ActionState, FormData>(
    setStatusAction,
    {},
  );

  const next = status === "ACTIVE" ? "SUSPENDED" : "ACTIVE";

  return (
    <form action={action} className="flex items-center gap-3">
      <input type="hidden" name="companyId" value={companyId} />
      <input type="hidden" name="status" value={next} />
      <button
        type="submit"
        disabled={pending}
        className={`btn px-3 py-1.5 text-xs ${
          next === "ACTIVE"
            ? "bg-accent text-white hover:opacity-90"
            : "border border-danger/40 text-danger hover:bg-danger/10"
        }`}
      >
        {pending ? "Working…" : next === "ACTIVE" ? "Activate company" : "Suspend company"}
      </button>
      {state.success ? <span className="text-xs text-accent">{state.success}</span> : null}
      {state.error ? <span className="text-xs text-danger">{state.error}</span> : null}
    </form>
  );
}
