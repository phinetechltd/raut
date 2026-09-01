"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui";

/**
 * Sends one invoice to KRA by hand.
 *
 * Exists because auto-transmit is not the only mode a company runs in, and
 * because a queued invoice that failed for a transient reason should be
 * retryable by the person looking at it rather than only by the timer.
 */
export function TransmitButton({ invoiceId }: { invoiceId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/v1/etims/transmit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ docType: "SALE", docId: invoiceId }),
      });
      const json = await res.json();

      // The endpoint answers 200 with ok:false when eTIMS is off or the
      // document is not ready. Reporting that as success would be a lie the
      // user only discovers at filing time.
      if (!res.ok || json?.data?.ok === false) {
        setError(json?.data?.reason ?? json?.error?.message ?? "Could not transmit");
      } else {
        start(() => router.refresh());
      }
    } catch {
      setError("Could not reach the server");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button variant="secondary" size="sm" onClick={submit} disabled={busy || pending}>
        {busy ? "Sending to KRA..." : "Send to KRA"}
      </Button>
      {error && <p className="max-w-xs text-right text-xs text-danger">{error}</p>}
    </div>
  );
}
