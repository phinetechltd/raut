/**
 * Renders every console page as each role and asserts on its actual content.
 *
 * A 200 is not proof a page rendered, so each page declares a string that only
 * appears when its real content is present. The module-gate check looks for
 * copy unique to the locked-module screen — the sidebar's locked nav items
 * carry a similar tooltip, which would otherwise produce a false positive.
 *
 *   node scripts/check-pages.mjs [baseUrl]
 */

const BASE = process.argv[2] ?? "http://localhost:3200";
const PASSWORD = "Raut@2026";

/** Copy that appears only on the ModuleLocked screen. */
const GATE_MARKER = "One-time module licence";

const ROLES = [
  {
    label: "Super Admin",
    email: "admin@tariafrica.com",
    pages: [
      ["/admin", "Platform Overview"],
      ["/admin/companies", "Onboard a new company"],
      ["/admin/modules", "Module Catalogue"],
      ["/admin/audit", "Audit Log"],
    ],
  },
  {
    label: "Company Admin (all modules)",
    email: "admin@tarisolutions.co.ke",
    pages: [
      ["/app", "Receivables"],
      ["/app/customers", "Customer locations"],
      ["/app/sales", "Sales channel"],
      ["/app/inventory", "Recent stock movements"],
      ["/app/inventory/transfers", "Stock transfers"],
      ["/app/procurement", "Goods received"],
      ["/app/finance", "Receivables ageing"],
      ["/app/finance/reports", "Profit and loss"],
      ["/app/finance/etims", "eTIMS transmissions"],
      ["/app/settings/etims", "eTIMS transmission"],
      ["/app/field", "Today in the field"],
      ["/app/routes", "Routing &amp; Geofencing"],
      ["/app/sms", "Message log"],
      ["/app/reports", "Product mix"],
      ["/app/settings", "Stock locations"],
      ["/app/settings/payments", "Payments &amp; Tax"],
      ["/app/settings/maps", "Map provider"],
      ["/app/settings/vehicles", "Vehicle fleet"],
      ["/app/sales/delivery-notes", "Delivery notes"],
    ],
    // Print pages need real ids, resolved through the API after sign-in. Each
    // declares the text only its own document carries, so a page that renders
    // the wrong document, or the console chrome, fails.
    resolve: async (api) => {
      const invoices = (await api("/invoices?limit=200")) ?? [];
      const invoice = invoices[0];
      const filed = invoices.find((i) => i.etimsStatus === "ACCEPTED" && i.etimsQrUrl);
      const creditNote = (await api("/credit-notes"))?.rows?.[0];
      const payment = ((await api("/payments?limit=1")) ?? [])[0];
      const order = ((await api("/orders?limit=1")) ?? [])[0];
      const po = ((await api("/purchase-orders?limit=1")) ?? [])[0];
      const grn = ((await api("/goods-receipts?limit=1")) ?? [])[0];
      const route = ((await api("/routes")) ?? [])[0];
      const deliveryNote = ((await api("/delivery-notes?limit=1")) ?? [])[0];
      const customer = ((await api("/customers?limit=1")) ?? [])[0];
      return [
        invoice && [`/print/invoice/${invoice.id}`, "Powered by Raut", { print: true, also: ["INVOICE"] }],
        invoice && [`/print/invoice/${invoice.id}?copy=1`, "Duplicate", { print: true }],
        invoice && [`/print/invoice/${invoice.id}?format=thermal`, "size: 80mm", { print: true }],
        filed
          ? [`/print/invoice/${filed.id}`, "TAX INVOICE", { print: true, also: ["<svg", "Control code"] }]
          : ["/print/invoice/<filed>", "no ACCEPTED invoice in the data", { skip: true }],
        creditNote && [`/print/credit-note/${creditNote.id}`, creditNote.number, { print: true }],
        payment && [`/print/receipt/${payment.id}`, "PAYMENT RECEIPT", { print: true }],
        order && [`/print/order/${order.id}`, "PROFORMA INVOICE", { print: true }],
        po
          ? [`/print/purchase-order/${po.id}`, "PURCHASE ORDER", { print: true }]
          : ["/print/purchase-order/does-not-exist", "", { status: 404 }],
        grn
          ? [`/print/grn/${grn.id}`, "GOODS RECEIVED NOTE", { print: true }]
          : ["/print/grn/does-not-exist", "", { status: 404 }],
        deliveryNote
          ? [`/print/delivery-note/${deliveryNote.id}`, "DELIVERY NOTE", { print: true }]
          : ["/print/delivery-note/does-not-exist", "", { status: 404 }],
        customer && [`/print/statement/${customer.id}`, "STATEMENT OF ACCOUNT", { print: true, also: ["Closing balance"] }],
        route && [`/print/route-sheet/${route.id}`, "ROUTE SHEET", { print: true }],
        ["/print/invoice/does-not-exist", "", { status: 404 }],
        ["/print/payslip/anything", "", { status: 404 }],
      ].filter(Boolean);
    },
  },
  {
    label: "Field Rep",
    email: "rep@tarisolutions.co.ke",
    pages: [
      ["/app", "Sales trend"],
      ["/app/customers", "All customers"],
      ["/app/field", "Today's visits"],
      ["/app/routes", "Territories"],
      ["/app/sales/delivery-notes", "Delivery notes"],
    ],
    // A rep prints their own route sheet and the receipts they wrote; the
    // self-scope is what the API already applies, so the ids come from it.
    resolve: async (api) => {
      const route = ((await api("/routes")) ?? [])[0];
      const payment = ((await api("/payments?limit=1")) ?? [])[0];
      return [
        route
          ? [`/print/route-sheet/${route.id}`, "ROUTE SHEET", { print: true }]
          : ["/print/route-sheet/<own>", "the rep has no route to print", { skip: true }],
        payment
          ? [`/print/receipt/${payment.id}`, "PAYMENT RECEIPT", { print: true }]
          : ["/print/receipt/<own>", "the rep has no payment to print", { skip: true }],
        // A document the rep may not open is not found, not forbidden.
        ["/print/purchase-order/does-not-exist", "", { status: 404 }],
      ];
    },
  },
  {
    label: "Core-only Admin (module gate)",
    email: "admin@acacia.example",
    pages: [
      ["/app", "Sales trend"],
      ["/app/customers", GATE_MARKER, { gated: true }],
      ["/app/sales", GATE_MARKER, { gated: true }],
      ["/app/sales/delivery-notes", GATE_MARKER, { gated: true }],
      ["/app/field", GATE_MARKER, { gated: true }],
      ["/app/settings", "Stock locations"],
    ],
    // Without Sales & POS the print routes for its documents do not resolve,
    // and another tenant's id is not found either way.
    resolve: async (api, { tenantIds }) => [
      [`/print/invoice/${tenantIds.invoiceId ?? "does-not-exist"}`, "", { status: 404 }],
      [`/print/delivery-note/${tenantIds.deliveryNoteId ?? "does-not-exist"}`, "", { status: 404 }],
    ],
  },
];

