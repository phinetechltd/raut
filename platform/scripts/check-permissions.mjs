/**
 * Proves the UI never offers what the server would refuse.
 *
 * Route guards are the easy half. The half that actually bites is a page that
 * renders a control the API rejects on click — the user sees a broken product,
 * not a permission boundary. So this signs in as each seeded role and asserts
 * both directions:
 *
 *   - things the role MUST be able to reach are reachable
 *   - things the role MUST NOT reach are absent, gated, or redirected
 *
 *   node scripts/check-permissions.mjs [baseUrl]
 */

const BASE = process.argv[2] ?? "http://localhost:3200";
const PASSWORD = "Raut@2026";

let passed = 0;
let failed = 0;
const failures = [];

function check(name, ok, detail = "") {
  if (ok) {
    passed++;
    console.log(`    ✓ ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`    ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function signIn(email) {
  const res = await fetch(`${BASE}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  if (res.status !== 200) return null;
  const jar = res.headers.getSetCookie?.() ?? [];
  const cookie = jar.find((c) => c.startsWith("raut_session="))?.split(";")[0] ?? null;
  const body = await res.json();
  return { cookie, token: body?.data?.accessToken, data: body?.data };
}

async function page(cookie, path) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { Cookie: cookie },
    redirect: "manual",
  });
  const html = res.status === 200 ? await res.text() : "";
  return { status: res.status, html, location: res.headers.get("location") };
}

async function api(token, path, method = "GET") {
  const res = await fetch(`${BASE}/api/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.status;
}

/** Copy unique to the unlicensed-module screen. */
const GATE = "One-time module licence";

const ROLES = [
  {
    label: "Super Admin",
    email: "admin@tariafrica.com",
    reach: ["/admin", "/admin/companies", "/admin/modules", "/admin/audit"],
    // Platform principals have no company, so tenant screens must not resolve.
    redirect: ["/app"],
    apiAllow: ["/platform/companies", "/platform/overview"],
    apiDeny: [],
  },
  {
    label: "Company Admin",
    email: "admin@zamarsolutions.co.ke",
    reach: [
      "/app",
      "/app/customers",
      "/app/sales",
      "/app/finance",
      "/app/settings",
      "/app/settings/payments",
    ],
    redirect: ["/admin"],
    apiAllow: ["/customers", "/invoices", "/expenses", "/users", "/settings/credentials"],
    apiDeny: ["/platform/companies", "/platform/overview"],
  },
  {
    label: "Accountant",
    email: "accounts@zamarsolutions.co.ke",
    reach: ["/app", "/app/sales", "/app/finance"],
    redirect: ["/admin"],
    apiAllow: ["/invoices", "/payments", "/expenses"],
    // No stock-write rights and no platform reach.
    apiDeny: ["/platform/companies"],
  },
  {
    label: "Storekeeper",
    email: "stores@zamarsolutions.co.ke",
    reach: ["/app", "/app/inventory"],
    redirect: ["/admin"],
    apiAllow: ["/stock", "/products", "/suppliers"],
    apiDeny: ["/platform/companies"],
  },
  {
    label: "Field Rep",
    email: "rep@zamarsolutions.co.ke",
    reach: ["/app", "/app/customers", "/app/field"],
    redirect: ["/admin"],
    apiAllow: ["/visits", "/routes", "/customers"],
    hidden: ["/app/settings/payments"],
    apiDeny: ["/settings/credentials", "/platform/companies", "/users"],
  },
  {
    label: "Core-only Admin (no modules)",
    email: "admin@acacia.example",
    reach: ["/app", "/app/settings"],
    redirect: ["/admin"],
    // Every module page must show the gate, not the feature.
    gated: ["/app/customers", "/app/sales", "/app/inventory", "/app/field", "/app/finance"],
    apiAllow: ["/customers"],
    apiDeny: ["/invoices", "/visits", "/stock", "/expenses"],
  },
];

async function main() {
  console.log(`\nPermission boundaries → ${BASE}\n${"=".repeat(56)}`);

  for (const role of ROLES) {
    console.log(`\n${role.label}`);
    const session = await signIn(role.email);
    if (!session?.cookie) {
      check("signs in", false);
      continue;
    }
    check("signs in", true);

    for (const path of role.reach ?? []) {
      const r = await page(session.cookie, path);
      check(
        `can reach ${path}`,
        r.status === 200 && !r.html.includes(GATE),
        r.status !== 200 ? `HTTP ${r.status}` : "",
      );
    }

    for (const path of role.gated ?? []) {
      const r = await page(session.cookie, path);
      check(
        `${path} shows the module gate`,
        r.status === 200 && r.html.includes(GATE),
        r.status !== 200 ? `HTTP ${r.status}` : "",
      );
    }

    // Pages this role must not find at all. 404 rather than 403 keeps the
    // page's existence need-to-know, so this asserts the stronger answer.
    for (const path of role.hidden ?? []) {
      const r = await page(session.cookie, path);
      check(
        `${path} is hidden`,
        r.status === 404,
        `HTTP ${r.status}`,
      );
    }

    for (const path of role.redirect ?? []) {
      const r = await page(session.cookie, path);
      check(
        `${path} is not reachable`,
        r.status >= 300 && r.status < 400,
        `HTTP ${r.status}${r.location ? ` → ${r.location}` : ""}`,
      );
    }

    for (const path of role.apiAllow ?? []) {
      const s = await api(session.token, path);
      check(`API ${path} allowed`, s === 200, `HTTP ${s}`);
    }

    for (const path of role.apiDeny ?? []) {
      const s = await api(session.token, path);
      // 402 = module not licensed, 403 = role forbidden. Both are correct
      // refusals; a 200 here would mean the boundary leaks.
      check(`API ${path} refused`, s === 402 || s === 403 || s === 404, `HTTP ${s}`);
    }
  }

  console.log(`\n${"=".repeat(56)}`);
  console.log(`  ${passed} passed, ${failed} failed`);
  if (failed) console.log(`\n  Failures:\n${failures.map((f) => `   - ${f}`).join("\n")}`);
  console.log(`${"=".repeat(56)}\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("Permission check crashed:", e);
  process.exit(1);
});
