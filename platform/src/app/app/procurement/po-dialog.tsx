"use client";

import { useMemo, useState } from "react";

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
  cx,
} from "@/components/ui";

interface Option {
  id: string;
  name: string;
}

interface PoProduct extends Option {
  costPriceCents: number;
  taxRateBp: number;
}

interface Line {
  productId: string;
  quantity: string;
  unitCost: string;
}

/**
 * Create a purchase order with lines. Saves a DRAFT, or sends it straight to
 * the supplier queue — the same line maths the server applies (computeLine)
 * is previewed client-side so the total the user sees is the total the PO
 * lands with.
 */
export function PurchaseOrderDialog({
  suppliers,
  products,
}: {
  suppliers: Option[];
  products: PoProduct[];
}) {
  return (
    <ModalButton
      label="+ New purchase order"
      title="New purchase order"
      description="Totals include VAT at each product's rate. Sending raises the order to the supplier; draft holds it for review."
      width="max-w-3xl"
    >
      {(close) => <PoForm suppliers={suppliers} products={products} onClose={() => close()} />}
    </ModalButton>
  );
}

function PoForm({
  suppliers,
  products,
  onClose,
}: {
  suppliers: Option[];
  products: PoProduct[];
  onClose: () => void;
}) {
  const { busy, error, submit } = useFormSubmit();
  const [supplierId, setSupplierId] = useState(suppliers[0]?.id ?? "");
  const [expectedAt, setExpectedAt] = useState("");
  const [note, setNote] = useState("");
  const [send, setSend] = useState(true);
  const [lines, setLines] = useState<Line[]>([
    { productId: products[0]?.id ?? "", quantity: "1", unitCost: String((products[0]?.costPriceCents ?? 0) / 100 || 0) },
  ]);

  const byId = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);

  const totals = useMemo(() => {
    let subtotal = 0;
    let tax = 0;
    for (const l of lines) {
      const p = byId.get(l.productId);
      const qty = Number(l.quantity) || 0;
      const price = Math.round((Number(l.unitCost) || 0) * 100);
      if (!p || qty <= 0) continue;
      // Same exclusivity as the server: cost price is excl. VAT.
      subtotal += qty * price;
      tax += Math.round((qty * price * (p.taxRateBp / 10_000)) / 1);
    }
    return { subtotal, tax, total: subtotal + tax };
  }, [lines, byId]);

  const valid =
    supplierId &&
    lines.length > 0 &&
    lines.every((l) => l.productId && Number(l.quantity) > 0 && Number(l.unitCost) >= 0);

  async function save() {
    await submit(async () => {
      const body = {
        supplierId,
        expectedAt: expectedAt || undefined,
        note: note || undefined,
        send,
        lines: lines.map((l) => ({
          productId: l.productId,
          quantity: Number(l.quantity),
          unitCostCents: Math.round((Number(l.unitCost) || 0) * 100),
        })),
      };
      return await apiClient("/api/v1/purchase-orders", { method: "POST", body });
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
        <Field label="Supplier" htmlFor="po-supplier" required>
          <Select id="po-supplier" value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
            {suppliers.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </Select>
        </Field>
        <Field label="Expected delivery" htmlFor="po-expected">
          <Input id="po-expected" type="date" value={expectedAt} onChange={(e) => setExpectedAt(e.target.value)} />
        </Field>
        <Field label="Note" htmlFor="po-note">
          <Input id="po-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional reference" />
        </Field>
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <p className="text-sm font-medium">Lines</p>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() =>
              setLines((ls) => [
                ...ls,
                { productId: products[0]?.id ?? "", quantity: "1", unitCost: "" },
              ])
            }
          >
            <PlusIcon size={14} /> Add line
          </Button>
        </div>

        <div className="space-y-2">
          {lines.map((line, i) => {
            const p = byId.get(line.productId);
            const qty = Number(line.quantity) || 0;
            const cost = Number(line.unitCost) || 0;
            const lineTotal = qty * cost * (1 + (p?.taxRateBp ?? 0) / 10_000);
            return (
              <div key={i} className="grid grid-cols-[1fr_90px_110px_110px_32px] items-end gap-2">
                <Field label={i === 0 ? "Product" : undefined} htmlFor={`po-line-${i}`}>
                  <Select
                    id={`po-line-${i}`}
                    value={line.productId}
                    onChange={(e) =>
                      setLines((ls) => ls.map((x, j) => (j === i ? { ...x, productId: e.target.value, unitCost: x.unitCost || String((byId.get(e.target.value)?.costPriceCents ?? 0) / 100 || "") } : x)))
                    }
                  >
                    {products.map((pr) => (
                      <option key={pr.id} value={pr.id}>{pr.name}</option>
                    ))}
                  </Select>
                </Field>
                <Field label={i === 0 ? "Qty" : undefined} htmlFor={`po-qty-${i}`}>
                  <Input
                    id={`po-qty-${i}`}
                    type="number"
                    min={1}
                    step="1"
                    value={line.quantity}
                    onChange={(e) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)))}
                  />
                </Field>
                <Field label={i === 0 ? "Unit cost (KES)" : undefined} htmlFor={`po-cost-${i}`}>
                  <Input
                    id={`po-cost-${i}`}
                    type="number"
                    min={0}
                    step="1"
                    value={line.unitCost}
                    onChange={(e) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, unitCost: e.target.value } : x)))}
                  />
                </Field>
                <div className={cx("pb-2 text-right text-sm tabular", !qty && "text-content-muted")}>
                  {lineTotal > 0 ? `KES ${lineTotal.toLocaleString("en-KE", { maximumFractionDigits: 2, minimumFractionDigits: 2 })}` : "—"}
                </div>
                <button
                  type="button"
                  aria-label="Remove line"
                  disabled={lines.length <= 1}
                  onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}
                  className="mb-1 grid h-8 w-8 place-items-center rounded-md text-content-muted transition-colors hover:bg-danger-bg hover:text-danger disabled:opacity-30"
                >
                  <TrashIcon size={14} />
                </button>
              </div>
            );
          })}
        </div>

        <div className="mt-3 flex justify-end gap-6 rounded-lg bg-surface-sunken px-4 py-2.5 text-sm">
          <span>Subtotal <strong className="tabular">KES {(totals.subtotal / 100).toLocaleString("en-KE", { minimumFractionDigits: 2 })}</strong></span>
          <span>VAT <strong className="tabular">KES {(totals.tax / 100).toLocaleString("en-KE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong></span>
          <span>Total <strong className="tabular text-accent">KES {(totals.total / 100).toLocaleString("en-KE", { minimumFractionDigits: 2 })}</strong></span>
        </div>
      </div>

      <label className="flex items-center gap-2 text-sm font-medium">
        <input type="checkbox" checked={send} onChange={(e) => setSend(e.target.checked)} />
        Send to supplier now (otherwise save as draft)
      </label>

      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <div className="flex items-center justify-end gap-2 border-t border-border pt-3">
        <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={busy || !valid}>
          {busy ? "Saving…" : send ? "Create and send" : "Save draft"}
        </Button>
      </div>
    </form>
  );
}
