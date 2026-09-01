"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button, Card, Field, Input, Textarea } from "@/components/ui";

interface Line {
  id: string;
  description: string;
  quantity: number;
}

/**
 * Raises a credit note against this invoice.
 *
 * Quantities default to zero rather than the full line. A return is usually
 * partial, and pre-filling the whole quantity makes over-crediting the path of
 * least resistance — the server refuses it, but the person should be choosing
 * what came back, not un-choosing what did not.
 */
export function CreditNoteButton({ invoiceId, lines }: { invoiceId: string; lines: Line[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [restock, setRestock] = useState(true);
  const [qty, setQty] = useState<Record<string, number>>({});

  const chosen = lines
    .map((l) => ({ invoiceLineId: l.id, quantity: qty[l.id] ?? 0 }))
    .filter((l) => l.quantity > 0);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/v1/credit-notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ invoiceId, reason, restock, lines: chosen }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json?.error?.message ?? "Could not raise the credit note");
      } else {
        setOpen(false);
        setQty({});
        setReason("");
        start(() => router.refresh());
      }
    } catch {
      setError("Could not reach the server");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
        Credit note
      </Button>
    );
  }

  return (
    <Card className="w-full max-w-lg">
      <p className="font-medium">Credit note</p>
      <p className="mt-0.5 text-sm text-content-muted">
        Reverses part or all of this invoice. It cannot be undone; a mistake is
        corrected with another document, not by deleting this one.
      </p>

      <div className="mt-3 space-y-2">
        {lines.map((l) => (
          <div key={l.id} className="flex items-center justify-between gap-3">
            <span className="min-w-0 flex-1 truncate text-sm">{l.description}</span>
            <span className="text-xs text-content-muted">of {l.quantity}</span>
            <Input
              type="number"
              min={0}
              max={l.quantity}
              value={qty[l.id] ?? 0}
              className="w-20"
              onChange={(e) =>
                setQty((q) => ({ ...q, [l.id]: Math.max(0, Number(e.target.value) || 0) }))
              }
            />
          </div>
        ))}
      </div>

      <div className="mt-3">
        <Field label="Reason">
          <Textarea
            rows={2}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Damaged in transit, wrong item delivered, ..."
          />
        </Field>
      </div>

      <label className="mt-2 flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={restock}
          onChange={(e) => setRestock(e.target.checked)}
        />
        {/* Damaged goods are credited but not put back on the shelf, and
            assuming otherwise silently inflates stock. */}
        Put the goods back into stock
      </label>

      {error && <p className="mt-2 text-sm text-danger">{error}</p>}

      <div className="mt-4 flex gap-2">
        <Button
          onClick={submit}
          disabled={busy || pending || chosen.length === 0 || reason.trim().length === 0}
        >
          {busy ? "Raising..." : "Raise credit note"}
        </Button>
        <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
          Cancel
        </Button>
      </div>
    </Card>
  );
}
