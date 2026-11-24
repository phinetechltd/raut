import Link from "next/link";

import { RautWordmark } from "@/components/raut-mark";
import { resetTokenIsValid } from "@/server/password-reset";

import { ResetForm } from "./reset-form";

export const dynamic = "force-dynamic";

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  const valid = token ? await resetTokenIsValid(token) : false;

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
        <h1 className="text-2xl font-semibold">Choose a new password</h1>

        {valid ? (
          <>
            <p className="text-content-muted mt-1 text-sm">
              Enter a new password for your account.
            </p>
            <ResetForm token={token as string} />
          </>
        ) : (
          <div className="mt-6 rounded-lg border border-border bg-surface p-4 text-sm text-content-secondary">
            <p>This reset link is invalid or has expired.</p>
            <p className="mt-3">
              <Link href="/forgot-password" className="text-accent hover:underline">
                Request a new reset link
              </Link>
              .
            </p>
          </div>
        )}
      </div>
    </main>
  );
}
