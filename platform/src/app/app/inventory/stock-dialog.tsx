"use client";

import { useState } from "react";

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

/**
 * Manual stock adjustment. The server writes a ledgered movement — a balance
 * is derived from movements, never edited — so every adjust carries a note.
 *
 * One product can be counted at several locations in one go. When the rows
 * net to zero the server records a relocation (a completed transfer) rather
 * than a write-off and a write-up, and the form says so before you submit.
 */
export function StockAdjustDialog({
  products,
  locations,
}: {
  products: Option[];
  locations: Option[];
}) {
  return (
    <ModalButton
      label="Adjust stock"
      title="Stock adjustment"
      description="Positive or negative counts, ledgered against location and product."
      width="max-w-lg"
    >
      {(close) => (
        <StockAdjustForm products={products} locations={locations} onClose={() => close()} />
      )}
    </ModalButton>
  );
}

interface Row {
  locationId: string;
  quantity: string;
  direction: "in" | "out";
}

function StockAdjustForm({
  products,
  locations,
  onClose,
}: {
  products: Option[];
  locations: Option[];
  onClose: () => void;
}) {
  const { busy, error, submit } = useFormSubmit();
  const [productId, setProductId] = useState(products[0]?.id ?? "");
  const [note, setNote] = useState("");
  const [rows, setRows] = useState<Row[]>([
    { locationId: locations[0]?.id ?? "", quantity: "1", direction: "in" },
  ]);

  const setRow = (i: number, patch: Partial<Row>) =>
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const signed = rows.map((r) => {
    const q = Math.abs(Math.floor(Number(r.quantity) || 0));
    return { locationId: r.locationId, quantity: r.direction === "out" ? -q : q };
  });
  const net = signed.reduce((n, l) => n + l.quantity, 0);
  const duplicateLocation = new Set(rows.map((r) => r.locationId)).size !== rows.length;
  const relocation = rows.length > 1 && net === 0 && signed.every((l) => l.quantity !== 0);
  const valid =
    productId &&
    !duplicateLocation &&
    signed.every((l) => l.locationId && l.quantity !== 0) &&
    note.trim().length > 0;

  async function save() {
    await submit(async () => {
      const body =
        signed.length === 1
          ? { productId, locationId: signed[0]!.locationId, quantity: signed[0]!.quantity, note: note.trim() }
          : { productId, lines: signed, note: note.trim() };
      return await apiClient("/api/v1/stock", { method: "POST", body });
    }, { onSuccess: onClose });
  }

  const unused = (current: string) => locations.filter((l) => l.id === current || !rows.some((r) => r.locationId === l.id));

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <Field label="Product" htmlFor="adj-product" required>
        <Select id="adj-product" value={productId} onChange={(e) => setProductId(e.target.value)}>
          {products.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </Select>
      </Field>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <p className="text-sm font-medium">Locations</p>
          {rows.length < locations.length ? (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() =>
                setRows((rs) => [
                  ...rs,
                  {
                    locationId: locations.find((l) => !rs.some((r) => r.locationId === l.id))?.id ?? "",
                    quantity: "1",
                    direction: rs.length === 1 && rs[0]!.direction === "in" ? "out" : "in",
                  },
                ])
              }
            >
              <PlusIcon size={14} /> Add location
            </Button>
          ) : null}
        </div>
        <div className="space-y-2">
          {rows.map((row, i) => (
            <div key={i} className="grid grid-cols-[1fr_120px_90px_32px] items-end gap-2">
              <Field label={i === 0 ? "Location" : undefined} htmlFor={`adj-location-${i}`}>
                <Select id={`adj-location-${i}`} value={row.locationId} onChange={(e) => setRow(i, { locationId: e.target.value })}>
                  {unused(row.locationId).map((l) => (
                    <option key={l.id} value={l.id}>{l.name}</option>
                  ))}
                </Select>
              </Field>
              <Field label={i === 0 ? "Direction" : undefined} htmlFor={`adj-direction-${i}`}>
                <Select id={`adj-direction-${i}`} value={row.direction} onChange={(e) => setRow(i, { direction: e.target.value as "in" | "out" })}>
                  <option value="in">In (+)</option>
                  <option value="out">Out (−)</option>
                </Select>
              </Field>
              <Field label={i === 0 ? "Quantity" : undefined} htmlFor={`adj-quantity-${i}`}>
                <Input id={`adj-quantity-${i}`} type="number" min={1} step="1" value={row.quantity} onChange={(e) => setRow(i, { quantity: e.target.value })} required />
              </Field>
              <button
                type="button"
                aria-label="Remove location"
                disabled={rows.length <= 1}
                onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}
                className="mb-1 grid h-8 w-8 place-items-center rounded-md text-content-muted transition-colors hover:bg-danger-bg hover:text-danger disabled:opacity-30"
              >
                <TrashIcon size={14} />
              </button>
            </div>
          ))}
        </div>
        {rows.length > 1 ? (
          <p className={`mt-2 text-xs ${relocation ? "text-info" : "text-content-muted"}`}>
            {relocation
              ? "These rows net to zero, so this is recorded as a relocation between the locations — no stock is written off or found."
              : `Net change ${net > 0 ? "+" : ""}${net}: each row is a valued adjustment.`}
          </p>
        ) : null}
        {duplicateLocation ? <p className="mt-1 text-xs text-danger">Each location can appear once.</p> : null}
      </div>

      <Field label="Reason" htmlFor="adj-note" required>
        <Textarea id="adj-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Damaged in transit, cycle count correction, found in the wrong store, …" required />
      </Field>

      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <div className="flex items-center justify-end gap-2 border-t border-border pt-3">
        <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={busy || !valid}>
          {busy ? "Recording…" : relocation ? "Record relocation" : "Record adjustment"}
        </Button>
      </div>
    </form>
  );
}
