"use client";

import { useActionState, useEffect, useState } from "react";

import Link from "next/link";

import { RautLockup } from "@/components/raut-mark";

import { login, type LoginState } from "./actions";

/**
 * Sign-in hints for local development only. Publishing real account names and a
 * password on a live login page hands the system to anyone who opens it.
 */
const SHOW_DEMO_ACCOUNTS = process.env.NODE_ENV !== "production";

const DEMO_ACCOUNTS = [
  { label: "Super Admin", email: "admin@tariafrica.com", note: "Platform" },
  // These notes name the tenant, not the product — Tari Solutions is a
  // company on Raut, not Raut itself.
  { label: "Company Admin", email: "admin@tarisolutions.co.ke", note: "Tari Solutions — all modules" },
  { label: "Sales Manager", email: "sales@tarisolutions.co.ke", note: "Tari Solutions" },
  { label: "Accountant", email: "accounts@tarisolutions.co.ke", note: "Tari Solutions" },
  { label: "Field Rep", email: "rep@tarisolutions.co.ke", note: "James Mwangi — mobile" },
  { label: "Core-only Admin", email: "admin@acacia.example", note: "Acacia — module gate" },
];

export default function LoginPage() {
  const [state, action, pending] = useActionState<LoginState, FormData>(login, {});

  // Read on the client so the login route needs no Suspense boundary. Shows a
  // one-time confirmation after a successful password reset (/login?reset=1).
  const [justReset, setJustReset] = useState(false);
  useEffect(() => {
    setJustReset(new URLSearchParams(window.location.search).get("reset") === "1");
  }, []);

  return (
    <main className="grid min-h-screen lg:grid-cols-2">
      {/* ink-950 (#000828) is the logo's navy, and it must be a real step on
          the scale: `ink` is defined only as a ramp, so bare `bg-ink` compiles
          to nothing. The panel then took the page background while `text-white`
          still applied — white on white, an invisible headline for every
          visitor whose browser is in light mode. */}
      <section className="afr-weave-dark relative hidden flex-col justify-between bg-ink-950 p-12 text-white lg:flex">
        <div className="afr-band absolute inset-x-0 top-0" aria-hidden="true" />
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-brand-300">
            Tari Africa Platforms Limited
          </p>

          {/* The supplied lockup already carries the wordmark and strapline,
              so it stands alone rather than being repeated in text. */}
          <div className="mt-6">
            <RautLockup size={260} onDark />
          </div>


          <h1 className="font-display mt-6 max-w-md text-2xl font-semibold leading-tight">
            Multi-Tenant ERP &amp; Field Sales Management Platform
          </h1>
          <p className="mt-3 max-w-md text-sm text-white/70">
            One platform. Many companies, branches and users — managed through a
            centralized Super Admin environment.
          </p>
        </div>

        <ul className="grid grid-cols-2 gap-3 text-sm text-white/80">
          {[
            "Multi-Company Super Admin",
            "CRM & Customer Management",
            "Sales & POS",
            "Inventory & Procurement",
            "Field Sales & Visits",
            "Smart Routing",
            "Geofencing & Location Intel",
            "SMS & Analytics",
          ].map((item) => (
            <li key={item} className="flex items-start gap-2">
              <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
              {item}
            </li>
          ))}
        </ul>

        <p className="text-xs text-white/40">
          Prepared for Tari Solutions Limited · Core platform + 11 modules
          {" · "}
          <a href="/terms" className="underline hover:text-white/70">
            Terms
          </a>
          {" · "}
          <a href="/policy" className="underline hover:text-white/70">
            Privacy &amp; Cookies
          </a>
          {" · "}
          <a href="/contact-us" className="underline hover:text-white/70">
            Contact us
          </a>
        </p>
      </section>

      <section className="flex items-center justify-center p-6 sm:p-12">
        <div className="w-full max-w-sm">
          <h2 className="text-2xl font-semibold">Sign in</h2>
          <p className="text-content-muted mt-1 text-sm">Access your Raut workspace.</p>

          {justReset ? (
            <p
              role="status"
              className="mt-4 rounded-lg bg-success/10 px-3 py-2 text-sm text-success"
            >
              Your password has been reset. Sign in with your new password.
            </p>
          ) : null}

          <form action={action} className="mt-8 space-y-4">
            <div>
              <label className="mb-1 block text-sm font-medium" htmlFor="email">
                Email address
              </label>
              <input
                id="email"
                name="email"
                type="email"
                autoComplete="username"
                required
                className="h-10 w-full rounded border border-border bg-surface px-3 text-base"
                placeholder="you@company.co.ke"
              />
            </div>

            <div>
              <div className="mb-1 flex items-baseline justify-between">
                <label className="block text-sm font-medium" htmlFor="password">
                  Password
                </label>
                <Link
                  href="/forgot-password"
                  className="text-accent text-xs font-medium hover:underline"
                >
                  Forgot password?
                </Link>
              </div>
              <input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
                className="h-10 w-full rounded border border-border bg-surface px-3 text-base"
                placeholder="••••••••"
              />
            </div>

            {state.error ? (
              <p
                role="alert"
                className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger"
              >
                {state.error}
              </p>
            ) : null}

            <button type="submit" className="inline-flex items-center justify-center rounded bg-accent px-3 py-1.5 text-white hover:bg-accent-hover w-full" disabled={pending}>
              {pending ? "Signing in…" : "Sign in"}
            </button>
          </form>

          <p className="text-content-muted mt-6 text-center text-sm">
            New to Raut?{" "}
            <Link href="/signup" className="text-accent font-medium hover:underline">
              Create an account
            </Link>
          </p>

          {SHOW_DEMO_ACCOUNTS ? (
          <div className="rounded-lg border border-border bg-surface shadow-sm mt-8 p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-content-muted mb-3">Demo accounts · password Raut@2026</p>
            <ul className="space-y-2 text-xs">
              {DEMO_ACCOUNTS.map((a) => (
                <li key={a.email} className="flex items-baseline justify-between gap-3">
                  <span className="font-medium">{a.label}</span>
                  <code className="text-content-muted truncate text-[11px]">{a.email}</code>
                </li>
              ))}
            </ul>
          </div>
          ) : null}
        </div>
      </section>
    </main>
  );
}
