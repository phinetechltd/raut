"use client";

import { useState } from "react";

import { ProductPicker, onHandAt, type PickedProduct } from "@/components/product-picker";
import {
  apiClient,
  useFormSubmit,
  Button,
  Field,
  Input,
  ModalButton,
  PlusIcon,
  Select,
  Textarea,
  TrashIcon,
} from "@/components/ui";

interface Option {
  id: string;
  name: string;
}

export interface TransferLineShape {
  id: string;
  productId: string;
  quantity: number;
  dispatched: number;
  received: number;
  product: { name: string; sku: string };
}

export interface TransferShape {
  id: string;
  number: string;
  status: string;
  shortClosedAt: string | Date | null;
  fromLocation: { id: string; name: string };
  toLocation: { id: string; name: string };
  lines: TransferLineShape[];
}

// ── create ──────────────────────────────────────────────────────────────

export function TransferCreateDialog({ locations }: { locations: Option[] }) {
  return (
    <ModalButton
      label="+ New transfer"
      title="New stock transfer"
      description="Goods move between two of your locations. Nothing leaves the source until the transfer is dispatched."
      width="max-w-2xl"
    >
      {(close) => <CreateForm locations={locations} onClose={() => close()} />}
    </ModalButton>
  );
}

interface DraftLine {
  product: PickedProduct | null;
  quantity: string;
}

function CreateForm({ locations, onClose }: { locations: Option[]; onClose: () => void }) {
  const { busy, error, submit } = useFormSubmit();
  const [fromId, setFromId] = useState(locations[0]?.id ?? "");
  const [toId, setToId] = useState(locations[1]?.id ?? locations[0]?.id ?? "");
  const [note, setNote] = useState("");
  const [dispatch, setDispatch] = useState(false);
  const [lines, setLines] = useState<DraftLine[]>([{ product: null, quantity: "1" }]);

  const chosen = lines.flatMap((l) => (l.product ? [l.product.id] : []));
  const valid =
    fromId &&
    toId &&
    fromId !== toId &&
    lines.length > 0 &&
    lines.every((l) => l.product && Math.floor(Number(l.quantity)) > 0);

  async function save() {
    await submit(async () => {
      return await apiClient("/api/v1/transfers", {
        method: "POST",
        body: {
          fromLocationId: fromId,
          toLocationId: toId,
          note: note.trim() || undefined,
          dispatch,
          lines: lines.map((l) => ({ productId: l.product!.id, quantity: Math.floor(Number(l.quantity)) })),
        },
      });
    }, { onSuccess: onClose });
  }

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="From" htmlFor="trf-from" required>
          <Select id="trf-from" value={fromId} onChange={(e) => setFromId(e.target.value)}>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>{l.name}</option>
            ))}
          </Select>
        </Field>
        <Field label="To" htmlFor="trf-to" required error={fromId && fromId === toId ? "Choose a different destination" : undefined}>
          <Select id="trf-to" value={toId} onChange={(e) => setToId(e.target.value)}>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>{l.name}</option>
            ))}
          </Select>
        </Field>
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <p className="text-sm font-medium">Lines</p>
          <Button type="button" variant="secondary" size="sm" onClick={() => setLines((ls) => [...ls, { product: null, quantity: "1" }])}>
            <PlusIcon size={14} /> Add line
          </Button>
        </div>
        <div className="space-y-2">
          {lines.map((line, i) => {
            const onHand = onHandAt(line.product, fromId);
            return (
              <div key={i} className="grid grid-cols-[1fr_110px_32px] items-start gap-2">
                <Field label={i === 0 ? "Product" : undefined} htmlFor={`trf-line-${i}`} hint={line.product ? `${onHand} on hand at source` : undefined}>
                  <ProductPicker
                    id={`trf-line-${i}`}
                    value={line.product}
                    exclude={chosen.filter((id) => id !== line.product?.id)}
                    onChange={(p) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, product: p } : x)))}
                  />
                </Field>
                <Field label={i === 0 ? "Qty" : undefined} htmlFor={`trf-qty-${i}`}>
                  <Input
                    id={`trf-qty-${i}`}
                    type="number"
                    min={1}
                    step="1"
                    value={line.quantity}
                    onChange={(e) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)))}
                  />
                </Field>
                <button
                  type="button"
                  aria-label="Remove line"
                  disabled={lines.length <= 1}
                  onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}
                  className={`grid h-8 w-8 place-items-center rounded-md text-content-muted transition-colors hover:bg-danger-bg hover:text-danger disabled:opacity-30 ${i === 0 ? "mt-7" : "mt-1"}`}
                >
                  <TrashIcon size={14} />
                </button>
              </div>
            );
          })}
        </div>
      </div>

      <Field label="Note" htmlFor="trf-note">
        <Textarea id="trf-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Restock for the Mombasa run, …" />
      </Field>

      <label className="flex items-center gap-2 text-sm font-medium">
        <input type="checkbox" checked={dispatch} onChange={(e) => setDispatch(e.target.checked)} />
        Dispatch everything now (otherwise save as draft)
      </label>

      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <div className="flex items-center justify-end gap-2 border-t border-border pt-3">
        <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={busy || !valid}>
          {busy ? "Saving…" : dispatch ? "Create and dispatch" : "Save draft"}
        </Button>
      </div>
    </form>
  );
}

