import type { ReactNode } from "react";

import { PrintButton } from "./print-button";

/**
 * The printable document.
 *
 * One layout for every paper the business hands out — invoice, credit note,
 * receipt, delivery note, proforma, purchase order, GRN, statement, route
 * sheet. Builders in src/server/print.ts reduce each record to a `PrintDoc`;
 * this component only arranges it. That is what keeps a return printing the
 * same way as the sale it reverses, and a statement the same way as the
 * invoices it lists.
 *
 * Plain `<table>` rather than DataTable, on purpose: `thead` repeats on every
 * printed page, rows are kept whole across page breaks, nothing paginates,
 * and nothing is a link. It renders light whatever the console's theme is,
 * because paper is white.
 *
 * Wording follows the field app's receipt (mobile/raut_field/lib/core/
 * receipt.dart): a document is a TAX INVOICE only once KRA has accepted it;
 * anything else says NOT A TAX INVOICE on its face, and a reprint is stamped
 * DUPLICATE so two papers for one sale cannot pass as two sales.
 */

export interface PrintCompany {
  name: string;
  taxPin?: string | null;
  address?: string | null;
  phone?: string | null;
  email?: string | null;
  logoUrl?: string | null;
}

export interface PrintBranch {
  name: string;
  address?: string | null;
  phone?: string | null;
}

export interface PrintParty {
  label: string;
  name: string;
  lines?: Array<string | null | undefined>;
}

export interface PrintColumn {
  key: string;
  header: string;
  align?: "left" | "right" | "center";
  width?: string;
  /** Tabular figures, for quantities and money. */
  numeric?: boolean;
}

export type PrintCell = string | number | null | undefined;

export interface PrintRow {
  key: string;
  cells: Record<string, PrintCell>;
  /** Quieter row, e.g. an opening balance. */
  muted?: boolean;
  /** Heavier row, e.g. a closing balance. */
  strong?: boolean;
  /** How the row prints on 80 mm paper: a label line, then left/right. */
  thermal?: { label: string; left: string; right: string };
}

export interface PrintTotal {
  label: string;
  value: string;
  strong?: boolean;
  muted?: boolean;
}

export interface PrintEtims {
  kind: "invoice" | "credit-note";
  /** NOT_APPLICABLE | QUEUED | SUBMITTED | ACCEPTED | REJECTED */
  status: string;
  controlCode?: string | null;
  invoiceNumber?: string | null;
  serialNumber?: string | null;
  /** Inline SVG markup rendered server-side with `qrcode`. */
  qrSvg?: string | null;
  qrUrl?: string | null;
}

export interface PrintSignature {
  label: string;
  /** A typed name under the line. */
  value?: string | null;
  /** Secondary line, e.g. a phone number or a date. */
  detail?: string | null;
  /** A drawn signature as a data: URL. */
  image?: string | null;
}

export interface PrintSection {
  title: string;
  description?: string | null;
  columns: PrintColumn[];
  rows: PrintRow[];
  totals?: PrintTotal[];
  empty?: string;
}

export interface PrintDoc {
  /** TAX INVOICE, DELIVERY NOTE … already upper-cased by the builder. */
  title: string;
  subtitle?: string | null;
  number: string;
  /** Lifecycle status, printed under the number. */
  status?: string | null;
  meta: Array<{ label: string; value: string }>;
  company: PrintCompany;
  branch?: PrintBranch | null;
  parties: PrintParty[];
  columns: PrintColumn[];
  rows: PrintRow[];
  totals?: PrintTotal[];
  etims?: PrintEtims | null;
  signatures?: PrintSignature[];
  notes?: string | null;
  /** Small print under the totals: a proforma disclaimer, a GRN caption. */
  footnote?: string | null;
  sections?: PrintSection[];
  copy: boolean;
  /** 80 mm receipt layout instead of A4. */
  thermal?: boolean;
  /** `?autoprint=1` */
  autoprint?: boolean;
}

export const ETIMS_LABEL: Record<string, string> = {
  ACCEPTED: "Filed with KRA",
  QUEUED: "Awaiting KRA",
  SUBMITTED: "Awaiting KRA",
  REJECTED: "Rejected by KRA",
  NOT_APPLICABLE: "Not filed",
};

export function humanStatus(status: string | null | undefined): string {
  if (!status) return "";
  return status.replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
}

const align = (a?: PrintColumn["align"]) =>
  a === "right" ? "text-right" : a === "center" ? "text-center" : "text-left";

// ── A4 ─────────────────────────────────────────────────────────────────

