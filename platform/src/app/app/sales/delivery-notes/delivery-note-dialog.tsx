"use client";

import { useMemo, useState } from "react";

import {
  Button,
  Field,
  Input,
  Modal,
  ModalButton,
  Select,
  Textarea,
  apiClient,
  useFormSubmit,
} from "@/components/ui";

export interface SourceLine {
  id: string;
  description: string;
  ordered: number;
  remaining: number;
}

export interface SourceOption {
  id: string;
  kind: "invoice" | "order";
  number: string;
  customerName: string;
  lines: SourceLine[];
}

interface Option {
  id: string;
  name: string;
}

/**
 * Raise a delivery note from an invoice or an order.
 *
 * Quantities default to what each line still has undelivered, because the
 * common case is one trip for the whole sale; the person edits only the lines
 * that are short. The server refuses anything over the remainder, so the form
 * can stay light.
 */
export function NewDeliveryNoteDialog({
  sources,
  vehicles,
  reps,
  presetSourceId,
}: {
  sources: SourceOption[];
  vehicles: Option[];
  reps: Option[];
  presetSourceId?: string;
}) {
  return (
    <ModalButton
      label="+ New delivery note"
      title="New delivery note"
      description="Records what leaves and who signs for it. Stock already moved with the invoice; this does not move it again."
      width="max-w-2xl"
    >
      {(close) => (
        <DeliveryNoteForm
          sources={sources}
          vehicles={vehicles}
          reps={reps}
          presetSourceId={presetSourceId}
          onClose={close}
        />
      )}
    </ModalButton>
  );
}

