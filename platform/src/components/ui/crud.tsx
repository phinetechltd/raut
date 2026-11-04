"use client";

import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";

/**
 * Fetch client for console CRUD forms.
 *
 * The console's own /api/v1 routes authenticate with the session cookie, so a
 * bare fetch works from the browser — the server still applies the role and
 * module-licence gates, and every write lands in the audit log. This helper
 * unwraps the standard envelope into one { ok, data, error } shape so forms
 * stay free of fetch plumbing. All errors land in `error.message`, which is
 * what the form surfaces verbatim to the user.
 */
export async function apiClient<T = unknown>(
  path: string,
  init: { method?: string; body?: Record<string, unknown> } = {},
): Promise<{ ok: boolean; data: T | null; status: number; error: string | null }> {
  try {
    const res = await fetch(path, {
      method: init.method ?? "GET",
      headers: { "Content-Type": "application/json" },
      ...(init.body ? { body: JSON.stringify(init.body) } : {}),
    });
    const json = (await res.json().catch(() => null)) as
      | { ok: true; data: T; meta?: Record<string, unknown> }
      | { ok: false; error: { code: string; message: string } }
      | null;

    if (!json || typeof json !== "object" || !("ok" in json)) {
      return { ok: false, data: null, status: res.status, error: `Unexpected response (${res.status})` };
    }
    if (json.ok) return { ok: true, data: json.data, status: res.status, error: null };
    return { ok: false, data: null, status: res.status, error: json.error.message };
  } catch {
    return { ok: false, data: null, status: 0, error: "Could not reach the server" };
  }
}

export interface SubmitState {
  busy: boolean;
  error: string | null;
  /** Wraps a mutation: busy state, error capture, then refresh server pages. */
  submit: (run: () => Promise<{ ok: boolean; error?: string | null }>, opts?: { onSuccess?: () => void }) => Promise<boolean>;
}

/** Shared busy/error/refresh behaviour for the forms the modals carry. */
export function useFormSubmit(): SubmitState {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(
    async (
      run: () => Promise<{ ok: boolean; error?: string | null }>,
      opts?: { onSuccess?: () => void },
    ): Promise<boolean> => {
      setBusy(true);
      setError(null);
      try {
        const result = await run();
        if (!result.ok) {
          setError(result.error ?? "Could not save — check the details and try again");
          return false;
        }
        opts?.onSuccess?.();
        router.refresh();
        return true;
      } finally {
        setBusy(false);
      }
    },
    [router],
  );

  return { busy, error, submit };
}
