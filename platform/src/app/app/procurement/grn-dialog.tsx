"use client";

import { useMemo, useState } from "react";

import { ProductPicker, kes, type PickedProduct } from "@/components/product-picker";
import {
  apiClient,
  useFormSubmit,
  Button,
  Field,
  Input,
  ModalButton,
  PlusIcon,
  Select,
  TrashIcon,
} from "@/components/ui";

interface Option {
  id: string;
  name: string;
}

export interface OpenOrderLine {
  id: string;
  productId: string;
  productName: string;
  quantity: number;
  received: number;
  unitCostCents: number;
}

export interface OpenOrder {
  id: string;
  number: string;
  supplierId: string;
  supplierName: string;
  lines: OpenOrderLine[];
}

interface Line {
  /** Set when the line fulfils a PO line. */
  poLineId: string | null;
  productId: string;
  productName: string;
  remaining: number | null;
  quantity: string;
  unitCost: string;
  /** "" means the receipt's own location. */
  locationId: string;
  /** For free-standing lines, the picked product. */
  product: PickedProduct | null;
}

/**
 * Receive goods — against an open purchase order (lines prefilled with what is
 * still outstanding) or free-standing from a supplier. Each line can land at a
 * different location than the receipt's own, for a delivery split between
 * stores. Posts straight away unless told to hold a draft.
 */
export function GoodsReceiptDialog({
  suppliers,
  locations,
  openOrders,
}: {
  suppliers: Option[];
  locations: Option[];
  openOrders: OpenOrder[];
}) {
  return (
    <ModalButton
      label="Receive goods"
      title="Receive goods"
      description="Posting moves stock onto the shelf at each line's location, updates the product's cost basis and books inventory against the supplier."
      variant="secondary"
      width="max-w-3xl"
    >
      {(close) => <GrnForm suppliers={suppliers} locations={locations} openOrders={openOrders} onClose={() => close()} />}
    </ModalButton>
  );
}

function linesFromOrder(po: OpenOrder): Line[] {
  return po.lines
    .filter((l) => l.quantity - l.received > 0)
    .map((l) => ({
      poLineId: l.id,
      productId: l.productId,
      productName: l.productName,
      remaining: l.quantity - l.received,
      quantity: String(l.quantity - l.received),
      unitCost: String(l.unitCostCents / 100),
      locationId: "",
      product: null,
    }));
}

const freeLine = (): Line => ({
  poLineId: null,
  productId: "",
  productName: "",
  remaining: null,
  quantity: "1",
  unitCost: "",
  locationId: "",
  product: null,
});

