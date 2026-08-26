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
    email: "admin@zamarsolutions.co.ke",
    pages: [
      ["/app", "Receivables"],
      ["/app/customers", "Customer locations"],
      ["/app/sales", "Sales channel"],
      ["/app/inventory", "Recent stock movements"],
      ["/app/procurement", "Goods received"],
      ["/app/finance", "Receivables ageing"],
      ["/app/finance/reports", "Profit and loss"],
      ["/app/field", "Today in the field"],
      ["/app/routes", "Routing &amp; Geofencing"],
      ["/app/sms", "Message log"],
      ["/app/reports", "Product mix"],
      ["/app/settings", "Stock locations"],
      ["/app/settings/payments", "Payments &amp; Tax"],
    ],
  },
  {
    label: "Field Rep",
    email: "rep@zamarsolutions.co.ke",
    pages: [
      ["/app", "Sales trend"],
      ["/app/customers", "All customers"],
      ["/app/field", "Today's visits"],
      ["/app/routes", "Territories"],
    ],
  },
  {
    label: "Core-only Admin (module gate)",
    email: "admin@acacia.example",
    pages: [
      ["/app", "Sales trend"],
      ["/app/customers", GATE_MARKER, { gated: true }],
      ["/app/sales", GATE_MARKER, { gated: true }],
      ["/app/field", GATE_MARKER, { gated: true }],
      ["/app/settings", "Stock locations"],
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

async function main() {
  console.log(`\nConsole page render check → ${BASE}\n`);

  for (const role of ROLES) {
    console.log(role.label);
    const cookie = await signIn(role.email);

    for (const [page, marker, opts] of role.pages) {
      const res = await fetch(`${BASE}${page}`, {
        headers: { Cookie: cookie },
        redirect: "manual",
      });
      const html = await res.text();

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

      const verdict = status200 && hasMarker && gateCorrect;

      const notes = [`${res.status}`, `${(html.length / 1024).toFixed(0)}kb`];
      if (!hasMarker) notes.push(`missing "${marker}"`);
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
