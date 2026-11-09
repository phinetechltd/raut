"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { apiClient, useFormSubmit, Button, Modal } from "@/components/ui";

/** Advance a quotation's status (e.g. mark SENT, ACCEPTED, REJECTED). */
export function QuotationStatusButton({
  id,
  to,
  label,
  variant = "secondary",
}: {
  id: string;
  to: "SENT" | "ACCEPTED" | "REJECTED" | "EXPIRED";
  label: string;
  variant?: "primary" | "secondary" | "ghost" | "danger";
}) {
  const router = useRouter();
  const { busy, submit } = useFormSubmit();
  return (
    <Button
      variant={variant}
      size="sm"
      disabled={busy}
      onClick={async () => {
        const ok = await submit(() => apiClient(`/api/v1/quotations/${id}/status`, { method: "POST", body: { status: to } }), {});
        if (ok) router.refresh();
      }}
    >
      {label}
    </Button>
  );
}

/** Convert a quotation to an order or an invoice, with a confirm step. */
export function ConvertQuotationButton({ id, number }: { id: string; number: string }) {
  const router = useRouter();
  const { busy, error, submit } = useFormSubmit();
  const [open, setOpen] = useState(false);

  async function convert(toInvoice: boolean) {
    const ok = await submit(
      () => apiClient(`/api/v1/quotations/${id}/convert`, { method: "POST", body: { toInvoice } }),
      {},
    );
    if (ok) {
      setOpen(false);
      router.refresh();
    }
  }

  return (
    <>
      <Button variant="primary" size="sm" onClick={() => setOpen(true)}>Convert</Button>
      <Modal open={open} onClose={() => setOpen(false)} title={`Convert ${number}`} width="max-w-md">
        <div className="space-y-3">
          <p className="text-sm text-content-secondary">
            Carry this quotation's lines and prices across. An order can be invoiced later; an invoice is issued now.
          </p>
          {error ? <p className="text-sm text-danger">{error}</p> : null}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>Cancel</Button>
            <Button variant="secondary" disabled={busy} onClick={() => void convert(false)}>To order</Button>
            <Button variant="primary" disabled={busy} onClick={() => void convert(true)}>To invoice</Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