function GrnForm({
  suppliers,
  locations,
  openOrders,
  onClose,
}: {
  suppliers: Option[];
  locations: Option[];
  openOrders: OpenOrder[];
  onClose: () => void;
}) {
  const { busy, error, submit } = useFormSubmit();
  const [poId, setPoId] = useState(openOrders[0]?.id ?? "");
  const [supplierId, setSupplierId] = useState(suppliers[0]?.id ?? "");
  const [locationId, setLocationId] = useState(locations[0]?.id ?? "");
  const [note, setNote] = useState("");
  const [post, setPost] = useState(true);
  const [allowOver, setAllowOver] = useState(false);
  const [lines, setLines] = useState<Line[]>(openOrders[0] ? linesFromOrder(openOrders[0]) : [freeLine()]);

  const po = useMemo(() => openOrders.find((o) => o.id === poId) ?? null, [openOrders, poId]);

  function chooseOrder(id: string) {
    setPoId(id);
    const next = openOrders.find((o) => o.id === id);
    setLines(next ? linesFromOrder(next) : [freeLine()]);
  }

  const setLine = (i: number, patch: Partial<Line>) =>
    setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  const parsed = lines.map((l) => ({
    ...l,
    qty: Math.floor(Number(l.quantity) || 0),
    cents: Math.round((Number(l.unitCost) || 0) * 100),
  }));
  const over = parsed.filter((l) => l.remaining !== null && l.qty > l.remaining);
  const total = parsed.reduce((n, l) => n + l.qty * l.cents, 0);
  const valid =
    locationId &&
    (po || supplierId) &&
    parsed.length > 0 &&
    parsed.every((l) => l.productId && l.qty > 0 && l.cents >= 0) &&
    (over.length === 0 || allowOver);

  async function save() {
    await submit(async () => {
      return await apiClient("/api/v1/goods-receipts", {
        method: "POST",
        body: {
          poId: po?.id,
          supplierId: po ? undefined : supplierId,
          locationId,
          note: note.trim() || undefined,
          post,
          allowOver: allowOver || undefined,
          lines: parsed.map((l) => ({
            productId: l.productId,
            quantity: l.qty,
            unitCostCents: l.cents,
            locationId: l.locationId || undefined,
            poLineId: l.poLineId ?? undefined,
          })),
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
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Purchase order" htmlFor="grn-po">
          <Select id="grn-po" value={poId} onChange={(e) => chooseOrder(e.target.value)}>
            <option value="">No purchase order</option>
            {openOrders.map((o) => (
              <option key={o.id} value={o.id}>{o.number} · {o.supplierName}</option>
            ))}
          </Select>
        </Field>
        <Field label="Supplier" htmlFor="grn-supplier" required>
          {po ? (
            <Input id="grn-supplier" value={po.supplierName} readOnly />
          ) : (
            <Select id="grn-supplier" value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Receive into" htmlFor="grn-location" required>
          <Select id="grn-location" value={locationId} onChange={(e) => setLocationId(e.target.value)}>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>{l.name}</option>
            ))}
          </Select>
        </Field>
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <p className="text-sm font-medium">Lines</p>
          {!po ? (
            <Button type="button" variant="secondary" size="sm" onClick={() => setLines((ls) => [...ls, freeLine()])}>
              <PlusIcon size={14} /> Add line
            </Button>
          ) : null}
        </div>
        {lines.length === 0 ? (
          <p className="text-sm text-content-muted">Everything on this order has been received.</p>
        ) : null}
        <div className="space-y-2">
          {parsed.map((line, i) => (
            <div key={line.poLineId ?? `free-${i}`} className="grid grid-cols-[1fr_90px_120px_150px_32px] items-start gap-2">
              <Field label={i === 0 ? "Product" : undefined} htmlFor={`grn-line-${i}`} hint={line.remaining !== null ? `${line.remaining} outstanding on the order` : undefined}>
                {line.poLineId ? (
                  <Input id={`grn-line-${i}`} value={line.productName} readOnly />
                ) : (
                  <ProductPicker
                    id={`grn-line-${i}`}
                    value={line.product}
                    onChange={(p) =>
                      setLine(i, {
                        product: p,
                        productId: p?.id ?? "",
                        productName: p?.name ?? "",
                        unitCost: p && !line.unitCost ? String(p.costPriceCents / 100) : line.unitCost,
                      })
                    }
                  />
                )}
              </Field>
              <Field label={i === 0 ? "Qty" : undefined} htmlFor={`grn-qty-${i}`}>
                <Input
                  id={`grn-qty-${i}`}
                  type="number"
                  min={1}
                  step="1"
                  className={line.remaining !== null && line.qty > line.remaining ? "border-warning" : undefined}
                  value={line.quantity}
                  onChange={(e) => setLine(i, { quantity: e.target.value })}
                />
              </Field>
              <Field label={i === 0 ? "Unit cost (KES)" : undefined} htmlFor={`grn-cost-${i}`}>
                <Input id={`grn-cost-${i}`} type="number" min={0} step="0.01" value={line.unitCost} onChange={(e) => setLine(i, { unitCost: e.target.value })} />
              </Field>
              <Field label={i === 0 ? "Location" : undefined} htmlFor={`grn-loc-${i}`}>
                <Select id={`grn-loc-${i}`} value={line.locationId} onChange={(e) => setLine(i, { locationId: e.target.value })}>
                  <option value="">Receipt location</option>
                  {locations.filter((l) => l.id !== locationId).map((l) => (
                    <option key={l.id} value={l.id}>{l.name}</option>
                  ))}
                </Select>
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
          ))}
        </div>

        <div className="mt-3 flex items-center justify-between rounded-lg bg-surface-sunken px-4 py-2.5 text-sm">
          <span className="text-content-muted">Excluding VAT</span>
          <span>Value <strong className="tabular text-accent">{kes(total)}</strong></span>
        </div>
      </div>

      {over.length > 0 ? (
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-0.5" checked={allowOver} onChange={(e) => setAllowOver(e.target.checked)} />
          <span>
            <span className="font-medium">Accept more than ordered.</span>{" "}
            <span className="text-content-muted">{over.length} line{over.length === 1 ? "" : "s"} exceed what is outstanding on the purchase order.</span>
          </span>
        </label>
      ) : null}

      <Field label="Note" htmlFor="grn-note">
        <Input id="grn-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Delivery note number, driver, …" />
      </Field>

      <label className="flex items-center gap-2 text-sm font-medium">
        <input type="checkbox" checked={post} onChange={(e) => setPost(e.target.checked)} />
        Post now (otherwise hold as a draft to post later)
      </label>

      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <div className="flex items-center justify-end gap-2 border-t border-border pt-3">
        <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={busy || !valid}>
          {busy ? "Saving…" : post ? "Receive and post" : "Save draft"}
        </Button>
      </div>
    </form>
  );
}

/** Per-row action: posts a DRAFT receipt. */
export function PostGoodsReceiptButton({ id, number }: { id: string; number: string }) {
  const { busy, error, submit } = useFormSubmit();
  return (
    <span className="inline-flex items-center gap-2">
      <Button
        type="button"
        size="sm"
        variant="primary"
        disabled={busy}
        aria-label={`Post ${number}`}
        onClick={() => void submit(() => apiClient(`/api/v1/goods-receipts/${id}/post`, { method: "POST", body: {} }))}
      >
        {busy ? "Posting…" : "Post"}
      </Button>
      {error ? <span className="text-xs text-danger">{error}</span> : null}
    </span>
  );
}
