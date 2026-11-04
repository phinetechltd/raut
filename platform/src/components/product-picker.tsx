"use client";

import { useEffect, useId, useRef, useState } from "react";

import { apiClient, Input, cx } from "@/components/ui";

/** The slice of /api/v1/products a stock form needs. */
export interface PickedProduct {
  id: string;
  name: string;
  sku: string;
  unit: string;
  unitsPerPack: number;
  costPriceCents: number;
  trackStock: boolean;
  stockOnHand: number;
  stockItems: Array<{ quantity: number; locationId: string }>;
}

/**
 * Searches the whole catalogue through the API rather than a list the page
 * happened to render — a product can be any one of thousands, and the page
 * shows fifteen. Debounced; the latest response wins.
 */
export function ProductPicker({
  id,
  value,
  onChange,
  placeholder = "Search name, SKU, barcode…",
  exclude,
  disabled,
}: {
  id?: string;
  value: PickedProduct | null;
  onChange: (product: PickedProduct | null) => void;
  placeholder?: string;
  /** Product ids to leave out of the results (e.g. the other side of a split). */
  exclude?: string[];
  disabled?: boolean;
}) {
  const fallbackId = useId();
  const inputId = id ?? fallbackId;
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<PickedProduct[]>([]);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const mine = ++seq.current;
    setBusy(true);
    const t = setTimeout(async () => {
      const res = await apiClient<PickedProduct[]>(
        `/api/v1/products?limit=20&q=${encodeURIComponent(query.trim())}`,
      );
      if (mine !== seq.current) return;
      const rows = (res.data ?? []).filter((p) => !exclude?.includes(p.id));
      setResults(rows);
      setBusy(false);
    }, 180);
    return () => clearTimeout(t);
    // `exclude` is a fresh array each render; its contents are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, open, exclude?.join("|")]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  if (value) {
    return (
      <div className="flex h-10 items-center justify-between gap-2 rounded-md border border-border bg-surface-sunken px-3 text-sm">
        <span className="min-w-0 truncate">
          <span className="font-medium">{value.name}</span>{" "}
          <span className="text-content-muted text-xs tabular">{value.sku}</span>
        </span>
        <button
          type="button"
          onClick={() => {
            onChange(null);
            setQuery("");
            setOpen(true);
          }}
          disabled={disabled}
          className="shrink-0 text-xs font-medium text-accent hover:underline disabled:opacity-50"
        >
          Change
        </button>
      </div>
    );
  }

  return (
    <div ref={box} className="relative">
      <Input
        id={inputId}
        value={query}
        placeholder={placeholder}
        autoComplete="off"
        disabled={disabled}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") setOpen(false);
          if (e.key === "Enter" && results[0]) {
            e.preventDefault();
            onChange(results[0]);
            setOpen(false);
          }
        }}
        role="combobox"
        aria-expanded={open}
        aria-controls={`${inputId}-list`}
      />
      {open ? (
        <ul
          id={`${inputId}-list`}
          role="listbox"
          className="absolute z-20 mt-1 max-h-60 w-full overflow-y-auto rounded-md border border-border bg-surface py-1 shadow-lg"
        >
          {busy && results.length === 0 ? (
            <li className="px-3 py-2 text-sm text-content-muted">Searching…</li>
          ) : results.length === 0 ? (
            <li className="px-3 py-2 text-sm text-content-muted">No products match</li>
          ) : (
            results.map((p) => (
              <li key={p.id} role="option" aria-selected={false}>
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    onChange(p);
                    setOpen(false);
                  }}
                  className={cx(
                    "flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-surface-hover",
                    !p.trackStock && "opacity-60",
                  )}
                >
                  <span className="min-w-0 truncate">
                    <span className="font-medium">{p.name}</span>{" "}
                    <span className="text-content-muted text-xs tabular">{p.sku}</span>
                  </span>
                  <span className="shrink-0 text-xs text-content-muted tabular">
                    {p.trackStock ? `${p.stockOnHand} ${p.unit}` : "not tracked"}
                  </span>
                </button>
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}

/** On-hand quantity of a picked product at one location. */
export function onHandAt(product: PickedProduct | null, locationId: string): number {
  if (!product) return 0;
  return product.stockItems.find((s) => s.locationId === locationId)?.quantity ?? 0;
}

export function kes(cents: number): string {
  return `KES ${(cents / 100).toLocaleString("en-KE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