let passed = 0;
let failed = 0;

async function signIn(email) {
  const res = await fetch(`${BASE}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const setCookie = res.headers.getSetCookie?.() ?? [];
  const session = setCookie.find((c) => c.startsWith("raut_session="));
  if (!session) throw new Error(`No session cookie returned for ${email}`);
  return session.split(";")[0];
}

/** Calls /api/v1 with the session cookie and returns the envelope's `data`. */
function apiFor(cookie) {
  return async (path) => {
    const res = await fetch(`${BASE}/api/v1${path}`, { headers: { Cookie: cookie } });
    const json = await res.json().catch(() => null);
    return json?.ok ? json.data : null;
  };
}

async function main() {
  console.log(`\nConsole page render check → ${BASE}\n`);

  // Ids from the main tenant, so the module-gated tenant can be shown not to
  // resolve them.
  const tenantIds = {};

  for (const role of ROLES) {
    console.log(role.label);
    const cookie = await signIn(role.email);
    const api = apiFor(cookie);

    if (role.label.startsWith("Company Admin")) {
      tenantIds.invoiceId = ((await api("/invoices?limit=1")) ?? [])[0]?.id;
      tenantIds.deliveryNoteId = ((await api("/delivery-notes?limit=1")) ?? [])[0]?.id;
    }

    const pages = [...role.pages, ...(role.resolve ? await role.resolve(api, { tenantIds }) : [])];

    for (const [page, marker, opts] of pages) {
      if (opts?.skip) {
        console.log(`  - ${page} — skipped: ${marker}`);
        continue;
      }
      const res = await fetch(`${BASE}${page}`, {
        headers: { Cookie: cookie },
        redirect: "manual",
      });
      const html = await res.text();

      // A print route the role may not read, or an id that is not theirs, is
      // a 404 and nothing else: no body to inspect.
      if (opts?.status && opts.status !== 200) {
        const ok = res.status === opts.status;
        if (ok) {
          passed++;
          console.log(`  ✓ ${page} — ${res.status}`);
        } else {
          failed++;
          console.log(`  ✗ ${page} — ${res.status}, expected ${opts.status}`);
        }
        continue;
      }

      // Next's dev client bundle embeds its error-boundary copy on every page,
      // so scanning the HTML for those phrases produces false positives. A
      // thrown server component yields a non-200 in dev, and the page-specific
      // marker only appears once that page's own data fetch succeeded — those
      // two together are the reliable signal.
      const status200 = res.status === 200;
      const hasMarker = html.includes(marker);

      // A page that should NOT be gated must not show the gate screen.
      const gateShown = html.includes(GATE_MARKER);
      const gateCorrect = opts?.gated ? gateShown : !gateShown;

      // A print page must carry its own markers and none of the console
      // chrome: the sidebar's nav landmark is the tell.
      const alsoMissing = (opts?.also ?? []).filter((m) => !html.includes(m));
      const chromeLeaked = opts?.print ? html.includes('aria-label="Sections"') : false;

      const verdict = status200 && hasMarker && gateCorrect && alsoMissing.length === 0 && !chromeLeaked;

      const notes = [`${res.status}`, `${(html.length / 1024).toFixed(0)}kb`];
      if (!hasMarker) notes.push(`missing "${marker}"`);
      if (alsoMissing.length) notes.push(`missing ${alsoMissing.map((m) => `"${m}"`).join(", ")}`);
      if (chromeLeaked) notes.push("console chrome on a print page");
      if (!gateCorrect) notes.push(opts?.gated ? "gate missing" : "unexpectedly gated");
      if (opts?.gated && gateShown) notes.push("module gate shown");

      if (verdict) {
        passed++;
        console.log(`  ✓ ${page} — ${notes.join(", ")}`);
      } else {
        failed++;
        console.log(`  ✗ ${page} — ${notes.join(", ")}`);
      }
    }
    console.log("");
  }

  console.log("─".repeat(56));
  console.log(`  ${passed} pages rendered, ${failed} failed`);
  console.log("─".repeat(56) + "\n");

  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("Page check crashed:", error);
  process.exit(1);
});
