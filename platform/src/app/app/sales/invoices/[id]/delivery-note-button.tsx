"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button, apiClient } from "@/components/ui";

/**
 * Raises a delivery note for everything on this invoice that has not gone out
 * yet, then opens it for printing. One click, because the common case is one
 * trip: the driver needs the paper now, not a form.
 *
 * A second click after the first note is delivered gets a 409 ("nothing left
 * to deliver"), which is shown rather than swallowed.
 */
export function DeliveryNoteButton({ invoiceId }: { invoiceId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function raise() {
    setBusy(true);
    setError(null);
    const res = await apiClient<{ deliveryNote: { id: string } }>("/api/v1/delivery-notes", {
      method: "POST",
      body: { invoiceId },
    });
    setBusy(false);
    if (!res.ok || !res.data) {
      setError(res.error ?? "Could not raise the delivery note");
      return;
    }
    window.open(`/print/delivery-note/${res.data.deliveryNote.id}?autoprint=1`, "_blank", "noopener");
    start(() => router.refresh());
  }

  return (
    <span className="inline-flex flex-col items-end gap-1">
      <Button variant="secondary" size="sm" onClick={raise} disabled={busy || pending}>
        {busy ? "Raising..." : "Delivery note"}
      </Button>
      {error && <span className="max-w-xs text-right text-xs text-danger">{error}</span>}
    </span>
  );
}
