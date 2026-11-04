"use client";

import { useEffect } from "react";

/**
 * The one control on a print page.
 *
 * `window.print()` is the whole PDF strategy: every browser the console runs
 * in can save the print dialog's output as a PDF, and a server-side renderer
 * would be a second layout for the same document that drifts from the first.
 * `?autoprint=1` opens the dialog on load for the "Delivery note" button that
 * creates and prints in one click.
 */
export function PrintButton({ auto = false, label = "Print" }: { auto?: boolean; label?: string }) {
  useEffect(() => {
    if (!auto) return;
    // After paint, so the dialog previews the finished document, not a blank
    // page that is still hydrating.
    const t = window.setTimeout(() => window.print(), 250);
    return () => window.clearTimeout(t);
  }, [auto]);

  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="inline-flex h-9 items-center gap-2 rounded bg-accent px-4 text-sm font-medium text-white transition-colors hover:bg-accent-hover print:hidden"
      data-print-hidden
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M6 9V3h12v6M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
        <path d="M6 14h12v7H6z" />
      </svg>
      {label}
    </button>
  );
}
