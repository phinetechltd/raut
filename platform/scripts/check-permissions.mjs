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

/**
 * Pushes one operation through the offline sync endpoint and returns its result.
 *
 * The payload names ids that do not exist, so an operation the role is allowed
 * to perform gets past the permission gate and then fails on its data: nothing
 * is written either way. A refusal carries `code`; anything else means the gate
 * let it through.
 */
async function pushProbe(token, type) {
  const res = await fetch(`${BASE}/api/v1/sync/push`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      deviceId: "permission-probe",
      operations: [
        {
          uuid: `probe-${type}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          type,
          payload: { customerId: "permission-probe", visitId: "permission-probe", id: "permission-probe" },
        },
      ],
    }),
  });
  const body = await res.json().catch(() => null);
  return body?.data?.results?.[0] ?? { status: `HTTP ${res.status}` };
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
    email: "admin@tarisolutions.co.ke",
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
    syncAllow: ["invoice.create", "payment.create", "order.create", "customer.update", "expense.create"],
  },
  {
    label: "Accountant",
    email: "accounts@tarisolutions.co.ke",
    reach: ["/app", "/app/sales", "/app/finance"],
    redirect: ["/admin"],
    apiAllow: [
      "/invoices",
      "/payments",
      "/expenses",
      "/reports/profit-and-loss",
      "/reports/balance-sheet",
      "/reports/cash-flow",
      "/reports/vat-summary",
      "/reports/stock-valuation",
      "/reports/trial-balance",
      "/etims/config",
      "/etims/submissions",
    ],
    // No stock-write rights and no platform reach.
    apiDeny: ["/platform/companies"],
    syncAllow: ["invoice.create", "payment.create"],
    syncDeny: ["customer.update", "order.create", "visit.create"],
  },
  {
    label: "Storekeeper",
    email: "stores@tarisolutions.co.ke",
    reach: ["/app", "/app/inventory"],
    redirect: ["/admin"],
    apiAllow: ["/stock", "/products", "/suppliers"],
    apiDeny: ["/platform/companies", "/reports/balance-sheet", "/reports/stock-valuation"],
    // The escalation the sync endpoint used to allow: a storekeeper raising
    // invoices, recording payments against balances and moving shop pins.
    syncDeny: [
      "invoice.create",
      "payment.create",
      "customer.create",
      "customer.update",
      "order.create",
      "expense.create",
      "visit.create",
    ],
  },
  {
    label: "Field Rep",
    email: "rep@tarisolutions.co.ke",
    reach: ["/app", "/app/customers", "/app/field"],
    redirect: ["/admin"],
    // A rep raises returns where the goods are handed back, which is the whole
    // point of the flow. Withholding this left it unreachable by the only
    // people who need it.
    apiAllow: ["/visits", "/routes", "/customers", "/credit-notes"],
    hidden: ["/app/settings/payments", "/app/finance/reports", "/app/settings/etims"],
    // A rep holds report:read for their own numbers. The statutory statements
    // carry company margin, cash position and tax owed, and are not theirs.
    apiDeny: [
      "/settings/credentials",
      "/platform/companies",
      "/users",
      "/reports/profit-and-loss",
      "/reports/balance-sheet",
      "/reports/cash-flow",
      "/reports/vat-summary",
      "/reports/stock-valuation",
      "/reports/trial-balance",
    ],
    // Everything the field app actually sends is allowed. invoice.create is
    // not: field reps hold no invoice:write, and the app never queues it.
    syncAllow: [
      "visit.create",
      "visit.checkin",
      "visit.checkout",
      "order.create",
      "payment.create",
      "customer.create",
      "customer.update",
      "activity.create",
      "expense.create",
      "location.batch",
    ],
    syncDeny: ["invoice.create"],
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
    // The paywall must hold on the sync path too, and say it is the licence.
    syncUnlicensed: ["invoice.create", "payment.create", "order.create"],
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

    for (const type of role.syncAllow ?? []) {
      const r = await pushProbe(session.token, type);
      check(`sync ${type} passes the gate`, r.status === "failed" && !r.code, r.code ?? r.status);
    }

    for (const type of role.syncDeny ?? []) {
      const r = await pushProbe(session.token, type);
      check(`sync ${type} refused`, r.code === "FORBIDDEN", r.code ?? `${r.status}: ${r.error ?? ""}`);
    }

    for (const type of role.syncUnlicensed ?? []) {
      const r = await pushProbe(session.token, type);
      check(`sync ${type} refused as unlicensed`, r.code === "MODULE_NOT_LICENSED", r.code ?? r.status);
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
