"use client";

import Link from "next/link";
import { useActionState } from "react";

import { RautLockup } from "@/components/raut-mark";

import { signup, type SignupState } from "./actions";

/**
 * Public self-service signup. Creates a tenant and an admin login in one step,
 * then drops the new admin straight into the console.
 */
export default function SignupPage() {
  const [state, action, pending] = useActionState<SignupState, FormData>(signup, {});

  return (
    <main className="grid min-h-screen lg:grid-cols-2">
      <section className="afr-weave-dark relative hidden flex-col justify-between bg-ink-950 p-12 text-white lg:flex">
        <div className="afr-band absolute inset-x-0 top-0" aria-hidden="true" />
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-brand-300">
            Tari Africa Platforms Limited
          </p>
          <div className="mt-6">
            <RautLockup size={260} onDark />
          </div>
          <h1 className="font-display mt-6 max-w-md text-2xl font-semibold leading-tight">
            Start running your trade operation on Raut
          </h1>
          <p className="mt-3 max-w-md text-sm text-white/70">
            Create your company workspace in a minute. CRM, sales, stock,
            finance, field sales and more — with an offline-first app for your
            reps.
          </p>
        </div>

        <ul className="grid grid-cols-2 gap-3 text-sm text-white/80">
          {[
            "Free trial, all modules",
            "No card required",
            "Your own private workspace",
            "Works where the network does not",
          ].map((item) => (
            <li key={item} className="flex items-start gap-2">
              <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
              {item}
            </li>
          ))}
        </ul>

        <p className="text-xs text-white/40">
          <Link href="/terms" className="underline hover:text-white/70">
            Terms of Service
          </Link>
          {" · "}
          <Link href="/policy" className="underline hover:text-white/70">
            Privacy &amp; Cookies
          </Link>
        </p>
      </section>

      <section className="flex items-center justify-center p-6 sm:p-12">
        <div className="w-full max-w-sm">
          <h2 className="text-2xl font-semibold">Create your account</h2>
          <p className="text-content-muted mt-1 text-sm">
            Already have one?{" "}
            <Link href="/login" className="text-accent font-medium hover:underline">
              Sign in
            </Link>
          </p>

          <form action={action} className="mt-8 space-y-4">
            <div>
              <label className="mb-1 block text-sm font-medium" htmlFor="companyName">
                Business name
              </label>
              <input
                id="companyName"
                name="companyName"
                required
                autoComplete="organization"
                className="h-10 w-full rounded border border-border bg-surface px-3 text-base"
                placeholder="Acme Distributors Ltd"
              />
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium" htmlFor="adminName">
                Your name
              </label>
              <input
                id="adminName"
                name="adminName"
                required
                autoComplete="name"
                className="h-10 w-full rounded border border-border bg-surface px-3 text-base"
                placeholder="Jane Wanjiru"
              />
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium" htmlFor="email">
                Work email
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

            <div>
              <label className="mb-1 block text-sm font-medium" htmlFor="phone">
                Phone <span className="text-content-muted font-normal">(optional)</span>
              </label>
              <input
                id="phone"
                name="phone"
                type="tel"
                autoComplete="tel"
                className="h-10 w-full rounded border border-border bg-surface px-3 text-base"
                placeholder="+254 7xx xxx xxx"
              />
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium" htmlFor="password">
                Password
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

            <label className="flex items-start gap-2 text-sm text-content-secondary">
              <input type="checkbox" name="terms" value="yes" className="mt-1" required />
              <span>
                I agree to the{" "}
                <Link href="/terms" className="text-accent hover:underline" target="_blank">
                  Terms of Service
                </Link>{" "}
                and{" "}
                <Link href="/policy" className="text-accent hover:underline" target="_blank">
                  Privacy Policy
                </Link>
                .
              </span>
            </label>

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
              {pending ? "Creating your workspace…" : "Create account"}
            </button>
          </form>
        </div>
      </section>
    </main>
  );
}
