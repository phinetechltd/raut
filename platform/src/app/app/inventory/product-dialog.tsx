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
} from "@/components/ui";

export interface ProductShape {
  id?: string;
  sku: string;
  name: string;
  description?: string | null;
  unit: string;
  unitsPerPack: number;
  barcode?: string | null;
  sellPriceCents: number;
  costPriceCents: number;
  taxRateBp: number;
  reorderLevel: number;
  trackStock: boolean;
  categoryId?: string | null;
  active?: boolean;
}

interface Option {
  id: string;
  name: string;
}

const UNITS = ["PC", "CTN", "KG", "L", "DZ", "BAG", "BOX", "BTL", "PKT"];
const TAX_RATES = [
  { bp: 1600, label: "VAT 16% (standard)" },
  { bp: 800, label: "VAT 8% (reduced)" },
  { bp: 0, label: "Zero-rated / exempt" },
];

export function ProductDialog({
  mode,
  product,
  categories,
  buttonLabel,
  buttonVariant = "ghost",
}: {
  mode: "create" | "edit";
  product?: ProductShape;
  categories: Option[];
  buttonLabel?: string;
  buttonVariant?: "primary" | "secondary" | "ghost" | "danger";
}) {
  return (
    <ModalButton
      label={buttonLabel ?? (mode === "create" ? "+ New product" : "Edit")}
      title={mode === "create" ? "New product" : `Edit ${product?.name ?? "product"}`}
      description="Prices are keyed in KES excluding VAT; the tax rate adds VAT at invoice time. eTIMS classification is set under Settings → eTIMS."
      variant={buttonVariant === "ghost" && mode === "edit" ? "ghost" : buttonVariant}
      size="sm"
      width="max-w-2xl"
    >
      {(close) => (
        <ProductForm mode={mode} product={product} categories={categories} onClose={() => close()} />
      )}
    </ModalButton>
  );
}

function ProductForm({
  mode,
  product,
  categories,
  onClose,
}: {
  mode: "create" | "edit";
  product?: ProductShape;
  categories: Option[];
  onClose: () => void;
}) {
  const { busy, error, submit } = useFormSubmit();
  const [form, setForm] = useState({
    sku: product?.sku ?? "",
    name: product?.name ?? "",
    description: product?.description ?? "",
    unit: product?.unit ?? "PC",
    unitsPerPack: String(product?.unitsPerPack ?? 1),
    barcode: product?.barcode ?? "",
    sellPrice: ((product?.sellPriceCents ?? 0) / 100).toString(),
    costPrice: ((product?.costPriceCents ?? 0) / 100).toString(),
    taxRateBp: String(product?.taxRateBp ?? 1600),
    reorderLevel: String(product?.reorderLevel ?? 0),
    trackStock: product?.trackStock ?? true,
    categoryId: product?.categoryId ?? "",
    active: product?.active ?? true,
  });
  const set = (k: keyof typeof form, v: string | boolean) => setForm((f) => ({ ...f, [k]: v }));

  async function save() {
    await submit(async () => {
      const body: Record<string, unknown> = {
        name: form.name.trim(),
        description: form.description || null,
        unit: form.unit,
        unitsPerPack: Math.max(1, Number(form.unitsPerPack) || 1),
        barcode: form.barcode || null,
        sellPriceCents: Math.round(Number(form.sellPrice || 0) * 100),
        costPriceCents: Math.round(Number(form.costPrice || 0) * 100),
        taxRateBp: Number(form.taxRateBp),
        reorderLevel: Math.max(0, Number(form.reorderLevel) || 0),
        trackStock: form.trackStock,
        categoryId: form.categoryId || null,
      };
      if (mode === "create") {
        body.sku = form.sku.trim();
        return await apiClient("/api/v1/products", { method: "POST", body });
      }
      body.active = form.active;
      return await apiClient(`/api/v1/products/${product!.id}`, { method: "PATCH", body });
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
        {mode === "create" ? (
          <Field label="SKU" htmlFor="prod-sku" required>
            <Input id="prod-sku" value={form.sku} onChange={(e) => set("sku", e.target.value)} required />
          </Field>
        ) : (
          <Field label="SKU" htmlFor="prod-sku-ro">
            <Input id="prod-sku-ro" value={form.sku} disabled />
          </Field>
        )}
        <Field label="Name" htmlFor="prod-name" required>
          <Input id="prod-name" value={form.name} onChange={(e) => set("name", e.target.value)} required minLength={2} />
        </Field>
        <Field label="Category" htmlFor="prod-category">
          <Select id="prod-category" value={form.categoryId} onChange={(e) => set("categoryId", e.target.value)}>
            <option value="">— uncategorised —</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </Select>
        </Field>
        <Field label="Barcode" htmlFor="prod-barcode" hint="Optional">
          <Input id="prod-barcode" value={form.barcode} onChange={(e) => set("barcode", e.target.value)} />
        </Field>
        <Field label="Selling price (KES, excl. VAT)" htmlFor="prod-sell" required>
          <Input id="prod-sell" type="number" min={0} step="1" value={form.sellPrice} onChange={(e) => set("sellPrice", e.target.value)} required />
        </Field>
        <Field label="Cost price (KES, excl. VAT)" htmlFor="prod-cost">
          <Input id="prod-cost" type="number" min={0} step="1" value={form.costPrice} onChange={(e) => set("costPrice", e.target.value)} />
        </Field>
        <Field label="VAT rate" htmlFor="prod-tax">
          <Select id="prod-tax" value={form.taxRateBp} onChange={(e) => set("taxRateBp", e.target.value)}>
            {TAX_RATES.map((t) => (
              <option key={t.bp} value={t.bp}>{t.label}</option>
            ))}
          </Select>
        </Field>
        <Field label="Sellable unit" htmlFor="prod-unit">
          <Select id="prod-unit" value={form.unit} onChange={(e) => set("unit", e.target.value)}>
            {UNITS.map((u) => (
              <option key={u} value={u}>{u}</option>
            ))}
          </Select>
        </Field>
        <Field label="Units per pack" htmlFor="prod-pack" hint="For van-sales pack maths">
          <Input id="prod-pack" type="number" min={1} step="1" value={form.unitsPerPack} onChange={(e) => set("unitsPerPack", e.target.value)} />
        </Field>
        <Field label="Reorder level" htmlFor="prod-reorder" hint="Low-stock alert below this on-hand qty">
          <Input id="prod-reorder" type="number" min={0} step="1" value={form.reorderLevel} onChange={(e) => set("reorderLevel", e.target.value)} />
        </Field>
      </div>

      <Field label="Description" htmlFor="prod-desc">
        <Input id="prod-desc" value={form.description} onChange={(e) => set("description", e.target.value)} />
      </Field>

      <label className="flex items-center gap-2 text-sm font-medium">
        <input
          type="checkbox"
          checked={form.trackStock}
          onChange={(e) => set("trackStock", e.target.checked)}
        />
        Track stock for this product
      </label>
      {mode === "edit" ? (
        <label className="flex items-center gap-2 text-sm font-medium">
          <input
            type="checkbox"
            checked={form.active}
            onChange={(e) => set("active", e.target.checked)}
          />
          Active — untick to retire this product without deleting history
        </label>
      ) : null}

      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <div className="flex items-center justify-end gap-2 border-t border-border pt-3">
        <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={busy || !form.name.trim()}>
          {busy ? "Saving…" : mode === "create" ? "Create product" : "Save changes"}
        </Button>
      </div>
    </form>
  );
}
