"use client";

import { useState } from "react";

import { ProductPicker, kes, onHandAt, type PickedProduct } from "@/components/product-picker";
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
 * Split / repack: stock of one product becomes stock of another at the same
 * location. The server carries the source's value across and writes both legs
 * under one reference; this form only previews what it will do.
 */
export function RepackDialog({ locations }: { locations: Option[] }) {
  return (
    <ModalButton
      label="Split / repack"
      title="Split or repack stock"
      description="Turn cartons into pieces (or pieces back into cartons). The value of what goes out is carried into what comes in."
      variant="secondary"
      width="max-w-xl"
    >
      {(close) => <RepackForm locations={locations} onClose={() => close()} />}
    </ModalButton>
  );
}

function RepackForm({ locations, onClose }: { locations: Option[]; onClose: () => void }) {
  const { busy, error, submit } = useFormSubmit();
  const [locationId, setLocationId] = useState(locations[0]?.id ?? "");
  const [from, setFrom] = useState<PickedProduct | null>(null);
  const [to, setTo] = useState<PickedProduct | null>(null);
  const [fromQty, setFromQty] = useState("1");
  const [toQty, setToQty] = useState("");
  const [toQtyTouched, setToQtyTouched] = useState(false);
  const [note, setNote] = useState("");

  const fromN = Math.max(0, Math.floor(Number(fromQty) || 0));
  const packDefault = from && from.unitsPerPack > 1 ? fromN * from.unitsPerPack : null;
  const toN = toQtyTouched || packDefault === null ? Math.max(0, Math.floor(Number(toQty) || 0)) : packDefault;

  const onHand = onHandAt(from, locationId);
  const valueCents = from ? fromN * from.costPriceCents : 0;
  const perUnit = toN > 0 ? Math.floor(valueCents / toN) : 0;
  const remainder = toN > 0 ? valueCents - perUnit * toN : 0;
  const pool = to ? Math.max(0, to.stockOnHand) : 0;
  const newAvg = to && toN > 0 ? Math.round((pool * to.costPriceCents + valueCents) / (pool + toN)) : 0;

  const problems: string[] = [];
  if (from && to && from.id === to.id) problems.push("Choose two different products.");
  if (from && !from.trackStock) problems.push(`${from.name} does not track stock.`);
  if (to && !to.trackStock) problems.push(`${to.name} does not track stock.`);
  if (from && fromN > onHand) problems.push(`Only ${onHand} on hand at this location.`);
  if (from && to && toN <= 0) problems.push("Say how many units the split produces.");

  const valid = Boolean(locationId && from && to && fromN > 0 && toN > 0 && problems.length === 0);

  async function save() {
    await submit(async () => {
      return await apiClient("/api/v1/stock/repack", {
        method: "POST",
        body: {
          locationId,
          fromProductId: from!.id,
          fromQuantity: fromN,
          toProductId: to!.id,
          toQuantity: toN,
          note: note.trim() || undefined,
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
      <Field label="Location" htmlFor="rp-location" required>
        <Select id="rp-location" value={locationId} onChange={(e) => setLocationId(e.target.value)}>
          {locations.map((l) => (
            <option key={l.id} value={l.id}>{l.name}</option>
          ))}
        </Select>
      </Field>

      <div className="grid gap-3 sm:grid-cols-[1fr_120px]">
        <Field label="Split from" htmlFor="rp-from" required hint={from ? `${onHand} on hand here · cost ${kes(from.costPriceCents)} each` : undefined}>
          <ProductPicker id="rp-from" value={from} onChange={setFrom} exclude={to ? [to.id] : undefined} />
        </Field>
        <Field label="Quantity" htmlFor="rp-from-qty" required>
          <Input id="rp-from-qty" type="number" min={1} step="1" value={fromQty} onChange={(e) => setFromQty(e.target.value)} />
        </Field>
      </div>

      <div className="grid gap-3 sm:grid-cols-[1fr_120px]">
        <Field label="Into" htmlFor="rp-to" required hint={to ? `${to.stockOnHand} held in total · cost ${kes(to.costPriceCents)} each` : undefined}>
          <ProductPicker id="rp-to" value={to} onChange={setTo} exclude={from ? [from.id] : undefined} />
        </Field>
        <Field
          label="Produces"
          htmlFor="rp-to-qty"
          required
          hint={packDefault !== null && !toQtyTouched ? `${from!.unitsPerPack} per pack` : undefined}
        >
          <Input
            id="rp-to-qty"
            type="number"
            min={1}
            step="1"
            value={toQtyTouched || packDefault === null ? toQty : String(packDefault)}
            onChange={(e) => {
              setToQtyTouched(true);
              setToQty(e.target.value);
            }}
          />
        </Field>
      </div>

      {from && to && fromN > 0 && toN > 0 ? (
        <div className="rounded-lg bg-surface-sunken px-4 py-3 text-sm">
          <p>
            <strong>{fromN}</strong> × {from.name} out, worth <strong className="tabular">{kes(valueCents)}</strong>
          </p>
          <p>
            <strong>{toN}</strong> × {to.name} in at <strong className="tabular">{kes(perUnit)}</strong> each
            {remainder > 0 ? (
              <span className="text-content-muted"> · {remainder} cent{remainder === 1 ? "" : "s"} of rounding written off</span>
            ) : null}
          </p>
          <p className="text-content-muted">
            {to.name} average cost {kes(to.costPriceCents)} → <span className="tabular">{kes(newAvg)}</span>
          </p>
        </div>
      ) : null}

      <Field label="Note" htmlFor="rp-note">
        <Textarea id="rp-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Opened cartons for the van, …" />
      </Field>

      {problems.length > 0 ? (
        <ul className="space-y-1 text-sm text-warning">
          {problems.map((p) => <li key={p}>{p}</li>)}
        </ul>
      ) : null}
      {error ? <p className="text-sm text-danger">{error}</p> : null}

      <div className="flex items-center justify-end gap-2 border-t border-border pt-3">
        <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={busy || !valid}>
          {busy ? "Recording…" : "Record split"}
        </Button>
      </div>
    </form>
  );
}
