"use client";

import { Button, ModalButton, apiClient, useFormSubmit } from "@/components/ui";

/** Closing and reopening both ask first: each changes what the whole team can post. */
export function PeriodAction({ month, action }: { month: string; action: "close" | "reopen" }) {
  const closing = action === "close";
  return (
    <ModalButton
      label={closing ? "Close" : "Reopen"}
      title={`${closing ? "Close" : "Reopen"} ${month}`}
      description={
        closing
          ? "Nothing can be posted into this month afterwards, including backdated invoices and phones syncing late."
          : "Postings into this month will be accepted again, which can change figures already reported."
      }
      variant="ghost"
      width="max-w-md"
    >
      {(close) => <Confirm month={month} action={action} onClose={close} />}
    </ModalButton>
  );
}

function Confirm({ month, action, onClose }: { month: string; action: "close" | "reopen"; onClose: () => void }) {
  const { busy, error, submit } = useFormSubmit();
  return (
    <div className="space-y-4">
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button
          type="button"
          variant={action === "close" ? "primary" : "danger"}
          disabled={busy}
          onClick={() => {
            void submit(() => apiClient("/api/v1/finance/periods", { method: "POST", body: { month, action } }), {
              onSuccess: onClose,
            });
          }}
        >
          {busy ? "Saving…" : action === "close" ? `Close ${month}` : `Reopen ${month}`}
        </Button>
      </div>
    </div>
  );
}