function DeliveryNoteForm({
  sources,
  vehicles,
  reps,
  presetSourceId,
  onClose,
}: {
  sources: SourceOption[];
  vehicles: Option[];
  reps: Option[];
  presetSourceId?: string;
  onClose: () => void;
}) {
  const { busy, error, submit } = useFormSubmit();
  const [sourceId, setSourceId] = useState(presetSourceId ?? sources[0]?.id ?? "");
  const source = useMemo(() => sources.find((s) => s.id === sourceId), [sources, sourceId]);
  const [qty, setQty] = useState<Record<string, string>>({});
  const [deliveredById, setDeliveredById] = useState("");
  const [vehicleId, setVehicleId] = useState("");
  const [address, setAddress] = useState("");
  const [notes, setNotes] = useState("");
  const [issue, setIssue] = useState(true);
  const [openPrint, setOpenPrint] = useState(true);

  const quantityFor = (l: SourceLine) => {
    const raw = qty[l.id];
    if (raw === undefined || raw === "") return l.remaining;
    return Math.max(0, Math.min(l.remaining, Number(raw) || 0));
  };

  const anyQty = (source?.lines ?? []).some((l) => quantityFor(l) > 0);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!source) return;
    await submit(
      async () => {
        const res = await apiClient<{ deliveryNote: { id: string } }>("/api/v1/delivery-notes", {
          method: "POST",
          body: {
            ...(source.kind === "invoice" ? { invoiceId: source.id } : { orderId: source.id }),
            lines: source.lines.map((l) => ({
              ...(source.kind === "invoice" ? { invoiceLineId: l.id } : { orderLineId: l.id }),
              deliveredQty: quantityFor(l),
            })),
            ...(deliveredById ? { deliveredById } : {}),
            ...(vehicleId ? { vehicleId } : {}),
            ...(address.trim() ? { deliveryAddress: address.trim() } : {}),
            ...(notes.trim() ? { notes: notes.trim() } : {}),
            issue,
          },
        });
        if (res.ok && res.data && openPrint) {
          window.open(`/print/delivery-note/${res.data.deliveryNote.id}?autoprint=1`, "_blank", "noopener");
        }
        return res;
      },
      { onSuccess: onClose },
    );
  }

  if (sources.length === 0) {
    return (
      <p className="text-sm text-content-muted">
        Nothing is waiting to be delivered: every issued invoice and confirmed order has gone out in full.
      </p>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <Field label="Deliver against" required>
        <Select value={sourceId} onChange={(e) => { setSourceId(e.target.value); setQty({}); }}>
          <optgroup label="Invoices">
            {sources.filter((s) => s.kind === "invoice").map((s) => (
              <option key={s.id} value={s.id}>
                {s.number} — {s.customerName}
              </option>
            ))}
          </optgroup>
          <optgroup label="Orders not yet invoiced">
            {sources.filter((s) => s.kind === "order").map((s) => (
              <option key={s.id} value={s.id}>
                {s.number} — {s.customerName}
              </option>
            ))}
          </optgroup>
        </Select>
      </Field>

      {source && (
        <div className="rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-surface-sunken/60 text-left text-xs uppercase tracking-wide text-content-muted">
                <th className="px-3 py-2">Item</th>
                <th className="px-3 py-2 text-right">Ordered</th>
                <th className="px-3 py-2 text-right">Outstanding</th>
                <th className="px-3 py-2 text-right">Deliver now</th>
              </tr>
            </thead>
            <tbody>
              {source.lines.map((l) => (
                <tr key={l.id} className="border-b border-border last:border-0">
                  <td className="px-3 py-1.5">{l.description}</td>
                  <td className="tabular px-3 py-1.5 text-right">{l.ordered}</td>
                  <td className="tabular px-3 py-1.5 text-right">{l.remaining}</td>
                  <td className="px-3 py-1.5 text-right">
                    <Input
                      type="number"
                      min={0}
                      max={l.remaining}
                      className="h-8 w-20 text-right"
                      value={qty[l.id] ?? String(l.remaining)}
                      disabled={l.remaining === 0}
                      onChange={(e) => setQty((q) => ({ ...q, [l.id]: e.target.value }))}
                      aria-label={`Quantity of ${l.description} to deliver`}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Delivered by" hint="The rep or driver taking the goods">
          <Select value={deliveredById} onChange={(e) => setDeliveredById(e.target.value)}>
            <option value="">Not assigned yet</option>
            {reps.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Vehicle">
          <Select value={vehicleId} onChange={(e) => setVehicleId(e.target.value)}>
            <option value="">None</option>
            {vehicles.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <Field label="Delivery address" hint="Leave blank to use the customer's address on file">
        <Input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Shop 4, Kenyatta Avenue, Nakuru" />
      </Field>

      <Field label="Notes">
        <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Deliver before 10am; call on arrival" />
      </Field>

      <div className="flex flex-wrap gap-4 text-sm">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={issue} onChange={(e) => setIssue(e.target.checked)} />
          Issue now (otherwise saved as a draft)
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={openPrint} onChange={(e) => setOpenPrint(e.target.checked)} />
          Open for printing
        </label>
      </div>

      {error && <p className="text-sm text-danger">{error}</p>}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={busy || !source || !anyQty}>
          {busy ? "Raising..." : "Raise delivery note"}
        </Button>
      </div>
    </form>
  );
}

// ── lifecycle actions ──────────────────────────────────────────────────

export interface NoteForActions {
  id: string;
  number: string;
  status: string;
  lines: Array<{ id: string; description: string; deliveredQty: number; returnedQty: number }>;
}

/**
 * The buttons on a row: issue, mark delivered, record a return, cancel. Each
 * is one PATCH with an `action`; the server decides what the current status
 * allows and says so when it does not.
 */
export function DeliveryNoteActions({ note, canWrite }: { note: NoteForActions; canWrite: boolean }) {
  const { busy, error, submit } = useFormSubmit();
  const [deliverOpen, setDeliverOpen] = useState(false);
  const [returnOpen, setReturnOpen] = useState(false);

  const patch = (body: Record<string, unknown>, onSuccess?: () => void) =>
    submit(() => apiClient(`/api/v1/delivery-notes/${note.id}`, { method: "PATCH", body }), { onSuccess });

  return (
    <div className="flex flex-wrap items-center justify-end gap-1.5">
      <a
        href={`/print/delivery-note/${note.id}`}
        target="_blank"
        rel="noopener"
        className="text-xs text-content-muted hover:text-accent"
      >
        Print
      </a>
      {canWrite && note.status === "DRAFT" && (
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => patch({ action: "issue" })}>
          Issue
        </Button>
      )}
      {canWrite && (note.status === "DRAFT" || note.status === "ISSUED") && (
        <Button size="sm" variant="primary" disabled={busy} onClick={() => setDeliverOpen(true)}>
          Mark delivered
        </Button>
      )}
      {canWrite && note.status === "DELIVERED" && (
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => setReturnOpen(true)}>
          Record return
        </Button>
      )}
      {canWrite && (note.status === "DRAFT" || note.status === "ISSUED") && (
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => {
            if (window.confirm(`Cancel delivery note ${note.number}? The goods stay undelivered.`)) {
              void patch({ action: "cancel" });
            }
          }}
        >
          Cancel
        </Button>
      )}
      {error && !deliverOpen && !returnOpen && <span className="w-full text-right text-xs text-danger">{error}</span>}

      <Modal
        open={deliverOpen}
        onClose={() => setDeliverOpen(false)}
        title={`Mark ${note.number} delivered`}
        description="Who took the goods. A delivery without a name is a dispatch, not a delivery."
      >
        <DeliverForm
          busy={busy}
          error={error}
          onCancel={() => setDeliverOpen(false)}
          onSubmit={(v) => patch({ action: "deliver", ...v }, () => setDeliverOpen(false))}
        />
      </Modal>

      <Modal
        open={returnOpen}
        onClose={() => setReturnOpen(false)}
        title={`Goods returned on ${note.number}`}
        description="What came straight back with the driver. Money comes back through a credit note, not here."
      >
        <ReturnForm
          lines={note.lines}
          busy={busy}
          error={error}
          onCancel={() => setReturnOpen(false)}
          onSubmit={(lines) => patch({ action: "return", lines }, () => setReturnOpen(false))}
        />
      </Modal>
    </div>
  );
}

function DeliverForm({
  busy,
  error,
  onCancel,
  onSubmit,
}: {
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: (v: { receivedByName: string; receivedByPhone?: string; receivedBySignature?: string }) => void;
}) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [signature, setSignature] = useState("");
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({
          receivedByName: name.trim(),
          ...(phone.trim() ? { receivedByPhone: phone.trim() } : {}),
          ...(signature.trim() ? { receivedBySignature: signature.trim() } : {}),
        });
      }}
    >
      <Field label="Received by" required>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name of the person who signed" required />
      </Field>
      <Field label="Phone">
        <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="07…" />
      </Field>
      <Field label="Signature" hint="Typed name as signed on the paper copy">
        <Input value={signature} onChange={(e) => setSignature(e.target.value)} />
      </Field>
      {error && <p className="text-sm text-danger">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
          Back
        </Button>
        <Button type="submit" variant="primary" disabled={busy || name.trim().length === 0}>
          {busy ? "Saving..." : "Mark delivered"}
        </Button>
      </div>
    </form>
  );
}

function ReturnForm({
  lines,
  busy,
  error,
  onCancel,
  onSubmit,
}: {
  lines: NoteForActions["lines"];
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: (lines: Array<{ lineId: string; returnedQty: number }>) => void;
}) {
  const [qty, setQty] = useState<Record<string, number>>({});
  const chosen = lines.map((l) => ({ lineId: l.id, returnedQty: qty[l.id] ?? l.returnedQty }));
  const any = chosen.some((c) => c.returnedQty > 0);
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(chosen);
      }}
    >
      {lines.map((l) => (
        <div key={l.id} className="flex items-center justify-between gap-3 text-sm">
          <span className="min-w-0 flex-1 truncate">{l.description}</span>
          <span className="text-xs text-content-muted">of {l.deliveredQty}</span>
          <Input
            type="number"
            min={0}
            max={l.deliveredQty}
            className="h-8 w-20 text-right"
            value={qty[l.id] ?? l.returnedQty}
            onChange={(e) =>
              setQty((q) => ({ ...q, [l.id]: Math.max(0, Math.min(l.deliveredQty, Number(e.target.value) || 0)) }))
            }
            aria-label={`Quantity of ${l.description} returned`}
          />
        </div>
      ))}
      {error && <p className="text-sm text-danger">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
          Back
        </Button>
        <Button type="submit" variant="primary" disabled={busy || !any}>
          {busy ? "Saving..." : "Record return"}
        </Button>
      </div>
    </form>
  );
}
