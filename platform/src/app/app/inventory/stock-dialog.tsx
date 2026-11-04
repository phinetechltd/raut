"use client";

import { useState } from "react";

import {
  apiClient,
  useFormSubmit,
  Button,
  Field,
  Input,
  ModalButton,
  Select,
  Textarea,
} from "@/components/ui";

interface Option {
  id: string;
  name: string;
}

/**
 * Manual stock adjustment. The server writes a ledgered movement — a balance
 * is derived from movements, never edited — so every adjust carries a note.
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
      width="max-w-md"
    >
      {(close) => (
        <StockAdjustForm products={products} locations={locations} onClose={() => close()} />
      )}
    </ModalButton>
  );
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
  const [form, setForm] = useState({
    productId: products[0]?.id ?? "",
    locationId: locations[0]?.id ?? "",
    quantity: "1",
    direction: "in" as "in" | "out",
    note: "",
  });
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const qty = Math.abs(Number(form.quantity) || 0);

  async function save() {
    await submit(async () => {
      const signed = form.direction === "out" ? -qty : qty;
      return await apiClient("/api/v1/stock", {
        method: "POST",
        body: {
          productId: form.productId,
          locationId: form.locationId,
          quantity: signed,
          note: form.note.trim() || "Manual adjustment",
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
      <Field label="Product" htmlFor="adj-product" required>
        <Select id="adj-product" value={form.productId} onChange={(e) => set("productId", e.target.value)}>
          {products.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </Select>
      </Field>
      <Field label="Location" htmlFor="adj-location" required>
        <Select id="adj-location" value={form.locationId} onChange={(e) => set("locationId", e.target.value)}>
          {locations.map((l) => (
            <option key={l.id} value={l.id}>{l.name}</option>
          ))}
        </Select>
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Direction" htmlFor="adj-direction">
          <Select id="adj-direction" value={form.direction} onChange={(e) => set("direction", e.target.value as "in" | "out")}>
            <option value="in">Stock in (+)</option>
            <option value="out">Stock out (−)</option>
          </Select>
        </Field>
        <Field label="Quantity" htmlFor="adj-quantity" required>
          <Input id="adj-quantity" type="number" min={1} step="1" value={form.quantity} onChange={(e) => set("quantity", e.target.value)} required />
        </Field>
      </div>
      <Field label="Reason" htmlFor="adj-note" required>
        <Textarea id="adj-note" rows={2} value={form.note} onChange={(e) => set("note", e.target.value)} placeholder="Damaged in transit, cycle count correction, …" required />
      </Field>

      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <div className="flex items-center justify-end gap-2 border-t border-border pt-3">
        <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={busy || !form.productId || !form.locationId || qty < 1 || !form.note.trim()}>
          {busy ? "Recording…" : "Record adjustment"}
        </Button>
      </div>
    </form>
  );
}