export function PrintDocument({ doc }: { doc: PrintDoc }) {
  if (doc.thermal) return <ThermalDocument doc={doc} />;

  return (
    <div className="print-doc mx-auto w-full max-w-[210mm] px-6 py-6 print:max-w-none print:p-0">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3" data-print-hidden>
        <p className="text-sm text-content-muted">
          Use your browser&apos;s print dialog to print or save this document as a PDF.
        </p>
        <PrintButton auto={doc.autoprint} />
      </div>

      <article className="print-paper rounded-xl border border-border bg-white p-8 text-[13px] leading-snug text-content shadow-sm print:rounded-none print:border-0 print:p-0 print:shadow-none">
        <Header doc={doc} />

        {doc.parties.length > 0 && (
          <div className="mt-6 grid gap-6 sm:grid-cols-2 print:grid-cols-2">
            {doc.parties.map((p) => (
              <div key={p.label} className="print-avoid-break">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-content-muted">{p.label}</p>
                <p className="mt-0.5 font-semibold">{p.name}</p>
                {(p.lines ?? []).filter(Boolean).map((l, i) => (
                  <p key={i} className="text-content-secondary">
                    {l}
                  </p>
                ))}
              </div>
            ))}
          </div>
        )}

        <div className="mt-6">
          <LinesTable columns={doc.columns} rows={doc.rows} />
        </div>

        {doc.totals && doc.totals.length > 0 && (
          <div className="mt-4 flex justify-end">
            <Totals totals={doc.totals} />
          </div>
        )}

        {doc.footnote && <p className="mt-4 text-xs text-content-muted">{doc.footnote}</p>}

        {doc.sections?.map((s) => (
          <section key={s.title} className="mt-8">
            <h2 className="text-sm font-semibold uppercase tracking-wide">{s.title}</h2>
            {s.description && <p className="mt-0.5 text-xs text-content-muted">{s.description}</p>}
            <div className="mt-2">
              <LinesTable columns={s.columns} rows={s.rows} empty={s.empty} />
            </div>
            {s.totals && s.totals.length > 0 && (
              <div className="mt-3 flex justify-end">
                <Totals totals={s.totals} />
              </div>
            )}
          </section>
        ))}

        {doc.etims && <EtimsBlock etims={doc.etims} />}

        {doc.notes && (
          <div className="mt-6 print-avoid-break">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-content-muted">Notes</p>
            <p className="mt-0.5 whitespace-pre-line text-content-secondary">{doc.notes}</p>
          </div>
        )}

        {doc.signatures && doc.signatures.length > 0 && (
          <div
            className="mt-10 grid gap-8 print-avoid-break"
            style={{ gridTemplateColumns: `repeat(${Math.min(doc.signatures.length, 3)}, minmax(0, 1fr))` }}
          >
            {doc.signatures.map((s) => (
              <div key={s.label}>
                <div className="flex h-14 items-end">
                  {s.image ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={s.image} alt={`${s.label} signature`} className="max-h-14 max-w-full" />
                  ) : s.value ? (
                    <span className="font-medium">{s.value}</span>
                  ) : null}
                </div>
                <div className="border-t border-content pt-1">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-content-muted">{s.label}</p>
                  {s.image && s.value && <p className="text-xs">{s.value}</p>}
                  {s.detail && <p className="text-xs text-content-muted">{s.detail}</p>}
                </div>
              </div>
            ))}
          </div>
        )}

        <Footer />
      </article>
    </div>
  );
}

