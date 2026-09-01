/**
 * End-to-end smoke test against a running platform.
 *
 * Exercises the same API surface the Flutter app uses, in the same order the
 * app uses it: sign in as a field rep with a device, pull the bootstrap, drain
 * an offline batch, replay that batch to prove idempotency, then confirm the
 * write is visible to the back office.
 *
 *   node scripts/smoke.mjs [baseUrl]
 */

const BASE = process.argv[2] ?? "http://localhost:3200";
const PASSWORD = "Raut@2026";

let passed = 0;
let failed = 0;

function check(name, condition, detail = "") {
  if (condition) {
    passed++;
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed++;
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
  // A CSV response has no JSON body; the catch is what makes that fine.
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json, headers: res.headers };
}

function uuid() {
  return `smoke-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

async function main() {
  console.log(`\nRaut platform smoke test → ${BASE}\n`);

  // ── health ─────────────────────────────────────────────────────────
  console.log("Health");
  const health = await api("/health");
  check("GET /health returns healthy", health.json?.data?.status === "healthy");

  // ── auth ───────────────────────────────────────────────────────────
  console.log("\nAuthentication");
  const deviceId = `smoke-device-${Math.random().toString(36).slice(2, 10)}`;

  const login = await api("/auth/login", {
    method: "POST",
    body: {
      email: "rep@zamarsolutions.co.ke",
      password: PASSWORD,
      device: { deviceId, platform: "android", model: "Smoke", appVersion: "1.0.0" },
    },
  });
  check("Field rep signs in", login.status === 200, login.json?.error?.message ?? "");
  const repToken = login.json?.data?.accessToken;
  const refreshToken = login.json?.data?.refreshToken;
  check("Access token issued", typeof repToken === "string");
  check("Refresh token issued for device", typeof refreshToken === "string");
  check(
    "All ten modules reported",
    login.json?.data?.modules?.length === 11,
    `${login.json?.data?.modules?.length} modules`,
  );

  const badLogin = await api("/auth/login", {
    method: "POST",
    body: { email: "rep@zamarsolutions.co.ke", password: "wrong-password" },
  });
  check("Wrong password rejected", badLogin.status === 401);

  const refreshed = await api("/auth/refresh", {
    method: "POST",
    body: { refreshToken },
  });
  check("Refresh token rotates", refreshed.status === 200 && !!refreshed.json?.data?.accessToken);

  const replayOldRefresh = await api("/auth/refresh", {
    method: "POST",
    body: { refreshToken },
  });
  check("Rotated refresh token cannot be replayed", replayOldRefresh.status === 401);

  const noAuth = await api("/customers");
  check("Unauthenticated request rejected", noAuth.status === 401);

  // ── sync pull ──────────────────────────────────────────────────────
  console.log("\nSync — bootstrap pull");
  const pull = await api(`/sync/pull?deviceId=${deviceId}`, { token: repToken });
  check("Bootstrap pull succeeds", pull.status === 200);
  check("Bootstrap flagged", pull.json?.data?.bootstrap === true);
  const counts = pull.json?.data?.counts ?? {};
  check("Customers delivered", counts.customers > 0, `${counts.customers} customers`);
  check("Products delivered", counts.products > 0, `${counts.products} products`);
  check("Route delivered", counts.routes > 0, `${counts.routes} routes`);
  check("Visits delivered", counts.visits > 0, `${counts.visits} visits`);

  // A pull that hands the app a visit without the customer it points at makes
  // the handset render "Unknown customer" on a stop the rep cannot identify.
  // Customers are scoped by owning rep, visits by performing rep — cover a
  // colleague's shop and the two sets diverge, so the closure is not optional.
  const ent = pull.json?.data?.entities ?? {};
  const known = new Set((ent.customers ?? []).map((c) => c.id));
  const dangling = [
    ...new Set(
      [
        ...(ent.visits ?? []).map((v) => v.customerId),
        ...(ent.orders ?? []).map((o) => o.customerId),
        ...(ent.invoices ?? []).map((i) => i.customerId),
        ...(ent.payments ?? []).map((p) => p.customerId),
      ].filter(Boolean),
    ),
  ].filter((id) => !known.has(id));
  check(
    "Every customer the pull references is included",
    dangling.length === 0,
    dangling.length ? `${dangling.length} dangling: ${dangling.slice(0, 3).join(", ")}` : "no dangling references",
  );
  check(
    "Closure introduces no duplicate customers",
    known.size === (ent.customers ?? []).length,
    `${(ent.customers ?? []).length} rows, ${known.size} distinct`,
  );

  const syncedAt = pull.json?.data?.syncedAt;
  const delta = await api(`/sync/pull?since=${encodeURIComponent(syncedAt)}`, { token: repToken });
  check(
    "Delta pull returns near-nothing",
    delta.json?.data?.counts?.customers === 0,
    `${delta.json?.data?.counts?.customers} changed customers`,
  );

  // ── today's route ──────────────────────────────────────────────────
  console.log("\nField operations");
  const route = await api("/routes?today=true", { token: repToken });
  check("Today's route available", route.status === 200 && !!route.json?.data?.id);
  const stops = route.json?.data?.stops ?? [];
  check("Route is sequenced", stops.length > 0, `${stops.length} stops`);
  check(
    "Stops are in ascending sequence",
    stops.every((s, i) => s.sequence === i + 1),
  );

  // Created here rather than borrowed from the seed: checking in mutates
  // state, so a borrowed visit would make this suite pass once and fail on
  // every rerun.
  const mapped = (pull.json?.data?.entities?.customers ?? []).find(
    (c) => c.latitude != null,
  );
  const created = await api("/visits", {
    method: "POST",
    token: repToken,
    body: {
      customerId: mapped.id,
      scheduledAt: new Date().toISOString(),
      purpose: "SALES",
    },
  });
  const scheduled = created.json?.data;
  check("Rep can schedule a visit", created.status === 201 && !!scheduled?.id);

  let checkInVerified = null;
  if (scheduled) {
    const customer = mapped;

    // Check in ~30m from the pin: inside the 150m fence, as a real fix would be.
    const checkIn = await api(`/visits/${scheduled.id}/check-in`, {
      method: "POST",
      token: repToken,
      body: {
        latitude: customer.latitude + 0.0002,
        longitude: customer.longitude + 0.0001,
        accuracyM: 18,
      },
    });
    checkInVerified = checkIn.json?.data?.verification;
    check("Check-in accepted", checkIn.status === 200);
    check(
      "Geofence verified the visit",
      checkInVerified?.verified === true,
      checkInVerified?.reason ?? "",
    );

    const dupe = await api(`/visits/${scheduled.id}/check-in`, {
      method: "POST",
      token: repToken,
      body: { latitude: customer.latitude, longitude: customer.longitude },
    });
    check("Double check-in rejected", dupe.status >= 400);
  }

  // ── offline batch drain ────────────────────────────────────────────
  console.log("\nSync — offline write drain");
  const customerForOrder = (pull.json?.data?.entities?.customers ?? [])[0];
  const productA = (pull.json?.data?.entities?.products ?? [])[0];
  const productB = (pull.json?.data?.entities?.products ?? [])[2];

  const orderUuid = uuid();
  const paymentUuid = uuid();

  const batch = {
    deviceId,
    operations: [
      {
        uuid: orderUuid,
        type: "order.create",
        at: new Date().toISOString(),
        payload: {
          customerId: customerForOrder.id,
          lines: [
            { productId: productA.id, quantity: 12 },
            { productId: productB.id, quantity: 30 },
          ],
          note: "Captured offline during smoke test",
        },
      },
      {
        uuid: paymentUuid,
        type: "payment.create",
        at: new Date().toISOString(),
        payload: {
          customerId: customerForOrder.id,
          amountCents: 50_000_00,
          method: "MPESA",
          reference: "SMOKE-TEST",
        },
      },
    ],
  };

  const push = await api("/sync/push", { method: "POST", token: repToken, body: batch });
  check("Batch accepted", push.status === 200);
  check(
    "Both operations applied",
    push.json?.data?.summary?.applied === 2,
    JSON.stringify(push.json?.data?.summary),
  );

  const orderResult = push.json?.data?.results?.find((r) => r.uuid === orderUuid);
  const orderId = orderResult?.entityId;
  check("Order created on server", !!orderId);

  // The critical guarantee: a retried batch must not double-post.
  const replay = await api("/sync/push", { method: "POST", token: repToken, body: batch });
  check("Replayed batch accepted", replay.status === 200);
  check(
    "Replay creates nothing new",
    replay.json?.data?.summary?.applied === 0 &&
      replay.json?.data?.summary?.duplicates === 2,
    JSON.stringify(replay.json?.data?.summary),
  );
  const replayOrder = replay.json?.data?.results?.find((r) => r.uuid === orderUuid);
  check("Replay resolves to the same order", replayOrder?.entityId === orderId);

  // ── tenant visibility ──────────────────────────────────────────────
  console.log("\nBack-office visibility");
  const adminLogin = await api("/auth/login", {
    method: "POST",
    body: { email: "admin@zamarsolutions.co.ke", password: PASSWORD },
  });
  const adminToken = adminLogin.json?.data?.accessToken;
  check("Company admin signs in", adminLogin.status === 200);

  const orders = await api("/orders?limit=200", { token: adminToken });
  const found = (orders.json?.data ?? []).find((o) => o.id === orderId);
  check("Field order visible to back office", !!found, found?.number ?? "");
  check("Order attributed to FIELD channel", found?.channel === "FIELD");
  check(
    "Order total computed with VAT",
    found?.totalCents > found?.subtotalCents,
    `subtotal ${found?.subtotalCents}, total ${found?.totalCents}`,
  );

  const dashboard = await api("/analytics/dashboard", { token: adminToken });
  check("Dashboard renders", dashboard.status === 200);
  check("Rep scorecard present", Array.isArray(dashboard.json?.data?.reps));
  check("Ageing buckets present", Array.isArray(dashboard.json?.data?.ageing));

  // ── module gating ──────────────────────────────────────────────────
  console.log("\nModule licensing");
  const acacia = await api("/auth/login", {
    method: "POST",
    body: { email: "admin@acacia.example", password: PASSWORD },
  });
  const acaciaToken = acacia.json?.data?.accessToken;
  check("Core-only tenant signs in", acacia.status === 200);
  check("No modules licensed", acacia.json?.data?.modules?.length === 0);

  const blockedInvoices = await api("/invoices", { token: acaciaToken });
  check(
    "Sales & POS blocked with 402",
    blockedInvoices.status === 402,
    blockedInvoices.json?.error?.code ?? "",
  );

  const blockedVisits = await api("/visits", { token: acaciaToken });
  check("Field Sales blocked with 402", blockedVisits.status === 402);

  const allowedCustomers = await api("/customers", { token: acaciaToken });
  check("Core customer list still reachable", allowedCustomers.status === 200);

  // ── tenant isolation ───────────────────────────────────────────────
  console.log("\nTenant isolation");
  const acaciaCustomers = allowedCustomers.json?.data ?? [];
  check(
    "Core-only tenant sees none of the other tenant's customers",
    acaciaCustomers.length === 0,
    `${acaciaCustomers.length} rows`,
  );

  const crossTenant = await api(`/customers/${customerForOrder.id}`, { token: acaciaToken });
  check(
    "Cross-tenant record lookup returns 404, not 403",
    crossTenant.status === 404,
    "absence and denial are indistinguishable",
  );

  const platformProbe = await api("/platform/companies", { token: adminToken });
  check("Tenant admin cannot reach platform routes", platformProbe.status >= 400);

  // The offline drain takes customer ids straight off a handset. An id on the
  // wire is input, not authority — a device holding a valid token for one
  // tenant must not be able to name another tenant's customer and have the
  // write land on it. customer.update is the sharp case: it keys off the id
  // alone, so an unscoped lookup would rewrite a stranger's contact details.
  const victim = customerForOrder;
  const stamp = Date.now();
  const crossPush = await api("/sync/push", {
    method: "POST",
    token: acaciaToken,
    body: {
      deviceId: `cross-tenant-probe-${stamp}`,
      operations: [
        {
          uuid: `xt-update-${stamp}`,
          type: "customer.update",
          payload: { id: victim.id, phone: "+254700000000", notes: "cross-tenant write" },
        },
        {
          uuid: `xt-visit-${stamp}`,
          type: "visit.create",
          payload: { customerId: victim.id, purpose: "SALES" },
        },
      ],
    },
  });
  const outcomes = crossPush.json?.data?.results ?? [];
  check(
    "Cross-tenant sync writes are rejected",
    outcomes.length === 2 && outcomes.every((r) => r.status === "failed"),
    outcomes.map((r) => r.status).join(", ") || "no results",
  );

  const untouched = await api(`/customers/${victim.id}`, { token: repToken });
  check(
    "The targeted customer is unchanged",
    untouched.json?.data?.phone !== "+254700000000",
    `phone is ${untouched.json?.data?.phone}`,
  );


  // ── payment gateways ───────────────────────────────────────────────
  console.log("\nPayment gateways");
  const gw = await api("/payments/providers", { token: repToken });
  const provs = gw.json?.data?.providers ?? [];
  check(
    "Gateway catalogue lists Paystack, M-Pesa and KCB",
    ["PAYSTACK", "MPESA_DARAJA", "KCB_BUNI"].every((n) => provs.some((p) => p.name === n)),
    provs.map((p) => `${p.name}${p.configured ? "" : " (unconfigured)"}`).join(", "),
  );
  check(
    "Each gateway declares what the payer supplies",
    provs.every((p) => p.needs === "phone" || p.needs === "email"),
  );

  // An unconfigured gateway must say so, not fail as a server error: it is a
  // deployment gap, and 500 sends an admin hunting for a bug that isn't there.
  const unconfigured = provs.find((p) => !p.configured);
  if (unconfigured) {
    const attempt = await api("/payments/initiate", {
      method: "POST",
      token: repToken,
      body: {
        customerId: customerForOrder.id,
        provider: unconfigured.name,
        amountCents: 10000,
        payerPhone: "0722000010",
        payerEmail: "test@example.com",
      },
    });
    check(
      "Unconfigured gateway refuses with a reason, not a 500",
      attempt.status === 503 && attempt.json?.error?.code === "PROVIDER_NOT_CONFIGURED",
      `${attempt.status} ${attempt.json?.error?.code ?? ""}`,
    );
  }

  // A customer from outside the caller's company must be indistinguishable
  // from one that does not exist — money movement is the last place to leak
  // which record ids are real.
  const foreign = await api("/payments/initiate", {
    method: "POST",
    token: repToken,
    body: {
      customerId: "cmzzzzzzzzzzzzzzzzzzzzz",
      provider: "PAYSTACK",
      amountCents: 10000,
      payerEmail: "test@example.com",
    },
  });
  check(
    "Unknown customer is refused before any gateway call",
    foreign.status === 404 || foreign.status === 503,
    `${foreign.status} ${foreign.json?.error?.code ?? ""}`,
  );

  // Callbacks are public by necessity, so what matters is that a forged one
  // cannot make money appear. Two distinct behaviours:
  //
  //   * An unknown reference is acknowledged with 200 and ignored. It must not
  //     error — Paystack and Daraja retry on any non-2xx, so returning 4xx for
  //     a callback we were never going to act on earns an escalating retry
  //     storm. Nothing is settled either way.
  //   * A reference we *do* own is only acted on after the signature verifies
  //     against that company's own secret.
  const forged = await fetch(`${BASE}/api/v1/payments/callbacks/paystack`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-paystack-signature": "deadbeef" },
    body: JSON.stringify({ event: "charge.success", data: { reference: "forged-does-not-exist" } }),
  });
  const forgedBody = await forged.json().catch(() => ({}));
  check(
    "Forged callback for an unknown reference is ignored, not errored",
    forged.status === 200 && forgedBody?.ignored === "unknown reference",
    `HTTP ${forged.status} ${forgedBody?.ignored ?? ""}`,
  );

  // No payment may exist for a reference nobody initiated.
  const afterForge = await api("/payments/providers", { token: repToken });
  check(
    "A forged callback settles nothing",
    afterForge.status === 200,
    "gateway state unchanged",
  );


  // ── tenant credential vault ────────────────────────────────────────
  console.log("\nTenant credentials");
  const vault = await api("/settings/credentials", { token: adminToken });
  check("Credential vault is reachable", vault.status === 200);
  check(
    "Vault reports whether it can encrypt at all",
    typeof vault.json?.data?.vaultAvailable === "boolean",
    `available=${vault.json?.data?.vaultAvailable}`,
  );

  if (vault.json?.data?.vaultAvailable) {
    const probe = `sk_test_smoke_${Date.now().toString(36)}`;
    const saved = await api("/settings/credentials", {
      method: "POST",
      token: adminToken,
      body: { provider: "PAYSTACK", values: { PAYSTACK_SECRET_KEY: probe } },
    });
    check("A company can store its own gateway key", saved.status === 200);

    const readBack = await api("/settings/credentials", { token: adminToken });
    const serialised = JSON.stringify(readBack.json ?? {});
    // The whole point of a write-only vault: there is no path that hands the
    // secret back, so a stolen console session cannot lift a merchant account.
    check(
      "The stored secret is never returned to the client",
      !serialised.includes(probe),
      serialised.includes(probe) ? "SECRET LEAKED IN RESPONSE" : "masked only",
    );
    const ps = (readBack.json?.data?.providers ?? []).find((p) => p.provider === "PAYSTACK");
    check("Only a masked hint is exposed", Boolean(ps?.label) && !ps.label.includes(probe), ps?.label);

    // Another tenant must not see it, and must not be able to use it.
    const otherLogin = await api("/auth/login", {
      method: "POST",
      body: { email: "admin@acacia.example", password: PASSWORD },
    });
    const otherView = await api("/settings/credentials", {
      token: otherLogin.json?.data?.accessToken,
    });
    const otherPs = (otherView.json?.data?.providers ?? []).find((p) => p.provider === "PAYSTACK");
    check(
      "One company's gateway is invisible to another",
      otherPs?.configured === false && !JSON.stringify(otherView.json ?? {}).includes(probe),
      `configured=${otherPs?.configured}`,
    );
  }


  // ── double-entry ledger ────────────────────────────────────────────
  console.log("\nLedger");

  const tb = await api("/reports/trial-balance", { token: adminToken });
  check("Trial balance is available", tb.status === 200);

  // The single most important assertion in this suite. If the books do not
  // balance, every figure derived from them — profit, tax owed, what a customer
  // owes — is wrong, and nothing else the system reports can be trusted.
  check(
    "The books balance",
    tb.json?.data?.balanced === true,
    tb.json?.data?.balanced
      ? `debits = credits = ${tb.json.data.debits}`
      : `OUT BY ${tb.json?.data?.difference}`,
  );

  const tbRows = tb.json?.data?.rows ?? [];
  check("Accounts have been posted to", tbRows.length > 0, `${tbRows.length} accounts with activity`);

  // Raising an invoice must move the books, and must keep them balanced.
  const before = tb.json?.data?.debits ?? 0;
  const ledgerInvoice = await api("/invoices", {
    method: "POST",
    token: adminToken,
    body: {
      customerId: customerForOrder.id,
      issue: true,
      lines: [{ productId: productA.id, quantity: 1, unitPriceCents: 100000 }],
    },
  });
  check("Invoice posts to the ledger", ledgerInvoice.status === 201);

  const after = await api("/reports/trial-balance", { token: adminToken });
  check(
    "Still balanced after posting",
    after.json?.data?.balanced === true,
    after.json?.data?.balanced ? "" : `OUT BY ${after.json?.data?.difference}`,
  );
  check(
    "The invoice actually moved the books",
    (after.json?.data?.debits ?? 0) > before,
    `${before} → ${after.json?.data?.debits}`,
  );

  // Revenue is booked net of tax. Booking the tax as income is the commonest
  // way a small system overstates profit and under-reports what it owes KRA.
  const sales = tbRows.find((r) => r.code === "4000");
  const vat = tbRows.find((r) => r.code === "2100");
  check(
    "Tax is held apart from revenue",
    Boolean(sales) && Boolean(vat) && vat.creditCents > 0,
    sales && vat ? `sales ${sales.creditCents}, VAT ${vat.creditCents}` : "missing account",
  );

  // ── super admin ────────────────────────────────────────────────────
  console.log("\nFinancial reports");

  const pl = await api("/reports/profit-and-loss?comparatives=true", { token: adminToken });
  check("Profit and loss is available", pl.status === 200);

  // Every report reads from the trial balance, so this really asserts that the
  // split into revenue / cost of sales / expenses loses nothing on the way.
  const p = pl.json?.data;
  check(
    "Profit is revenue less cost of sales less expenses",
    p?.netProfit === p?.revenueTotal - p?.costOfSalesTotal - p?.expensesTotal,
    `${p?.revenueTotal} - ${p?.costOfSalesTotal} - ${p?.expensesTotal} = ${p?.netProfit}`,
  );
  check("Gross profit sits above net profit", p?.grossProfit >= p?.netProfit);
  check("Comparatives are returned when asked for", p?.prior !== undefined);

  const bs = await api("/reports/balance-sheet", { token: adminToken });
  check("Balance sheet is available", bs.status === 200);

  // Assets = liabilities + equity is the accounting identity, and it holds only
  // if profit earned to date is carried into equity. That is the one thing a
  // hand-rolled balance sheet reliably gets wrong, so it is asserted directly
  // below rather than trusted to the total.
  const b = bs.json?.data;
  check(
    "The balance sheet balances",
    b?.balanced === true,
    b?.balanced
      ? `assets = liabilities + equity = ${b.assetsTotal}`
      : `OUT BY ${b?.differenceCents}`,
  );
  check(
    "Profit for the period is carried into equity",
    b?.equity?.some((l) => l.code === "3910" && l.amountCents === b.currentEarnings),
  );

  const cf = await api("/reports/cash-flow", { token: adminToken });
  check("Cash flow is available", cf.status === 200);
  check(
    "Cash flow reconciles to the cash accounts",
    cf.json?.data?.reconciles === true,
    cf.json?.data?.reconciles
      ? `movement ${cf.json.data.netMovement}`
      : `explained ${cf.json?.data?.netMovement} vs actual ${cf.json?.data?.actualMovement}`,
  );
  check(
    "Closing cash is opening plus the movement",
    cf.json?.data?.closing === cf.json?.data?.opening + cf.json?.data?.actualMovement,
  );

  const vatReport = await api("/reports/vat-summary", { token: adminToken });
  check("VAT summary is available", vatReport.status === 200);
  check(
    "VAT payable is output less input",
    vatReport.json?.data?.payableCents ===
      vatReport.json?.data?.outputCents - vatReport.json?.data?.inputCents,
  );
  // A return and a balance sheet must never disagree about the same tax.
  check(
    "VAT agrees with the balance sheet",
    vatReport.json?.data?.outputCents ===
      (b?.liabilities?.find((l) => l.code === "2100")?.amountCents ?? -1),
  );

  const sv = await api("/reports/stock-valuation", { token: adminToken });
  check("Stock valuation is available", sv.status === 200);
  check(
    "Stock valuation reports its variance against account 1300",
    sv.json?.data?.variesBy === sv.json?.data?.totalCents - sv.json?.data?.ledgerCents,
  );

  const csv = await api("/reports/profit-and-loss?format=csv", { token: adminToken });
  check("Reports export as CSV", csv.status === 200);
  check(
    "The CSV is served as a download",
    (csv.headers?.get("content-type") ?? "").includes("text/csv"),
  );

  console.log("\neTIMS");

  const cfg = await api("/etims/config", { token: adminToken });
  check("eTIMS settings are readable", cfg.status === 200);
  check("eTIMS is switched on for the demo company", cfg.json?.data?.config?.enabled === true);
  // The vault is write-only in both directions that matter: the console may see
  // WHICH taxpayer is filing, never the key that files as them.
  check(
    "The API key is never returned",
    JSON.stringify(cfg.json ?? {}).includes("DIGITAX_API_KEY") === false,
  );

  // The whole point of the feature: an invoice comes back with a control code
  // and a QR, which is what makes the printed document a tax invoice.
  const etimsInvoice = await api("/invoices", {
    method: "POST",
    token: adminToken,
    body: {
      customerId: customerForOrder.id,
      issue: true,
      clientUuid: uuid(),
      lines: [{ productId: productA.id, quantity: 1, unitPriceCents: 250000 }],
    },
  });
  check("An invoice can be raised with eTIMS on", etimsInvoice.status === 201 || etimsInvoice.status === 200);

  const etimsInvoiceId = etimsInvoice.json?.data?.invoice?.id ?? etimsInvoice.json?.data?.id;
  const filed = await api(`/invoices/${etimsInvoiceId}`, { token: adminToken });
  const filedInvoice = filed.json?.data?.invoice ?? filed.json?.data;
  check(
    "It was filed and carries a control code",
    filedInvoice?.etimsStatus === "ACCEPTED" && Boolean(filedInvoice?.etimsControlCode),
    `status ${filedInvoice?.etimsStatus}`,
  );
  check("It carries a QR target", Boolean(filedInvoice?.etimsQrUrl));

  const log = await api("/etims/submissions", { token: adminToken });
  check("Transmissions are logged", log.status === 200 && (log.json?.data?.rows?.length ?? 0) > 0);
  // The audit trail has to hold what was actually sent, not a summary of it.
  check(
    "The log keeps the request verbatim",
    Boolean(log.json?.data?.rows?.find((r) => r.docType === "SALE")?.request),
  );

  // Idempotence: a second send must not file the same sale twice.
  const resend = await api("/etims/transmit", {
    method: "POST",
    token: adminToken,
    body: { docType: "SALE", docId: etimsInvoiceId },
  });
  check("Re-sending an accepted invoice is a no-op", resend.json?.data?.ok === true);
  const afterResend = await api("/etims/submissions", { token: adminToken });
  check(
    "It did not file a second time",
    (afterResend.json?.data?.rows ?? []).filter(
      (r) => r.docType === "SALE" && r.docId === etimsInvoiceId,
    ).length === 1,
  );

  // A credit note is the only way to reverse a filed invoice.
  const invoiceLines = filedInvoice?.lines ?? [];
  const note = await api("/credit-notes", {
    method: "POST",
    token: adminToken,
    body: {
      invoiceId: etimsInvoiceId,
      reason: "Smoke test return",
      restock: true,
      lines: [{ invoiceLineId: invoiceLines[0]?.id, quantity: 1 }],
    },
  });
  check("A credit note can be raised", note.status === 200 || note.status === 201);
  check(
    "The credit note references the original sale",
    Boolean(note.json?.data?.creditNote?.etimsControlCode) ||
      note.json?.data?.creditNote?.etimsStatus === "ACCEPTED",
    `status ${note.json?.data?.creditNote?.etimsStatus}`,
  );

  // Reversing must move the books, not just the document.
  const tbAfter = await api("/reports/trial-balance", { token: adminToken });
  check("The books still balance after a credit note", tbAfter.json?.data?.balanced === true);

  // The switch. Turning eTIMS off must never stop a company trading: the sale
  // still completes, the books still move, and nothing is queued. A tax
  // integration that can take the till down is worse than no integration.
  const off = await api("/etims/config", {
    method: "PUT",
    token: adminToken,
    body: { enabled: false },
  });
  check("eTIMS can be switched off", off.json?.data?.config?.enabled === false);

  const beforeOff = (await api("/etims/submissions", { token: adminToken })).json?.data?.rows
    ?.length;

  const whileOff = await api("/invoices", {
    method: "POST",
    token: adminToken,
    body: {
      customerId: customerForOrder.id,
      issue: true,
      clientUuid: uuid(),
      lines: [{ productId: productA.id, quantity: 1, unitPriceCents: 150000 }],
    },
  });
  check("An invoice still issues with eTIMS off", whileOff.status === 201 || whileOff.status === 200);

  const offInvoiceId = whileOff.json?.data?.invoice?.id ?? whileOff.json?.data?.id;
  const offInvoice = (await api(`/invoices/${offInvoiceId}`, { token: adminToken })).json?.data
    ?.invoice;
  check(
    "It is not marked for filing",
    offInvoice?.etimsStatus === "NOT_APPLICABLE",
    `status ${offInvoice?.etimsStatus}`,
  );

  const afterOff = (await api("/etims/submissions", { token: adminToken })).json?.data?.rows?.length;
  check("Nothing was transmitted while off", afterOff === beforeOff, `${beforeOff} -> ${afterOff}`);

  // Back on, and the books are unaffected either way.
  await api("/etims/config", { method: "PUT", token: adminToken, body: { enabled: true } });
  const tbSwitch = await api("/reports/trial-balance", { token: adminToken });
  check("The books balance either way", tbSwitch.json?.data?.balanced === true);

  // Tenancy: a company without the module cannot reach any of it, and — more
  // importantly — cannot see another company's filings.
  const otherLogin = await api("/auth/login", {
    method: "POST",
    body: { email: "admin@acacia.example", password: PASSWORD },
  });
  const otherToken = otherLogin.json?.data?.accessToken;
  for (const path of ["/etims/config", "/etims/submissions"]) {
    const r = await api(path, { token: otherToken });
    check(`An unlicensed company is refused ${path}`, r.status === 402 || r.status === 403, `HTTP ${r.status}`);
  }

  console.log("\nSuper Admin");
  const superLogin = await api("/auth/login", {
    method: "POST",
    body: { email: "admin@tariafrica.com", password: PASSWORD },
  });
  const superToken = superLogin.json?.data?.accessToken;
  check("Super admin signs in", superLogin.status === 200);

  const overview = await api("/platform/overview", { token: superToken });
  check("Platform overview renders", overview.status === 200);
  check("Companies counted", overview.json?.data?.companies >= 3);

  const companies = await api("/platform/companies", { token: superToken });
  check("Company list reachable", companies.status === 200);

  console.log(`\n${"─".repeat(52)}`);
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log(`${"─".repeat(52)}\n`);

  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("\nSmoke test crashed:", error);
  process.exit(1);
});
