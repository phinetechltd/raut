"use client";

import { useActionState } from "react";

import { resetPassword, type ResetState } from "./actions";

export function ResetForm({ token }: { token: string }) {
  const [state, action, pending] = useActionState<ResetState, FormData>(resetPassword, {});

  return (
    <form action={action} className="mt-8 space-y-4">
      <input type="hidden" name="token" value={token} />

      <div>
        <label className="mb-1 block text-sm font-medium" htmlFor="password">
          New password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          required
          minLength={8}
          autoComplete="new-password"
          className="h-10 w-full rounded border border-border bg-surface px-3 text-base"
          placeholder="At least 8 characters"
        />
      </div>

      <div>
        <label className="mb-1 block text-sm font-medium" htmlFor="confirm">
          Confirm new password
        </label>
        <input
          id="confirm"
          name="confirm"
          type="password"
          required
          minLength={8}
          autoComplete="new-password"
          className="h-10 w-full rounded border border-border bg-surface px-3 text-base"
          placeholder="Re-enter your password"
        />
      </div>

      {state.error ? (
        <p role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">
          {state.error}
        </p>
      ) : null}

      <button
        type="submit"
        className="inline-flex w-full items-center justify-center rounded bg-accent px-3 py-1.5 text-white hover:bg-accent-hover"
        disabled={pending}
      >
        {pending ? "Saving…" : "Set new password"}
      </button>
    </form>
  );
}