function Header({ doc }: { doc: PrintDoc }) {
  const c = doc.company;
  return (
    <header className="flex flex-wrap items-start justify-between gap-6 border-b border-border pb-5">
      <div className="flex min-w-0 items-start gap-4">
        {c.logoUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={c.logoUrl} alt="" className="h-14 w-14 shrink-0 rounded object-contain" />
        )}
        <div className="min-w-0">
          <p className="text-lg font-semibold leading-tight">{c.name}</p>
          {c.taxPin && <p className="tabular text-content-secondary">PIN {c.taxPin}</p>}
          {c.address && <p className="text-content-muted">{c.address}</p>}
          {(c.phone || c.email) && (
            <p className="text-content-muted">{[c.phone, c.email].filter(Boolean).join(" · ")}</p>
          )}
          {doc.branch && (
            <p className="mt-1 text-xs text-content-muted">
              <span className="font-medium text-content-secondary">{doc.branch.name}</span>
              {[doc.branch.address, doc.branch.phone].filter(Boolean).map((v) => ` · ${v}`)}
            </p>
          )}
        </div>
      </div>

      <div className="text-right">
        <p className="text-base font-bold uppercase tracking-wide">{doc.title}</p>
        {doc.copy && (
          <p className="mt-0.5 inline-block rounded border-2 border-content px-2 py-0.5 text-xs font-bold uppercase tracking-widest">
            Duplicate
          </p>
        )}
        <p className="tabular mt-1 text-lg font-semibold">{doc.number}</p>
        {doc.subtitle && <p className="text-content-secondary">{doc.subtitle}</p>}
        {doc.status && <p className="text-xs uppercase tracking-wide text-content-muted">{doc.status}</p>}
        {doc.meta.length > 0 && (
          <dl className="mt-2 grid grid-cols-[auto_auto] justify-end gap-x-3 gap-y-0.5 text-xs">
            {doc.meta.map((m) => (
              <div key={m.label} className="contents">
                <dt className="text-content-muted">{m.label}</dt>
                <dd className="tabular text-right">{m.value}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    </header>
  );
}

function LinesTable({
  columns,
  rows,
  empty = "Nothing to list",
}: {
  columns: PrintColumn[];
  rows: PrintRow[];
  empty?: string;
}) {
  return (
    <table className="print-table w-full border-collapse">
      <thead>
        <tr className="border-b-2 border-content">
          {columns.map((c) => (
            <th
              key={c.key}
              scope="col"
              style={c.width ? { width: c.width } : undefined}
              className={`py-1.5 pr-2 text-[10px] font-semibold uppercase tracking-wider text-content-muted ${align(c.align)}`}
            >
              {c.header}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 ? (
          <tr>
            <td colSpan={columns.length} className="py-4 text-center text-content-muted">
              {empty}
            </td>
          </tr>
        ) : (
          rows.map((r) => (
            <tr
              key={r.key}
              className={`border-b border-border align-top ${r.muted ? "text-content-muted" : ""} ${r.strong ? "font-semibold" : ""}`}
            >
              {columns.map((c) => {
                const v = r.cells[c.key];
                return (
                  <td key={c.key} className={`py-1.5 pr-2 ${align(c.align)} ${c.numeric ? "tabular" : ""}`}>
                    {v === null || v === undefined || v === "" ? <span className="text-content-muted">—</span> : v}
                  </td>
                );
              })}
            </tr>
          ))
        )}
      </tbody>
    </table>
  );
}

function Totals({ totals }: { totals: PrintTotal[] }) {
  return (
    <dl className="w-full max-w-xs space-y-0.5 print-avoid-break">
      {totals.map((t) => (
        <div
          key={t.label}
          className={`flex justify-between gap-4 ${t.strong ? "border-t border-content pt-1 font-semibold" : ""} ${t.muted ? "text-content-muted" : ""}`}
        >
          <dt className={t.strong ? "" : "text-content-secondary"}>{t.label}</dt>
          <dd className="tabular">{t.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** The wording that turns a bill into a tax invoice, or says plainly that it is not one. */
function etimsWording(e: PrintEtims): { heading: string; detail: string } {
  const isReturn = e.kind === "credit-note";
  const heading = isReturn ? "NOT A CREDIT NOTE" : "NOT A TAX INVOICE";
  const detail =
    e.status === "REJECTED"
      ? "KRA rejected this. Ask the office."
      : e.status === "NOT_APPLICABLE"
        ? "This document was not filed with KRA."
        : isReturn
          ? "Awaiting KRA. A credit note follows."
          : "Awaiting KRA. A tax invoice follows.";
  return { heading, detail };
}

function EtimsBlock({ etims }: { etims: PrintEtims }) {
  if (etims.status === "ACCEPTED" && etims.controlCode) {
    return (
      <div className="mt-6 flex flex-wrap items-start gap-5 border-t border-border pt-4 print-avoid-break">
        {etims.qrSvg && (
          <div
            className="shrink-0 [&>svg]:h-[108px] [&>svg]:w-[108px]"
            aria-label="KRA verification QR code"
            dangerouslySetInnerHTML={{ __html: etims.qrSvg }}
          />
        )}
        <dl className="text-sm">
          <dt className="text-[10px] uppercase tracking-wider text-content-muted">Control code</dt>
          <dd className="tabular font-semibold">{etims.controlCode}</dd>
          {etims.invoiceNumber && (
            <>
              <dt className="mt-1.5 text-[10px] uppercase tracking-wider text-content-muted">KRA invoice no.</dt>
              <dd className="tabular">{etims.invoiceNumber}</dd>
            </>
          )}
          {etims.serialNumber && (
            <>
              <dt className="mt-1.5 text-[10px] uppercase tracking-wider text-content-muted">Serial</dt>
              <dd className="tabular text-xs">{etims.serialNumber}</dd>
            </>
          )}
          <dd className="mt-2 text-xs text-content-muted">
            Scan to verify with KRA{etims.qrUrl ? `: ${etims.qrUrl}` : "."}
          </dd>
        </dl>
      </div>
    );
  }

  const { heading, detail } = etimsWording(etims);
  return (
    <div className="mt-6 border-t border-border pt-4 text-center print-avoid-break">
      <p className="text-sm font-bold tracking-wide">{heading}</p>
      <p className="text-xs text-content-muted">{detail}</p>
    </div>
  );
}

function Footer() {
  return (
    <footer className="mt-8 border-t border-border pt-3 text-center text-[10px] text-content-muted">
      Powered by Raut
    </footer>
  );
}

// ── 80 mm ──────────────────────────────────────────────────────────────

/**
 * The till-roll layout. Same `PrintDoc`, laid out the way receipt.dart lays
 * out paper: centred header, rules, label/value rows, one item per block.
 */
function ThermalDocument({ doc }: { doc: PrintDoc }) {
  const c = doc.company;
  const Rule = () => <hr className="my-1.5 border-0 border-t border-dashed border-content" />;
  const Row = ({ l, r, strong }: { l: ReactNode; r: ReactNode; strong?: boolean }) => (
    <div className={`flex justify-between gap-2 ${strong ? "font-bold" : ""}`}>
      <span className="min-w-0">{l}</span>
      <span className="tabular shrink-0 text-right">{r}</span>
    </div>
  );

  return (
    <div className="print-doc print-doc--thermal mx-auto w-full px-4 py-6 print:p-0">
      {/* Scoped @page so the browser proposes a till-roll size for this document only. */}
      <style>{`@page { size: 80mm auto; margin: 3mm 4mm; }`}</style>
      <div className="mb-4 flex items-center justify-between gap-3" data-print-hidden>
        <p className="text-xs text-content-muted">80 mm receipt layout.</p>
        <PrintButton auto={doc.autoprint} />
      </div>

      <article className="print-paper mx-auto w-[72mm] bg-white px-2 py-3 font-mono text-[11px] leading-[1.35] text-content print:w-full print:p-0">
        <div className="text-center">
          <p className="text-[13px] font-bold">{c.name}</p>
          {c.taxPin && <p>PIN: {c.taxPin}</p>}
          {c.address && <p>{c.address}</p>}
          {c.phone && <p>{c.phone}</p>}
        </div>
        <Rule />
        <p className="text-center text-[12px] font-bold">{doc.title}</p>
        {doc.copy && <p className="text-center font-bold">DUPLICATE</p>}
        <Rule />
        <Row l="No." r={doc.number} />
        {doc.subtitle && <Row l="Against" r={doc.subtitle.replace(/^Against\s+/i, "")} />}
        {doc.meta.map((m) => (
          <Row key={m.label} l={m.label} r={m.value} />
        ))}
        {doc.parties.map((p) => (
          <div key={p.label}>
            <p className="mt-1">{p.label}</p>
            <p className="font-bold">{p.name}</p>
            {(p.lines ?? []).filter(Boolean).map((l, i) => (
              <p key={i}>{l}</p>
            ))}
          </div>
        ))}
        <Rule />
        {doc.rows.map((r) => (
          <div key={r.key} className="print-avoid-break">
            <p>{r.thermal?.label ?? String(r.cells[doc.columns[0]?.key ?? ""] ?? "")}</p>
            <Row
              l={r.thermal?.left ?? ""}
              r={r.thermal?.right ?? String(r.cells[doc.columns[doc.columns.length - 1]?.key ?? ""] ?? "")}
            />
          </div>
        ))}
        {doc.totals && doc.totals.length > 0 && (
          <>
            <Rule />
            {doc.totals.map((t) => (
              <Row key={t.label} l={t.label} r={t.value} strong={t.strong} />
            ))}
          </>
        )}
        {doc.footnote && (
          <>
            <Rule />
            <p className="text-center text-[10px]">{doc.footnote}</p>
          </>
        )}
        {doc.etims && (
          <>
            <Rule />
            {doc.etims.status === "ACCEPTED" && doc.etims.controlCode ? (
              <div className="text-center">
                <p>CONTROL CODE</p>
                <p className="text-[12px] font-bold">{doc.etims.controlCode}</p>
                {doc.etims.invoiceNumber && <p>KRA Invoice No: {doc.etims.invoiceNumber}</p>}
                {doc.etims.serialNumber && <p className="text-[10px]">{doc.etims.serialNumber}</p>}
                {doc.etims.qrSvg && (
                  <div
                    className="mx-auto mt-2 w-fit [&>svg]:h-[120px] [&>svg]:w-[120px]"
                    aria-label="KRA verification QR code"
                    dangerouslySetInnerHTML={{ __html: doc.etims.qrSvg }}
                  />
                )}
                <p className="mt-1 text-[10px]">Scan to verify with KRA</p>
              </div>
            ) : (
              <div className="text-center">
                <p className="text-[12px] font-bold">{etimsWording(doc.etims).heading}</p>
                <p className="text-[10px]">{etimsWording(doc.etims).detail}</p>
              </div>
            )}
          </>
        )}
        {doc.notes && (
          <>
            <Rule />
            <p className="whitespace-pre-line text-[10px]">{doc.notes}</p>
          </>
        )}
        <p className="mt-4 text-center text-[10px]">Powered by Raut</p>
      </article>
    </div>
  );
}
