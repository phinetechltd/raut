"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui";

/**
 * Asks the server to re-verify one intent with its provider.
 *
 * Calls the same GET the handset polls, with `recheck=1` so a Paystack charge
 * that was reversed after settlement is noticed too. The page is refreshed
 * afterwards so the row shows what the provider said, not what the button
 * hoped.
 */
export function RecheckButton({ intentId, terminal }: { intentId: string; terminal: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [note, setNote] = useState<string | null>(null);

  return (
    <span className="inline-flex items-center gap-2">
      <Button
        size="sm"
        variant="secondary"
        disabled={pending}
        title={terminal ? "Ask the provider again (detects a reversal)" : "Ask the provider now"}
        onClick={() =>
          start(async () => {
            setNote(null);
            try {
              const res = await fetch(`/api/v1/payments/intents/${encodeURIComponent(intentId)}?recheck=1`, {
                cache: "no-store",
              });
              const json = (await res.json().catch(() => null)) as
                | { ok?: boolean; data?: { status?: string; failureReason?: string | null }; error?: { message?: string } }
                | null;
              if (!res.ok || !json?.ok) {
                setNote(json?.error?.message ?? `HTTP ${res.status}`);
                return;
              }
              setNote(json.data?.status ? json.data.status.toLowerCase() : "checked");
              router.refresh();
            } catch (error) {
              setNote((error as Error).message);
            }
          })
        }
      >
        {pending ? "Checking…" : "Re-check"}
      </Button>
      {note ? <span className="text-content-muted text-xs">{note}</span> : null}
    </span>
  );
}
