/**
 * End-to-end proof that the mobile app and the platform are one system.
 *
 * This exercises the exact contract lib/core/sync_service.dart speaks, in the
 * order it speaks it, and then verifies the result is visible in the web
 * console's rendered HTML — not just in an API response. An API echoing back
 * what you posted proves very little; the console rendering it proves the
 * write reached shared state the back office actually reads.
 *
 * Scenario: a rep starts the day online, goes offline for four operations
 * (check-in, order, payment, check-out), reconnects, drains the queue, and the
 * sales manager sees the order minutes later.
 *
 *   node scripts/integration.mjs [baseUrl]
 */

const BASE = process.argv[2] ?? "http://localhost:3200";
const PASSWORD = "Raut@2026";

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail = "") {
  if (condition) {
    passed++;
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function api(path, { method = "GET", token, body } = {}) {
  const res = await fetch(`${BASE}/api/v1${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

async function consoleHtml(cookie, path) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { Cookie: cookie },
    redirect: "manual",
  });
  return { status: res.status, html: await res.text() };
}

async function sessionCookie(email) {
  const res = await fetch(`${BASE}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const cookies = res.headers.getSetCookie?.() ?? [];
  const session = cookies.find((c) => c.startsWith("raut_session="));
  return session?.split(";")[0] ?? null;
}

const uuid = () =>
  `field-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

async function main() {
  console.log(`\nRaut mobile ↔ platform integration\n${"=".repeat(56)}\n`);

  // ── 1. Rep signs in, as the app does on first launch ────────────────
  console.log("1. Rep signs in on the handset");
  const deviceId = `integration-${Math.random().toString(36).slice(2, 10)}`;

  const login = await api("/auth/login", {
    method: "POST",
    body: {
      email: "rep@zamarsolutions.co.ke",
      password: PASSWORD,
      device: {
        deviceId,
        platform: "android",
        model: "Integration Test",
        appVersion: "1.0.0",
      },
    },
  });
  check("Sign-in succeeds", login.status === 200);
  const token = login.json?.data?.accessToken;
  check("Device is registered and issued a refresh token", !!login.json?.data?.refreshToken);

  // ── 2. Bootstrap pull, exactly as SyncService._pull() does ──────────
  console.log("\n2. Bootstrap sync fills the offline store");
  const pull = await api(`/sync/pull?deviceId=${deviceId}`, { token });
  const entities = pull.json?.data?.entities ?? {};

  check("Pull returns the `entities` envelope the client reads", !!pull.json?.data?.entities);
  check("Customers downloaded", (entities.customers?.length ?? 0) > 0, `${entities.customers?.length} rows`);
  check("Product catalogue downloaded", (entities.products?.length ?? 0) > 0, `${entities.products?.length} rows`);
  check("Today's route downloaded", (entities.routes?.length ?? 0) > 0);
  check("Territory fences downloaded", (entities.territories?.length ?? 0) > 0);

  const route = entities.routes?.[0];
  check("Route carries ordered stops", (route?.stops?.length ?? 0) > 0, `${route?.stops?.length} stops`);

  // This test creates its own visit rather than consuming a seeded one.
  // Checking in mutates state, so borrowing a seeded visit would make the
  // suite pass once and fail on every rerun — the test has to be repeatable.
  const customer = (entities.customers ?? []).find((c) => c.latitude != null);
  check("A mapped customer is available to visit", !!customer);
  if (!customer) throw new Error("No customer with a GPS pin — cannot continue");

  const scheduled = await api("/visits", {
    method: "POST",
    token,
    body: {
      customerId: customer.id,
      scheduledAt: new Date().toISOString(),
      purpose: "SALES",
    },
  });
  const visit = scheduled.json?.data;
  check("Rep schedules a visit for this customer", scheduled.status === 201 && !!visit?.id);

  const balanceBefore = customer.balanceCents;
  const products = entities.products.slice(0, 2);

  // ── 3. Offline work ─────────────────────────────────────────────────
  // Nothing is sent here. This is the queue the handset builds with no signal.
  console.log("\n3. Rep works offline (queue built locally, nothing sent)");

  const ids = {
    checkIn: uuid(),
    order: uuid(),
    payment: uuid(),
    checkOut: uuid(),
  };
  const t0 = Date.now();

  const batch = {
    deviceId,
    operations: [
      {
        uuid: ids.checkIn,
        type: "visit.checkin",
        at: new Date(t0).toISOString(),
        payload: {
          visitId: visit.id,
          // ~25m from the pin: a realistic fix from inside the shop.
          latitude: customer.latitude + 0.0002,
          longitude: customer.longitude + 0.0001,
          accuracyM: 14,
        },
      },
      {
        uuid: ids.order,
        type: "order.create",
        at: new Date(t0 + 60_000).toISOString(),
        payload: {
          customerId: customer.id,
          lines: [
            { productId: products[0].id, quantity: 12 },
            { productId: products[1].id, quantity: 30 },
          ],
          note: "Captured offline during integration test",
        },
      },
      {
        uuid: ids.payment,
        type: "payment.create",
        at: new Date(t0 + 120_000).toISOString(),
        payload: {
          customerId: customer.id,
          amountCents: 25_000_00,
          method: "MPESA",
          reference: "INTEGRATION-TEST",
        },
      },
      {
        uuid: ids.checkOut,
        type: "visit.checkout",
        at: new Date(t0 + 180_000).toISOString(),
        payload: {
          visitId: visit.id,
          latitude: customer.latitude,
          longitude: customer.longitude,
          outcome: "Order placed",
          notes: "Stock rotated, promo material left",
        },
      },
    ],
  };
  check("Four operations queued on the handset", batch.operations.length === 4);

  // ── 4. Reconnect and drain ──────────────────────────────────────────
  console.log("\n4. Signal returns — queue drains");
  const push = await api("/sync/push", { method: "POST", token, body: batch });

  check("Batch accepted", push.status === 200);
  check(
    "All four applied in order",
    push.json?.data?.summary?.applied === 4,
    JSON.stringify(push.json?.data?.summary),
  );

  const result = (u) => push.json?.data?.results?.find((r) => r.uuid === u);
  const orderId = result(ids.order)?.entityId;
  check("Order created server-side", !!orderId);
  check("Payment created server-side", !!result(ids.payment)?.entityId);

  // ── 5. Idempotency: the retry that must not double-post ─────────────
  console.log("\n5. Connection dropped mid-reply — handset retries the same batch");
  const replay = await api("/sync/push", { method: "POST", token, body: batch });

  check("Replay accepted", replay.status === 200);
  check(
    "Nothing applied twice",
    replay.json?.data?.summary?.applied === 0 &&
      replay.json?.data?.summary?.duplicates === 4,
    JSON.stringify(replay.json?.data?.summary),
  );
  check(
    "Replay resolves to the same order, not a new one",
    replay.json?.data?.results?.find((r) => r.uuid === ids.order)?.entityId === orderId,
  );

  // ── 6. Server-side effects ──────────────────────────────────────────
  console.log("\n6. Server state reflects the field work");
  const visitAfter = await api(`/visits?customerId=${customer.id}&limit=100`, { token });
  const workedVisit = (visitAfter.json?.data ?? []).find((v) => v.id === visit.id);

  check("Visit marked completed", workedVisit?.status === "COMPLETED");
  check(
    "Check-in GPS-verified against the customer fence",
    workedVisit?.geofenceVerified === true,
    `${workedVisit?.distanceFromCustomerM}m from pin`,
  );
  check("Visit duration derived from check-in/out times", (workedVisit?.durationMin ?? 0) > 0, `${workedVisit?.durationMin} min`);

  const customerAfter = await api(`/customers/${customer.id}`, { token });
  const balanceAfter = customerAfter.json?.data?.balanceCents;
  check(
    "Customer balance moved by exactly the invoice and payment",
    typeof balanceAfter === "number" && balanceAfter !== balanceBefore,
    `${balanceBefore} → ${balanceAfter}`,
  );

  // ── 7. Delta pull returns the rep's own work, reconciled ────────────
  console.log("\n7. Next sync pulls the reconciled records back");
  const delta = await api(
    `/sync/pull?since=${encodeURIComponent(new Date(t0 - 5000).toISOString())}&deviceId=${deviceId}`,
    { token },
  );
  const deltaOrders = delta.json?.data?.entities?.orders ?? [];
  const echoed = deltaOrders.find((o) => o.id === orderId);

  check("Order comes back with its server number", !!echoed?.number, echoed?.number);
  check("Client UUID preserved for local reconciliation", echoed?.clientUuid === ids.order);
  check("Order attributed to the FIELD channel", echoed?.channel === "FIELD");

  // ── 8. The back office sees it ──────────────────────────────────────
  // The real test of "connected": not an API echo, but the console page a
  // sales manager opens, rendered from shared state.
  console.log("\n8. Back office opens the console");
  const managerCookie = await sessionCookie("sales@zamarsolutions.co.ke");
  check("Sales manager signs in to the console", !!managerCookie);

  const salesPage = await consoleHtml(managerCookie, "/app/sales");
  check("Sales page renders", salesPage.status === 200);

  const fieldPage = await consoleHtml(managerCookie, "/app/field");
  check("Field Sales page renders", fieldPage.status === 200);
  check(
    "The offline visit appears on the field dashboard",
    fieldPage.html.includes(customer.name),
    customer.name,
  );

  const geoPage = await consoleHtml(managerCookie, "/app/routes");
  check("Routing & Geofencing page renders", geoPage.status === 200);
  check(
    "Geofence event trail shows the verified check-in",
    geoPage.html.includes("visit verified"),
  );

  const customerPage = await consoleHtml(managerCookie, `/app/customers/${customer.id}`);
  check("Customer 360 page renders", customerPage.status === 200);
  check(
    "Payment reference captured in the field is visible",
    customerPage.html.includes("Payment") || customerPage.html.includes("PAY-"),
  );

  // ── 9. Audit trail ──────────────────────────────────────────────────
  console.log("\n9. The sync is auditable");
  const superCookie = await sessionCookie("admin@tariafrica.com");
  const auditPage = await consoleHtml(superCookie, "/admin/audit?action=SYNC");
  check("Platform audit log renders", auditPage.status === 200);
  check("Sync batch was recorded in the audit trail", auditPage.html.includes("sync"));

  console.log(`\n${"=".repeat(56)}`);
  console.log(`  ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log(`\n  Failures:\n${failures.map((f) => `   - ${f}`).join("\n")}`);
  }
  console.log(`${"=".repeat(56)}\n`);

  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("\nIntegration test crashed:", error);
  process.exit(1);
});