// ── dispatch / receive with per-line quantities ─────────────────────────

export function TransferStepDialog({
  transfer,
  action,
}: {
  transfer: TransferShape;
  action: "dispatch" | "receive";
}) {
  const remainingOf = (l: TransferLineShape) =>
    action === "dispatch" ? l.quantity - l.dispatched : l.dispatched - l.received;
  const anything = transfer.lines.some((l) => remainingOf(l) > 0);
  if (!anything) return null;
  return (
    <ModalButton
      label={action === "dispatch" ? "Dispatch" : "Receive"}
      title={`${action === "dispatch" ? "Dispatch" : "Receive"} ${transfer.number}`}
      description={
        action === "dispatch"
          ? `Stock leaves ${transfer.fromLocation.name}. Send part of a line now and the rest later.`
          : `Stock arrives at ${transfer.toLocation.name}. Receive what actually came off the truck.`
      }
      variant={action === "dispatch" ? "primary" : "secondary"}
      width="max-w-xl"
    >
      {(close) => <StepForm transfer={transfer} action={action} remainingOf={remainingOf} onClose={() => close()} />}
    </ModalButton>
  );
}

function StepForm({
  transfer,
  action,
  remainingOf,
  onClose,
}: {
  transfer: TransferShape;
  action: "dispatch" | "receive";
  remainingOf: (l: TransferLineShape) => number;
  onClose: () => void;
}) {
  const { busy, error, submit } = useFormSubmit();
  const open = transfer.lines.filter((l) => remainingOf(l) > 0);
  const [qty, setQty] = useState<Record<string, string>>(
    Object.fromEntries(open.map((l) => [l.id, String(remainingOf(l))])),
  );

  const parsed = open.map((l) => ({ line: l, quantity: Math.floor(Number(qty[l.id]) || 0), remaining: remainingOf(l) }));
  const chosen = parsed.filter((p) => p.quantity > 0);
  const over = parsed.filter((p) => p.quantity > p.remaining);
  const everything = parsed.every((p) => p.quantity === p.remaining);
  const valid = chosen.length > 0 && over.length === 0;

  async function save() {
    await submit(async () => {
      return await apiClient(`/api/v1/transfers/${transfer.id}/${action}`, {
        method: "POST",
        body: everything ? {} : { lines: chosen.map((p) => ({ lineId: p.line.id, quantity: p.quantity })) },
      });
    }, { onSuccess: onClose });
  }

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="overflow-hidden rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-surface-sunken/60 text-xs uppercase tracking-wide text-content-muted">
            <tr>
              <th className="px-3 py-2 text-left font-semibold">Product</th>
              <th className="px-3 py-2 text-right font-semibold">Ordered</th>
              <th className="px-3 py-2 text-right font-semibold">{action === "dispatch" ? "Sent" : "Received"}</th>
              <th className="px-3 py-2 text-right font-semibold">Now</th>
            </tr>
          </thead>
          <tbody>
            {parsed.map(({ line, remaining, quantity }) => (
              <tr key={line.id} className="border-t border-border">
                <td className="px-3 py-2">
                  <div className="font-medium">{line.product.name}</div>
                  <div className="text-xs text-content-muted tabular">{line.product.sku}</div>
                </td>
                <td className="px-3 py-2 text-right tabular">{line.quantity}</td>
                <td className="px-3 py-2 text-right tabular text-content-muted">
                  {action === "dispatch" ? line.dispatched : line.received}
                </td>
                <td className="px-3 py-2 text-right">
                  <Input
                    aria-label={`Quantity for ${line.product.name}`}
                    type="number"
                    min={0}
                    max={remaining}
                    step="1"
                    className={`h-9 w-24 text-right ${quantity > remaining ? "border-danger" : ""}`}
                    value={qty[line.id] ?? ""}
                    onChange={(e) => setQty((q) => ({ ...q, [line.id]: e.target.value }))}
                  />
                  <div className="mt-0.5 text-xs text-content-muted">of {remaining} left</div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {over.length > 0 ? <p className="text-sm text-danger">A quantity exceeds what is left on its line.</p> : null}
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <div className="flex items-center justify-end gap-2 border-t border-border pt-3">
        <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={busy || !valid}>
          {busy ? "Saving…" : action === "dispatch" ? (everything ? "Dispatch all" : "Dispatch these") : everything ? "Receive all" : "Receive these"}
        </Button>
      </div>
    </form>
  );
}

// ── cancel / close short ────────────────────────────────────────────────

export function TransferCloseDialog({
  transfer,
  action,
}: {
  transfer: TransferShape;
  action: "cancel" | "close-short";
}) {
  const inTransit = transfer.lines.reduce((n, l) => n + (l.dispatched - l.received), 0);
  return (
    <ModalButton
      label={action === "cancel" ? "Cancel" : "Close short"}
      title={action === "cancel" ? `Cancel ${transfer.number}` : `Close ${transfer.number} short`}
      description={
        action === "cancel"
          ? "Nothing has left the source. The draft is kept for the record but can no longer be dispatched."
          : `${inTransit} unit${inTransit === 1 ? "" : "s"} were dispatched and never arrived. They are written off at ${transfer.fromLocation.name} and the transfer is closed.`
      }
      variant="ghost"
      width="max-w-md"
    >
      {(close) => <CloseForm transfer={transfer} action={action} onClose={() => close()} />}
    </ModalButton>
  );
}

function CloseForm({
  transfer,
  action,
  onClose,
}: {
  transfer: TransferShape;
  action: "cancel" | "close-short";
  onClose: () => void;
}) {
  const { busy, error, submit } = useFormSubmit();
  const [note, setNote] = useState("");

  async function save() {
    await submit(async () => {
      return await apiClient(`/api/v1/transfers/${transfer.id}/${action}`, {
        method: "POST",
        body: action === "close-short" && note.trim() ? { note: note.trim() } : {},
      });
    }, { onSuccess: onClose });
  }

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      {action === "close-short" ? (
        <Field label="Reason" htmlFor="trf-close-note" required>
          <Textarea id="trf-close-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Damaged in transit, short delivery confirmed with driver, …" required />
        </Field>
      ) : null}
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <div className="flex items-center justify-end gap-2 border-t border-border pt-3">
        <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>Keep it</Button>
        <Button type="submit" variant="danger" disabled={busy || (action === "close-short" && !note.trim())}>
          {busy ? "Saving…" : action === "cancel" ? "Cancel transfer" : "Write off and close"}
        </Button>
      </div>
    </form>
  );
}
