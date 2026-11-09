"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";

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
interface QuoteProduct extends Option {
  sellPriceCents: number;
  taxRateBp: number;
}
interface Line {
  productId: string;
  quantity: string;
  unitPrice: string;
  discount: string;
}

/** Raise a quotation from the console. Pricing preview mirrors the server. */
export function QuotationDialog({
  customers,
  products,
  presetCustomerId,
  buttonLabel = "+ New quotation",
}: {
  customers: Option[];
  products: QuoteProduct[];
  presetCustomerId?: string;
  buttonLabel?: string;
}) {
  return (
    <ModalButton
      label={buttonLabel}
      title="New quotation"
      description="A priced proposal. Send it, then convert the accepted quote to an order or invoice. Prices exclude VAT."
      width="max-w-3xl"
    >
      {(close) => (
        <QuotationForm customers={customers} products={products} presetCustomerId={presetCustomerId} onClose={() => close()} />
      )}
    </ModalButton>
  );
}

function QuotationForm({
  customers,
  products,
  presetCustomerId,
  onClose,
}: {
  customers: Option[];
  products: QuoteProduct[];
  presetCustomerId?: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const { busy, error, submit } = useFormSubmit();
  const [customerId, setCustomerId] = useState(presetCustomerId ?? customers[0]?.id ?? "");
  const [validUntil, setValidUntil] = useState("");
  const [note, setNote] = useState("");
  const [send, setSend] = useState(false);
  const [lines, setLines] = useState<Line[]>([
    { productId: products[0]?.id ?? "", quantity: "1", unitPrice: String((products[0]?.sellPriceCents ?? 0) / 100 || ""), discount: "0" },
  ]);

  const byId = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);

  const totals = useMemo(() => {
    let subtotal = 0, discount = 0, tax = 0;
    for (const l of lines) {
      const p = byId.get(l.productId);
      const qty = Number(l.quantity) || 0;
      const price = Math.round((Number(l.unitPrice) || 0) * 100);
      const dsc = Math.round((Number(l.discount) || 0) * 100);
      if (!p || qty <= 0) continue;
      const gross = qty * price;
      const capped = Math.min(dsc, gross);
      const net = gross - capped;
      subtotal += gross;
      discount += capped;
      tax += Math.round((net * p.taxRateBp) / 10_000);
    }
    return { subtotal, discount, tax, total: subtotal - discount + tax };
  }, [lines, byId]);

  const valid = customerId && lines.length > 0 && lines.every((l) => l.productId && Number(l.quantity) > 0);

  async function save() {
    await submit(async () => {
      const body = {
        customerId,
        validUntil: validUntil || undefined,
        note: note || undefined,
        send,
        lines: lines.map((l) => ({
          productId: l.productId,
          quantity: Number(l.quantity),
          unitPriceCents: Math.round((Number(l.unitPrice) || 0) * 100),
          ...(Number(l.discount) > 0 ? { discountCents: Math.round(Number(l.discount) * 100) } : {}),
        })),
      };
      return await apiClient("/api/v1/quotations", { method: "POST", body });
    }, { onSuccess: () => { onClose(); router.refresh(); } });
  }

  const money = (c: number) => `KES ${(c / 100).toLocaleString("en-KE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  return (
    <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Customer" htmlFor="q-customer" required>
          <Select id="q-customer" value={customerId} onChange={(e) => setCustomerId(e.target.value)} disabled={!!presetCustomerId}>
            {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </Field>
        <Field label="Valid until" htmlFor="q-valid" hint="Optional">
          <Input id="q-valid" type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} />
        </Field>
        <Field label="Note" htmlFor="q-note">
          <Input id="q-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional" />
        </Field>
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <p className="text-sm font-medium">Lines</p>
          <Button type="button" variant="secondary" size="sm"
            onClick={() => setLines((ls) => [...ls, { productId: products[0]?.id ?? "", quantity: "1", unitPrice: "", discount: "0" }])}>
            <PlusIcon size={14} /> Add line
          </Button>
        </div>
        <div className="space-y-2">
          {lines.map((line, i) => {
            const p = byId.get(line.productId);
            const qty = Number(line.quantity) || 0;
            const price = Math.round((Number(line.unitPrice) || 0) * 100);
            const dsc = Math.round((Number(line.discount) || 0) * 100);
            const net = Math.max(qty * price - Math.min(dsc, qty * price), 0);
            const lineTotal = net + Math.round((net * (p?.taxRateBp ?? 0)) / 10_000);
            return (
              <div key={i} className="grid grid-cols-[1fr_72px_120px_96px_120px_32px] items-end gap-2">
                <Field label={i === 0 ? "Product" : undefined} htmlFor={`q-line-${i}`}>
                  <Select id={`q-line-${i}`} value={line.productId}
                    onChange={(e) => setLines((ls) => ls.map((x, j) => j === i ? { ...x, productId: e.target.value, unitPrice: x.unitPrice || String((byId.get(e.target.value)?.sellPriceCents ?? 0) / 100 || "") } : x))}>
                    {products.map((pr) => <option key={pr.id} value={pr.id}>{pr.name}</option>)}
                  </Select>
                </Field>
                <Field label={i === 0 ? "Qty" : undefined} htmlFor={`q-qty-${i}`}>
                  <Input id={`q-qty-${i}`} type="number" min={1} step="1" value={line.quantity}
                    onChange={(e) => setLines((ls) => ls.map((x, j) => j === i ? { ...x, quantity: e.target.value } : x))} />
                </Field>
                <Field label={i === 0 ? "Unit price" : undefined} htmlFor={`q-price-${i}`}>
                  <Input id={`q-price-${i}`} type="number" min={0} step="1" value={line.unitPrice}
                    onChange={(e) => setLines((ls) => ls.map((x, j) => j === i ? { ...x, unitPrice: e.target.value } : x))} />
                </Field>
                <Field label={i === 0 ? "Discount" : undefined} htmlFor={`q-disc-${i}`}>
                  <Input id={`q-disc-${i}`} type="number" min={0} step="1" value={line.discount}
                    onChange={(e) => setLines((ls) => ls.map((x, j) => j === i ? { ...x, discount: e.target.value } : x))} />
                </Field>
                <div className={cx("pb-2 text-right text-sm tabular", !qty && "text-content-muted")}>
                  {lineTotal > 0 ? (lineTotal / 100).toLocaleString("en-KE", { minimumFractionDigits: 2 }) : "—"}
                </div>
                <button type="button" aria-label="Remove line" disabled={lines.length <= 1}
                  onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}
                  className="mb-1 grid h-8 w-8 place-items-center rounded-md text-content-muted transition-colors hover:bg-danger-bg hover:text-danger disabled:opacity-30">
                  <TrashIcon size={14} />
                </button>
              </div>
            );
          })}
        </div>
        <div className="mt-3 flex flex-wrap justify-end gap-x-6 gap-y-1 rounded-lg bg-surface-sunken px-4 py-2.5 text-sm">
          <span>Subtotal <strong className="tabular">{money(totals.subtotal)}</strong></span>
          {totals.discount > 0 ? <span className="text-warning">Discount <strong className="tabular">−{money(totals.discount)}</strong></span> : null}
          <span>VAT <strong className="tabular">{money(totals.tax)}</strong></span>
          <span>Total <strong className="tabular text-accent">{money(totals.total)}</strong></span>
        </div>
      </div>

      <label className="flex items-center gap-2 text-sm font-medium">
        <input type="checkbox" checked={send} onChange={(e) => setSend(e.target.checked)} />
        Mark as sent (untick to keep as a draft)
      </label>

      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <div className="flex items-center justify-end gap-2 border-t border-border pt-3">
        <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={busy || !valid}>
          {busy ? "Saving…" : send ? "Create & send" : "Save draft"}
        </Button>
      </div>
    </form>
  );
}
