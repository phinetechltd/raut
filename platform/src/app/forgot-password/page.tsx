"use client";

import Link from "next/link";
import { useActionState } from "react";

import { RautWordmark } from "@/components/raut-mark";

import { requestReset, type ForgotState } from "./actions";

export default function ForgotPasswordPage() {
  const [state, action, pending] = useActionState<ForgotState, FormData>(requestReset, {});

  return (
    <main className="bg-bg min-h-screen">
      <header className="border-border bg-surface border-b">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-6 py-4">
          <Link href="/" aria-label="Raut home">
            <RautWordmark compact />
          </Link>
          <Link href="/login" className="text-accent text-sm font-medium hover:underline">
            Sign in
          </Link>
        </div>
      </header>

      <div className="mx-auto flex max-w-sm flex-col px-6 pt-16">
        <h1 className="text-2xl font-semibold">Reset your password</h1>

        {state.sent ? (
          <div className="mt-6 rounded-lg border border-border bg-surface p-4 text-sm text-content-secondary">
            <p>
              If an account exists for that email, we have sent a link to reset
              your password. It expires in 60 minutes.
            </p>
            <p className="mt-3">
              Didn&apos;t get it? Check your spam folder, or{" "}
              <Link href="/forgot-password" className="text-accent hover:underline">
                try again
              </Link>
              .
            </p>
          </div>
        ) : (
          <>
            <p className="text-content-muted mt-1 text-sm">
              Enter the email you sign in with and we&apos;ll send a reset link.
            </p>
            <form action={action} className="mt-8 space-y-4">
              <div>
                <label className="mb-1 block text-sm font-medium" htmlFor="email">
                  Email address
                </label>
                <input
                  id="email"
                  name="email"
                  type="email"
                  required
                  autoComplete="username"
                  className="h-10 w-full rounded border border-border bg-surface px-3 text-base"
                  placeholder="you@company.co.ke"
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
                {pending ? "Sending…" : "Send reset link"}
              </button>
            </form>
          </>
        )}

        <p className="text-content-muted mt-6 text-center text-sm">
          <Link href="/login" className="text-accent hover:underline">
            Back to sign in
          </Link>
        </p>
      </div>
    </main>
  );
}
