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

interface InvoiceProduct extends Option {
  sellPriceCents: number;
  taxRateBp: number;
}

interface Line {
  productId: string;
  quantity: string;
  unitPrice: string;
  discount: string;
}

/**
 * Raise an invoice from the console. Line preview mirrors the server's
 * computeLine exactly (VAT on the discounted consideration, prices tax-excl.)
 * so the total shown here is the total the invoice lands with.
 */
export function InvoiceDialog({
  customers,
  products,
  presetCustomerId,
  buttonLabel = "+ New invoice",
}: {
  customers: Option[];
  products: InvoiceProduct[];
  presetCustomerId?: string;
  buttonLabel?: string;
}) {
  return (
    <ModalButton
      label={buttonLabel}
      title="New invoice"
      description="Issued at once and filed with KRA when eTIMS is on. Prices exclude VAT."
      width="max-w-3xl"
    >
      {(close) => (
        <InvoiceForm
          customers={customers}
          products={products}
          presetCustomerId={presetCustomerId}
          onClose={() => close()}
        />
      )}
    </ModalButton>
  );
}

function InvoiceForm({
  customers,
  products,
  presetCustomerId,
  onClose,
}: {
  customers: Option[];
  products: InvoiceProduct[];
  presetCustomerId?: string;
  onClose: () => void;
}) {
  const { busy, error, submit } = useFormSubmit();
  const [customerId, setCustomerId] = useState(presetCustomerId ?? customers[0]?.id ?? "");
  const [dueDate, setDueDate] = useState("");
  const [note, setNote] = useState("");
  const [issue, setIssue] = useState(true);
  const [lines, setLines] = useState<Line[]>([
    {
      productId: products[0]?.id ?? "",
      quantity: "1",
      unitPrice: String((products[0]?.sellPriceCents ?? 0) / 100 || ""),
      discount: "0",
    },
  ]);

  const byId = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);

  const totals = useMemo(() => {
    let subtotal = 0;
    let discount = 0;
    let tax = 0;
    for (const l of lines) {
      const p = byId.get(l.productId);
      const qty = Number(l.quantity) || 0;
      const price = Math.round((Number(l.unitPrice) || 0) * 100);
      const dsc = Math.round((Number(l.discount) || 0) * 100);
      if (!p || qty <= 0) continue;
      const gross = qty * price;
      const cappedDiscount = Math.min(dsc, gross);
      const net = gross - cappedDiscount;
      subtotal += gross;
      discount += cappedDiscount;
      tax += Math.round((net * p.taxRateBp) / 10_000);
    }
    return { subtotal, discount, tax, total: subtotal - discount + tax };
  }, [lines, byId]);

  const valid =
    customerId &&
    lines.length > 0 &&
    lines.every((l) => l.productId && Number(l.quantity) > 0);

  async function save() {
    await submit(async () => {
      const body = {
        customerId,
        dueDate: dueDate || undefined,
        note: note || undefined,
        issue,
        channel: "CONSOLE",
        clientUuid: crypto.randomUUID(),
        lines: lines.map((l) => ({
          productId: l.productId,
          quantity: Number(l.quantity),
          unitPriceCents: Math.round((Number(l.unitPrice) || 0) * 100),
          ...(Number(l.discount) > 0
            ? { discountCents: Math.round(Number(l.discount) * 100) }
            : {}),
        })),
      };
      return await apiClient("/api/v1/invoices", { method: "POST", body });
    }, { onSuccess: onClose });
  }

  const money = (cents: number) =>
    `KES ${(cents / 100).toLocaleString("en-KE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Customer" htmlFor="inv-customer" required>
          <Select
            id="inv-customer"
            value={customerId}
            onChange={(e) => setCustomerId(e.target.value)}
            disabled={!!presetCustomerId}
          >
            {customers.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </Select>
        </Field>
        <Field label="Due date" htmlFor="inv-due" hint="Blank uses the customer's terms">
          <Input id="inv-due" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
        </Field>
        <Field label="Note" htmlFor="inv-note">
          <Input id="inv-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional" />
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
              setLines((ls) => [...ls, { productId: products[0]?.id ?? "", quantity: "1", unitPrice: "", discount: "0" }])
            }
          >
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
                <Field label={i === 0 ? "Product" : undefined} htmlFor={`inv-line-${i}`}>
                  <Select
                    id={`inv-line-${i}`}
                    value={line.productId}
                    onChange={(e) =>
                      setLines((ls) =>
                        ls.map((x, j) =>
                          j === i
                            ? { ...x, productId: e.target.value, unitPrice: x.unitPrice || String((byId.get(e.target.value)?.sellPriceCents ?? 0) / 100 || "") }
                            : x,
                        ),
                      )
                    }
                  >
                    {products.map((pr) => (
                      <option key={pr.id} value={pr.id}>{pr.name}</option>
                    ))}
                  </Select>
                </Field>
                <Field label={i === 0 ? "Qty" : undefined} htmlFor={`inv-qty-${i}`}>
                  <Input
                    id={`inv-qty-${i}`}
                    type="number"
                    min={1}
                    step="1"
                    value={line.quantity}
                    onChange={(e) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)))}
                  />
                </Field>
                <Field label={i === 0 ? "Unit price" : undefined} htmlFor={`inv-price-${i}`}>
                  <Input
                    id={`inv-price-${i}`}
                    type="number"
                    min={0}
                    step="1"
                    value={line.unitPrice}
                    onChange={(e) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, unitPrice: e.target.value } : x)))}
                  />
                </Field>
                <Field label={i === 0 ? "Discount" : undefined} htmlFor={`inv-disc-${i}`}>
                  <Input
                    id={`inv-disc-${i}`}
                    type="number"
                    min={0}
                    step="1"
                    value={line.discount}
                    onChange={(e) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, discount: e.target.value } : x)))}
                  />
                </Field>
                <div className={cx("pb-2 text-right text-sm tabular", !qty && "text-content-muted")}>
                  {lineTotal > 0 ? <>{(lineTotal / 100).toLocaleString("en-KE", { minimumFractionDigits: 2 })}</> : "—"}
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

        <div className="mt-3 flex flex-wrap justify-end gap-x-6 gap-y-1 rounded-lg bg-surface-sunken px-4 py-2.5 text-sm">
          <span>Subtotal <strong className="tabular">{money(totals.subtotal)}</strong></span>
          {totals.discount > 0 ? <span className="text-warning">Discount <strong className="tabular">−{money(totals.discount)}</strong></span> : null}
          <span>VAT <strong className="tabular">{money(totals.tax)}</strong></span>
          <span>Total <strong className="tabular text-accent">{money(totals.total)}</strong></span>
        </div>
      </div>

      <label className="flex items-center gap-2 text-sm font-medium">
        <input type="checkbox" checked={issue} onChange={(e) => setIssue(e.target.checked)} />
        Issue immediately (untick to save as draft)
      </label>

      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <div className="flex items-center justify-end gap-2 border-t border-border pt-3">
        <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={busy || !valid}>
          {busy ? "Creating…" : issue ? "Issue invoice" : "Save draft"}
        </Button>
      </div>
    </form>
  );
}
