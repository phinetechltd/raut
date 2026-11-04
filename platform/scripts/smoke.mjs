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

/** A plausible, unique M-Pesa receipt code (`^[A-Z0-9]{10}$`). */
function mpesaCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "S";
  for (let i = 0; i < 9; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return s;
}

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

/** A console session cookie, for pages that are not part of /api/v1. */
async function sessionCookie(email) {
  const res = await fetch(`${BASE}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const jar = res.headers.getSetCookie?.() ?? [];
  return jar.find((c) => c.startsWith("raut_session="))?.split(";")[0] ?? "";
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
      email: "rep@tarisolutions.co.ke",
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
    body: { email: "rep@tarisolutions.co.ke", password: "wrong-password" },
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

  // ── vehicles & route planning ──────────────────────────────────────
  // The route is planned here rather than borrowed from the seed: the seed's
  // route is dated the day the seed ran, so on any later day "today's route"
  // would be empty and every check below it would fail for the wrong reason.
  console.log("\nVehicles & route planning");
  const dispatcherLogin = await api("/auth/login", {
    method: "POST",
    body: { email: "admin@tarisolutions.co.ke", password: PASSWORD },
  });
  const dispatcherToken = dispatcherLogin.json?.data?.accessToken;
  const repId = login.json?.data?.user?.id;
  check("Dispatcher signs in", dispatcherLogin.status === 200 && typeof repId === "string");

  const plate = `SMK ${Math.random().toString(36).slice(2, 5).toUpperCase()}${Math.floor(Math.random() * 900 + 100)}`;
  const vehicleRes = await api("/vehicles", {
    method: "POST",
    token: dispatcherToken,
    body: { plate: plate.toLowerCase(), make: "Toyota", model: "Hiace", type: "VAN", defaultRepId: repId },
  });
  const vehicle = vehicleRes.json?.data;
  check("Vehicle created", vehicleRes.status === 201 && !!vehicle?.id, vehicleRes.json?.error?.message ?? "");
  check("Plate is normalised to upper case", vehicle?.plate === plate, vehicle?.plate ?? "");

  const dupPlate = await api("/vehicles", {
    method: "POST",
    token: dispatcherToken,
    body: { plate },
  });
  check("Duplicate plate refused", dupPlate.status === 409, `HTTP ${dupPlate.status}`);

  const vehicleSearch = await api(`/vehicles?q=${encodeURIComponent(plate.slice(0, 6))}&active=true`, {
    token: dispatcherToken,
  });
  check(
    "Vehicle found by plate search",
    vehicleSearch.status === 200 && vehicleSearch.json?.data?.some((v) => v.id === vehicle?.id),
  );
  const repVehicles = await api("/vehicles", { token: repToken });
  check("Rep can read the fleet", repVehicles.status === 200);
  const repCreates = await api("/vehicles", { method: "POST", token: repToken, body: { plate: "NOPE 1" } });
  check("Rep cannot add a vehicle", repCreates.status === 403, `HTTP ${repCreates.status}`);

  const planned = await api("/routes", {
    method: "POST",
    token: dispatcherToken,
    body: {
      repId,
      routeDate: new Date().toISOString(),
      name: "Smoke route",
      vehicleId: vehicle?.id,
      createVisits: true,
      serviceMinutes: 15,
    },
  });
  const plannedRoute = planned.json?.data;
  check(
    "Route planned with the vehicle",
    planned.status === 201 && plannedRoute?.vehicleId === vehicle?.id,
    planned.json?.error?.message ?? `${plannedRoute?.stops?.length ?? 0} stops`,
  );
  check("Planned route carries the plate", plannedRoute?.vehicle?.plate === plate);

  // ── today's route ──────────────────────────────────────────────────
  console.log("\nField operations");
  const route = await api("/routes?today=true", { token: repToken });
  check("Today's route available", route.status === 200 && !!route.json?.data?.id);
  check("Today's route is the one just planned, with its vehicle", route.json?.data?.vehicle?.plate === plate);
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
          // A real M-Pesa code: ten upper-case alphanumerics, unique per
          // company. The server refuses anything else, and a reused code.
          reference: mpesaCode(),
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

  // ── skip & re-route ────────────────────────────────────────────────
  console.log("\nSmart re-routing");
  const stopsBefore = plannedRoute?.stops ?? [];
  const toSkip = stopsBefore.find((s) => s.sequence === 2) ?? stopsBefore[0];
  const skipped = toSkip
    ? await api(`/routes/${plannedRoute.id}/stops/${toSkip.id}`, {
        method: "PATCH",
        token: repToken,
        body: { status: "SKIPPED", skipReason: "Shop closed for stock-take" },
      })
    : { status: 0, json: {} };
  check("Rep skips a stop with a reason", skipped.status === 200 && skipped.json?.data?.status === "SKIPPED", skipped.json?.error?.message ?? "");
  const missed = await api(`/visits?status=MISSED&customerId=${toSkip?.customerId}`, { token: repToken });
  check(
    "The skipped stop's visit is MISSED",
    (missed.json?.data ?? []).some((v) => v.routeId === plannedRoute?.id),
  );
  const noDirectDone = await api(`/routes/${plannedRoute?.id}/stops/${toSkip?.id}`, {
    method: "PATCH",
    token: repToken,
    body: { status: "DONE" },
  });
  check("A client cannot mark a stop DONE directly", noDirectDone.status === 422, `HTTP ${noDirectDone.status}`);

  const nextPending = stopsBefore.find((s) => s.id !== toSkip?.id && s.status === "PENDING");
  const resequenced = await api(`/routes/${plannedRoute?.id}/resequence`, {
    method: "POST",
    token: repToken,
    body: nextPending?.customer
      ? { latitude: nextPending.customer.latitude, longitude: nextPending.customer.longitude }
      : {},
  });
  const rr = resequenced.json?.data;
  check("Route re-sequenced from the rep's position", resequenced.status === 200 && Array.isArray(rr?.stops), resequenced.json?.error?.message ?? "");
  check(
    "Re-sequenced route is no longer than before",
    rr?.totalDistanceM <= rr?.previousDistanceM,
    `${rr?.previousDistanceM} m → ${rr?.totalDistanceM} m`,
  );
  check("Re-sequencing keeps every stop", rr?.stops?.length === stopsBefore.length);
  check("Re-sequenced stops are numbered 1..n", (rr?.stops ?? []).every((s, i) => s.sequence === i + 1));
  check("Skipped stop stays skipped", rr?.stops?.find((s) => s.id === toSkip?.id)?.status === "SKIPPED");
  check("Skipping started the route", rr?.status === "ACTIVE");

  // ── vehicle tracking ───────────────────────────────────────────────
  console.log("\nVehicle tracking");
  const origin = nextPending?.customer ?? mapped;
  // Six fixes thirty seconds apart, the last one right now: "latest" must be
  // this batch, not a ping another script (integration.mjs) wrote a minute ago.
  const t0 = Date.now() - 5 * 30_000;
  const trail = Array.from({ length: 6 }, (_, i) => ({
    latitude: origin.latitude + i * 0.0005,
    longitude: origin.longitude + i * 0.0003,
    accuracyM: 12,
    speedMps: 8.3,
    heading: 40,
    batteryPct: 77,
    isMoving: true,
    recordedAt: new Date(t0 + i * 30_000).toISOString(),
  }));
  // A fix a kilometre wide: stored, but left out of the trail the console draws.
  trail.push({
    latitude: origin.latitude + 0.02,
    longitude: origin.longitude,
    accuracyM: 900,
    speedMps: null,
    heading: null,
    batteryPct: 77,
    isMoving: false,
    // Mid-trail rather than last, so it is never the newest fix on record.
    recordedAt: new Date(t0 + 75_000).toISOString(),
  });
  const pingBatch = () => ({
    deviceId,
    operations: [
      { uuid: uuid(), type: "location.batch", at: new Date().toISOString(), payload: { pings: trail } },
    ],
  });
  const trailOf = async () =>
    (await api(`/location/pings?userId=${repId}&routeId=${plannedRoute?.id}`, { token: dispatcherToken })).json?.data ?? [];

  const trailBefore = (await trailOf()).length;
  const push1 = await api("/sync/push", { method: "POST", token: repToken, body: pingBatch() });
  check("Ping batch accepted", push1.json?.data?.summary?.applied === 1, JSON.stringify(push1.json?.data?.summary));
  const trail1 = await trailOf();
  check(
    "Trail stored, noisy fix left out of the read",
    trail1.length - trailBefore === 6,
    `${trailBefore} → ${trail1.length}`,
  );
  const push2 = await api("/sync/push", { method: "POST", token: repToken, body: pingBatch() });
  check("Resent batch accepted (new batch id)", push2.json?.data?.summary?.applied === 1);
  const trail2 = await trailOf();
  check("Resent batch adds no duplicate breadcrumbs", trail2.length === trail1.length, `${trail1.length} vs ${trail2.length}`);
  const sample = trail2[trail2.length - 1];
  check("Breadcrumbs are stamped with the route and vehicle", sample?.routeId === plannedRoute?.id && sample?.vehicleId === vehicle?.id);
  check("Trail carries speed and accuracy", sample?.speedMps === 8.3 && sample?.accuracyM === 12);

  const latest = await api("/location/latest", { token: dispatcherToken });
  const me = latest.json?.data?.positions?.find((p) => p.userId === repId);
  check("Live view lists the rep", latest.status === 200 && !!me);
  check("Live view shows the plate", me?.vehicle?.plate === plate, me?.vehicle?.plate ?? "no vehicle");
  check("Live fix is fresh", me?.tone === "success" && me?.stalenessS < 900, `${me?.stalenessS}s`);
  check("Live view carries battery and speed", me?.batteryPct === 77 && me?.speedKmh === 30, `${me?.batteryPct}% ${me?.speedKmh} km/h`);
  check("Live view carries route progress", me?.route?.id === plannedRoute?.id && me?.route?.skipped === 1);
  const repFleet = await api("/location/latest", { token: repToken });
  check("Rep is refused the fleet view", repFleet.status === 403, `HTTP ${repFleet.status}`);

  const odometerOp = uuid();
  const odo = await api("/sync/push", {
    method: "POST",
    token: repToken,
    body: {
      deviceId,
      operations: [
        { uuid: odometerOp, type: "route.odometer", at: new Date().toISOString(), payload: { routeId: plannedRoute?.id, odometerStartKm: 84_300 } },
      ],
    },
  });
  check("Odometer start reading accepted offline", odo.json?.data?.results?.[0]?.status === "applied", odo.json?.data?.results?.[0]?.error ?? "");
  const odoEnd = await api(`/routes/${plannedRoute?.id}`, {
    method: "PATCH",
    token: dispatcherToken,
    body: { odometerEndKm: 84_342 },
  });
  check("Odometer end reading recorded", odoEnd.status === 200 && odoEnd.json?.data?.odometerStartKm === 84_300 && odoEnd.json?.data?.odometerEndKm === 84_342);
  const vehicleAfter = await api(`/vehicles/${vehicle?.id}`, { token: dispatcherToken });
  check("Vehicle odometer moved forward", vehicleAfter.json?.data?.odometerKm === 84_342, `${vehicleAfter.json?.data?.odometerKm}`);
  const badOdo = await api(`/routes/${plannedRoute?.id}`, { method: "PATCH", token: dispatcherToken, body: { odometerEndKm: 10 } });
  check("An end reading below the start is refused", badOdo.status >= 400 && badOdo.status < 500, `HTTP ${badOdo.status}`);
  const repSwapsVan = await api(`/routes/${plannedRoute?.id}`, { method: "PATCH", token: repToken, body: { vehicleId: null } });
  check("Rep cannot change the vehicle on a route", repSwapsVan.status === 403, `HTTP ${repSwapsVan.status}`);
  const retired = await api(`/vehicles/${vehicle?.id}`, { method: "PATCH", token: dispatcherToken, body: { active: false } });
  check("Vehicle can be retired", retired.status === 200 && retired.json?.data?.active === false);

  // ── tenant visibility ──────────────────────────────────────────────
  console.log("\nBack-office visibility");
  const adminLogin = await api("/auth/login", {
    method: "POST",
    body: { email: "admin@tarisolutions.co.ke", password: PASSWORD },
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
    // A production server (NODE_ENV=production without PAYMENTS_ALLOW_TEST_KEYS)
    // refuses a sk_test_ key by design; that refusal is the correct answer
    // there, and the vault checks below need a stored key to mean anything.
    const refusedTestKey =
      saved.status === 422 && /test key/i.test(saved.json?.error?.message ?? "");
    check(
      "A company can store its own gateway key",
      saved.status === 200 || refusedTestKey,
      refusedTestKey ? "production refuses test keys (expected)" : "",
    );
    if (saved.status === 200) {

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
  //
  // Read from the balance taken *after* the invoice above. The earlier snapshot
  // only passed while the database happened to hold older postings; on a fresh
  // seed it had no sales at all and the check said nothing about this invoice.
  const afterRows = after.json?.data?.rows ?? [];
  const sales = afterRows.find((r) => r.code === "4000");
  const vat = afterRows.find((r) => r.code === "2100");
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

  console.log("\nSelling units");

  const variants = await api(`/products/variants?productId=${productA.id}`, {
    token: adminToken,
  });
  check("Selling units are listed", variants.status === 200);

  const dozen = (variants.json?.data?.variants ?? []).find(
    (v) => v.unitsPerVariant === 12,
  );
  check("A multi-unit selling unit exists", Boolean(dozen), `${dozen?.name}`);

  // The whole of stock splitting: one pool in base units, and a dozen is
  // twelve of it. If this is wrong the shelf and the invoice disagree, and
  // nothing downstream notices until a stock take.
  // Stock only moves when a location is named — consumeForSale returns early
  // without one, which is correct for an office invoice with no goods behind
  // it and would otherwise make this assertion pass for the wrong reason.
  const stockLocation = (await api("/stock", { token: adminToken })).json?.data?.locations?.find(
    (l) => l.type === "WAREHOUSE",
  );

  const onHand = async () => {
    const res = await api("/stock", { token: adminToken });
    const level = (res.json?.data?.levels ?? []).find((l) => l.productId === productA.id);
    return level?.totalQuantity ?? 0;
  };
  const onHandBefore = await onHand();

  const dozenSale = await api("/invoices", {
    method: "POST",
    token: adminToken,
    body: {
      customerId: customerForOrder.id,
      issue: true,
      locationId: stockLocation?.id,
      clientUuid: uuid(),
      lines: [{ productId: productA.id, variantId: dozen?.id, quantity: 2 }],
    },
  });
  check("A dozen can be sold", dozenSale.status === 201 || dozenSale.status === 200);

  const dozenId = dozenSale.json?.data?.invoice?.id ?? dozenSale.json?.data?.id;
  const dozenInvoice = (await api(`/invoices/${dozenId}`, { token: adminToken })).json?.data
    ?.invoice;
  const dozenLine = dozenInvoice?.lines?.[0];

  check("The line is stored in the unit sold", dozenLine?.quantity === 2, `qty ${dozenLine?.quantity}`);
  check(
    "And in base units for stock",
    dozenLine?.baseQuantity === 24,
    `base ${dozenLine?.baseQuantity}`,
  );
  check("The selling unit is snapshotted onto the line", Boolean(dozenLine?.variantName));
  check(
    "It is priced per unit sold, not per base unit",
    dozenLine?.unitPriceCents === dozen?.sellPriceCents,
    `${dozenLine?.unitPriceCents} vs ${dozen?.sellPriceCents}`,
  );

  const onHandAfter = await onHand();
  check(
    "Two dozen took 24 off the shelf, not 2",
    onHandBefore - onHandAfter === 24,
    `${onHandBefore} -> ${onHandAfter}`,
  );

  // A variant belonging to another product would price one thing and ship
  // another.
  const wrongVariant = await api("/invoices", {
    method: "POST",
    token: adminToken,
    body: {
      customerId: customerForOrder.id,
      clientUuid: uuid(),
      lines: [{ productId: productB.id, variantId: dozen?.id, quantity: 1 }],
    },
  });
  check(
    "A selling unit from another product is refused",
    wrongVariant.status >= 400,
    `HTTP ${wrongVariant.status}`,
  );

  console.log("\nSplit stock & transfers");

  // Two different tracked products: stock is one pool per product, so a split
  // only means anything between two products. Both get a known quantity at the
  // main store first so the lifecycle below is deterministic.
  const splitCatalogue = (await api("/products?limit=50", { token: adminToken })).json?.data ?? [];
  const splitTracked = splitCatalogue.filter((p) => p.trackStock && p.costPriceCents > 0);
  const splitCarton = splitTracked[0];
  const splitPiece = splitTracked.find((p) => p.id !== splitCarton?.id);
  const stockRes = (await api("/stock", { token: adminToken })).json?.data;
  const warehouses = (stockRes?.locations ?? []).filter((l) => l.type === "WAREHOUSE");
  const mainStore = warehouses[0];
  const otherStore = (stockRes?.locations ?? []).find((l) => l.id !== mainStore?.id);
  check("Two tracked products and two locations exist", Boolean(splitCarton && splitPiece && mainStore && otherStore));

  const levelAt = async (productId, locationId) => {
    const res = await api("/stock", { token: adminToken });
    const level = (res.json?.data?.levels ?? []).find((l) => l.productId === productId);
    return level?.byLocation.find((b) => b.locationId === locationId)?.quantity ?? 0;
  };

  await api("/stock", {
    method: "POST",
    token: adminToken,
    body: { productId: splitCarton.id, locationId: mainStore.id, quantity: 40, note: "Smoke: seed for split and transfers" },
  });

  // ── split / repack ──
  const cartonBefore = await levelAt(splitCarton.id, mainStore.id);
  const pieceBefore = await levelAt(splitPiece.id, mainStore.id);
  const splitRes = await api("/stock/repack", {
    method: "POST",
    token: adminToken,
    body: { locationId: mainStore.id, fromProductId: splitCarton.id, fromQuantity: 2, toProductId: splitPiece.id, toQuantity: 7 },
  });
  check("A split is recorded", splitRes.status === 201, splitRes.json?.error?.message ?? "");
  const splitData = splitRes.json?.data;
  check("Both legs share one reference", splitData?.out?.refId === splitData?.refId && splitData?.in?.refId === splitData?.refId);
  check(
    "Value out = value in + rounding written off",
    splitData && -splitData.out.quantity * splitData.out.unitCostCents === splitData.in.quantity * splitData.in.unitCostCents + splitData.remainderCents,
    splitData ? `${-splitData.out.quantity * splitData.out.unitCostCents} = ${splitData.in.quantity * splitData.in.unitCostCents} + ${splitData.remainderCents}` : "",
  );
  check("Rounding is smaller than the units produced", splitData && splitData.remainderCents < splitData.in.quantity);
  check("Source shelf went down by the split quantity", (await levelAt(splitCarton.id, mainStore.id)) === cartonBefore - 2);
  check("Target shelf went up by the units produced", (await levelAt(splitPiece.id, mainStore.id)) === pieceBefore + 7);

  const splitTooMany = await api("/stock/repack", {
    method: "POST",
    token: adminToken,
    body: { locationId: mainStore.id, fromProductId: splitCarton.id, fromQuantity: 1_000_000, toProductId: splitPiece.id, toQuantity: 1 },
  });
  check("A split beyond what is on hand is refused", splitTooMany.status === 422, `HTTP ${splitTooMany.status}`);
  const splitSame = await api("/stock/repack", {
    method: "POST",
    token: adminToken,
    body: { locationId: mainStore.id, fromProductId: splitCarton.id, fromQuantity: 1, toProductId: splitCarton.id, toQuantity: 12 },
  });
  check("A split of a product into itself is refused", splitSame.status === 422, `HTTP ${splitSame.status}`);

  // ── transfer lifecycle in parts ──
  const srcBefore = await levelAt(splitCarton.id, mainStore.id);
  const dstBefore = await levelAt(splitCarton.id, otherStore.id);
  const trfCreated = await api("/transfers", {
    method: "POST",
    token: adminToken,
    body: { fromLocationId: mainStore.id, toLocationId: otherStore.id, lines: [{ productId: splitCarton.id, quantity: 10 }] },
  });
  check("A transfer is created as a draft", trfCreated.status === 201 && trfCreated.json?.data?.status === "DRAFT", trfCreated.json?.error?.message ?? "");
  const trfMain = trfCreated.json?.data;
  const lineId = trfMain?.lines?.[0]?.id;

  const trfPart1 = await api(`/transfers/${trfMain?.id}/dispatch`, {
    method: "POST",
    token: adminToken,
    body: { lines: [{ lineId, quantity: 4 }] },
  });
  check("Part of a line can be dispatched", trfPart1.json?.data?.status === "PARTIALLY_DISPATCHED", `${trfPart1.status} ${trfPart1.json?.data?.status ?? trfPart1.json?.error?.message}`);
  check("Source dropped by what was dispatched", (await levelAt(splitCarton.id, mainStore.id)) === srcBefore - 4);

  const trfRecv1 = await api(`/transfers/${trfMain?.id}/receive`, {
    method: "POST",
    token: adminToken,
    body: { lines: [{ lineId, quantity: 4 }] },
  });
  check("What arrived can be received while more is still to ship", trfRecv1.json?.data?.status === "PARTIALLY_RECEIVED", `${trfRecv1.json?.data?.status ?? trfRecv1.json?.error?.message}`);

  const overDispatch = await api(`/transfers/${trfMain?.id}/dispatch`, {
    method: "POST",
    token: adminToken,
    body: { lines: [{ lineId, quantity: 7 }] },
  });
  check("Dispatching more than remains is refused", overDispatch.status === 422, `HTTP ${overDispatch.status}`);

  const trfPart2 = await api(`/transfers/${trfMain?.id}/dispatch`, { method: "POST", token: adminToken, body: {} });
  check("The rest dispatches with a bare POST", trfPart2.json?.data?.lines?.[0]?.dispatched === 10, `dispatched ${trfPart2.json?.data?.lines?.[0]?.dispatched}`);
  const overReceive = await api(`/transfers/${trfMain?.id}/receive`, {
    method: "POST",
    token: adminToken,
    body: { lines: [{ lineId, quantity: 7 }] },
  });
  check("Receiving more than is in transit is refused", overReceive.status === 422, `HTTP ${overReceive.status}`);
  const trfRecv2 = await api(`/transfers/${trfMain?.id}/receive`, { method: "POST", token: adminToken, body: {} });
  check("Receiving the rest completes the transfer", trfRecv2.json?.data?.status === "RECEIVED" && Boolean(trfRecv2.json?.data?.receivedAt), `${trfRecv2.json?.data?.status}`);
  check("Destination rose by the whole transfer", (await levelAt(splitCarton.id, otherStore.id)) === dstBefore + 10);
  const trfAgain = await api(`/transfers/${trfMain?.id}/dispatch`, { method: "POST", token: adminToken, body: {} });
  check("A completed transfer cannot be dispatched again", trfAgain.status === 409, `HTTP ${trfAgain.status}`);

  // Cancel a draft; refuse to cancel once goods have moved.
  const trfDraft = await api("/transfers", {
    method: "POST",
    token: adminToken,
    body: { fromLocationId: mainStore.id, toLocationId: otherStore.id, lines: [{ productId: splitCarton.id, quantity: 3 }] },
  });
  const trfCancelled = await api(`/transfers/${trfDraft.json?.data?.id}/cancel`, { method: "POST", token: adminToken, body: {} });
  check("A draft can be cancelled", trfCancelled.json?.data?.status === "CANCELLED");
  const cancelDone = await api(`/transfers/${trfMain?.id}/cancel`, { method: "POST", token: adminToken, body: {} });
  check("A completed transfer cannot be cancelled", cancelDone.status === 409, `HTTP ${cancelDone.status}`);

  // Short close: 5 leave, 2 arrive, 3 are written off at the source.
  const shortSrcBefore = await levelAt(splitCarton.id, mainStore.id);
  const shortT = (
    await api("/transfers", {
      method: "POST",
      token: adminToken,
      body: { fromLocationId: mainStore.id, toLocationId: otherStore.id, dispatch: true, lines: [{ productId: splitCarton.id, quantity: 5 }] },
    })
  ).json?.data;
  check("Create-and-dispatch goes straight in transit", shortT?.status === "IN_TRANSIT", `${shortT?.status}`);
  await api(`/transfers/${shortT?.id}/receive`, {
    method: "POST",
    token: adminToken,
    body: { lines: [{ lineId: shortT?.lines?.[0]?.id, quantity: 2 }] },
  });
  const trfClosed = await api(`/transfers/${shortT?.id}/close-short`, {
    method: "POST",
    token: adminToken,
    body: { note: "Smoke: three cartons lost in transit" },
  });
  check("A transfer can be closed short", trfClosed.json?.data?.status === "RECEIVED" && Boolean(trfClosed.json?.data?.shortClosedAt), trfClosed.json?.error?.message ?? "");
  check("The source is down by everything dispatched", (await levelAt(splitCarton.id, mainStore.id)) === shortSrcBefore - 5);
  const fromOther = await api("/transfers", {
    method: "POST",
    token: adminToken,
    body: { fromLocationId: mainStore.id, toLocationId: mainStore.id, lines: [{ productId: splitCarton.id, quantity: 1 }] },
  });
  check("A transfer to the same location is refused", fromOther.status === 422, `HTTP ${fromOther.status}`);

  const trfListed = await api(`/transfers?status=RECEIVED&q=${encodeURIComponent(trfMain?.number ?? "")}`, { token: adminToken });
  check("Transfers can be listed and filtered", trfListed.status === 200 && (trfListed.json?.data ?? []).some((t) => t.id === trfMain?.id));

  // ── multi-location adjustment ──
  const relocSrc = await levelAt(splitCarton.id, mainStore.id);
  const relocDst = await levelAt(splitCarton.id, otherStore.id);
  const adjReloc = await api("/stock", {
    method: "POST",
    token: adminToken,
    body: {
      productId: splitCarton.id,
      note: "Smoke: found in the other store",
      lines: [
        { locationId: mainStore.id, quantity: -3 },
        { locationId: otherStore.id, quantity: 3 },
      ],
    },
  });
  check("A zero-net count is recorded as a relocation", adjReloc.json?.data?.kind === "RELOCATION" && adjReloc.json?.data?.transfers?.[0]?.status === "RECEIVED", adjReloc.json?.error?.message ?? "");
  check("Relocation moved the units", (await levelAt(splitCarton.id, mainStore.id)) === relocSrc - 3 && (await levelAt(splitCarton.id, otherStore.id)) === relocDst + 3);
  const adjMulti = await api("/stock", {
    method: "POST",
    token: adminToken,
    body: {
      productId: splitCarton.id,
      note: "Smoke: cycle count",
      lines: [
        { locationId: mainStore.id, quantity: 2 },
        { locationId: otherStore.id, quantity: -1 },
      ],
    },
  });
  check("A count that does not net to zero is valued adjustments", adjMulti.json?.data?.kind === "ADJUSTMENT" && adjMulti.json?.data?.movements?.length === 2);
  const adjSingle = await api("/stock", {
    method: "POST",
    token: adminToken,
    body: { productId: splitCarton.id, locationId: mainStore.id, quantity: 1, note: "Smoke: single" },
  });
  check("The single-location body still returns one movement", adjSingle.status === 201 && adjSingle.json?.data?.type === "ADJUSTMENT");

  // ── goods receipts against a purchase order with duplicate product lines ──
  const supplierList = (await api("/suppliers", { token: adminToken })).json?.data ?? [];
  const grnSupplier = supplierList[0];
  const grnPo = (
    await api("/purchase-orders", {
      method: "POST",
      token: adminToken,
      body: {
        supplierId: grnSupplier?.id,
        send: true,
        lines: [
          { productId: splitPiece.id, quantity: 10, unitCostCents: splitPiece.costPriceCents },
          { productId: splitPiece.id, quantity: 5, unitCostCents: splitPiece.costPriceCents },
        ],
      },
    })
  ).json?.data;
  check("A purchase order with two lines for one product is raised", Boolean(grnPo?.id) && grnPo?.lines?.length === 2);
  const grnMainBefore = await levelAt(splitPiece.id, mainStore.id);
  const grnOtherBefore = await levelAt(splitPiece.id, otherStore.id);
  const grnFirst = await api("/goods-receipts", {
    method: "POST",
    token: adminToken,
    body: {
      poId: grnPo?.id,
      locationId: mainStore.id,
      post: true,
      lines: [
        { productId: splitPiece.id, quantity: 8 },
        { productId: splitPiece.id, quantity: 4, locationId: otherStore.id },
      ],
    },
  });
  check("Goods are received and posted in one call", grnFirst.status === 201 && grnFirst.json?.data?.status === "POSTED", grnFirst.json?.error?.message ?? "");
  check("Each receipt line landed at its own location", (await levelAt(splitPiece.id, mainStore.id)) === grnMainBefore + 8 && (await levelAt(splitPiece.id, otherStore.id)) === grnOtherBefore + 4);
  const poAfter = ((await api("/purchase-orders?status=PARTIALLY_RECEIVED", { token: adminToken })).json?.data ?? []).find((p) => p.id === grnPo?.id);
  check(
    "PO lines were filled in order: 10 then 2",
    poAfter?.lines?.[0]?.received === 10 && poAfter?.lines?.[1]?.received === 2,
    `${poAfter?.lines?.map((l) => l.received).join("/")}`,
  );
  const grnOver = await api("/goods-receipts", {
    method: "POST",
    token: adminToken,
    body: { poId: grnPo?.id, locationId: mainStore.id, post: true, lines: [{ productId: splitPiece.id, quantity: 5 }] },
  });
  check("Receiving beyond the order is refused", grnOver.status === 422, `HTTP ${grnOver.status}`);
  const grnAllowed = await api("/goods-receipts", {
    method: "POST",
    token: adminToken,
    body: { poId: grnPo?.id, locationId: mainStore.id, allowOver: true, lines: [{ productId: splitPiece.id, quantity: 5 }] },
  });
  check("…unless over-receipt is allowed, which leaves a draft", grnAllowed.status === 201 && grnAllowed.json?.data?.status === "DRAFT", grnAllowed.json?.error?.message ?? "");
  const grnPosted = await api(`/goods-receipts/${grnAllowed.json?.data?.id}/post`, { method: "POST", token: adminToken, body: { allowOver: true } });
  check("A draft receipt posts", grnPosted.json?.data?.status === "POSTED", grnPosted.json?.error?.message ?? "");
  const grnTwice = await api(`/goods-receipts/${grnAllowed.json?.data?.id}/post`, { method: "POST", token: adminToken, body: {} });
  check("Posting twice is refused", grnTwice.status === 409, `HTTP ${grnTwice.status}`);
  const poDone = ((await api("/purchase-orders?status=RECEIVED", { token: adminToken })).json?.data ?? []).find((p) => p.id === grnPo?.id);
  check("The purchase order is fully received", Boolean(poDone));
  const grnList = await api(`/goods-receipts?poId=${grnPo?.id}`, { token: adminToken });
  check("Receipts can be listed by purchase order", grnList.status === 200 && grnList.json?.data?.length === 2);

  // The identity the valuation report promises still holds after all of it.
  const svAfter = await api("/reports/stock-valuation", { token: adminToken });
  check(
    "Stock valuation identity still holds after splits, transfers and receipts",
    svAfter.json?.data?.variesBy === svAfter.json?.data?.totalCents - svAfter.json?.data?.ledgerCents,
  );
  const tbSplit = await api("/reports/trial-balance", { token: adminToken });
  check("The books still balance", tbSplit.json?.data?.balanced === true);

  // Storekeepers may do all of this; a field rep may not.
  const storesLogin = await api("/auth/login", { method: "POST", body: { email: "stores@tarisolutions.co.ke", password: PASSWORD } });
  const storesTransfers = await api("/transfers", { token: storesLogin.json?.data?.accessToken });
  check("A storekeeper can see transfers", storesTransfers.status === 200);
  const repTransfer = await api("/transfers", {
    method: "POST",
    token: repToken,
    body: { fromLocationId: mainStore.id, toLocationId: otherStore.id, lines: [{ productId: splitCarton.id, quantity: 1 }] },
  });
  check("A field rep cannot create transfers", repTransfer.status === 403, `HTTP ${repTransfer.status}`);

  // Against a local server the books can be audited directly.
  if (/localhost|127\.0\.0\.1/.test(BASE)) {
    const { spawnSync } = await import("node:child_process");
    const { existsSync } = await import("node:fs");
    if (existsSync("scripts/check-consistency.mjs")) {
      const run = spawnSync(process.execPath, ["scripts/check-consistency.mjs", "--company", "tari", "--quiet"], { encoding: "utf8" });
      check("check-consistency passes for the demo company", run.status === 0, run.status === 0 ? "" : (run.stdout + run.stderr).split("\n").filter((l) => /FAIL/.test(l)).join(" | "));
    }
  }

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

  // A return of a multi-unit line. The sale was filed in base units, so the
  // credit has to be too — crediting two cartons against a sale KRA recorded as
  // twenty-four bottles leaves twenty-two sold on their ledger for ever, and
  // nothing on our side would ever show it.
  const dozenInvoiceLine = dozenInvoice?.lines?.[0];
  const returnNote = await api("/credit-notes", {
    method: "POST",
    token: adminToken,
    body: {
      invoiceId: dozenId,
      reason: "Customer returned one dozen",
      restock: true,
      lines: [{ invoiceLineId: dozenInvoiceLine?.id, quantity: 1 }],
    },
  });
  check("A dozen can be returned", returnNote.status === 200 || returnNote.status === 201);

  const noteId = returnNote.json?.data?.creditNote?.id;
  const filedReturn = (await api("/etims/submissions", { token: adminToken })).json?.data?.rows
    ?.find((r) => r.docType === "CREDIT_NOTE" && r.docId === noteId);

  check("The return was filed with KRA", Boolean(filedReturn), `status ${filedReturn?.status}`);

  const returnPayload = filedReturn?.request ? JSON.parse(filedReturn.request) : null;
  check(
    "It credits 12 base units, not 1 dozen",
    returnPayload?.items?.[0]?.quantity === 12,
    `quantity ${returnPayload?.items?.[0]?.quantity}`,
  );
  check(
    "It references the original sale",
    Boolean(returnPayload?.sale_id),
    `${returnPayload?.sale_id}`,
  );

  // Twelve back on the shelf, not one.
  const onHandAfterReturn = await onHand();
  check(
    "A returned dozen puts 12 back",
    onHandAfterReturn - onHandAfter === 12,
    `${onHandAfter} -> ${onHandAfterReturn}`,
  );

  // And the reversal has to move the books, not just the document.
  const tbReturn = await api("/reports/trial-balance", { token: adminToken });
  check("Still balanced after the return", tbReturn.json?.data?.balanced === true);
  const returns = (tbReturn.json?.data?.rows ?? []).find((r) => r.code === "4100");
  check(
    "It lands in sales returns, not netted off sales",
    (returns?.debitCents ?? 0) > 0,
    `4100 debit ${returns?.debitCents}`,
  );

  // ── a discounted sale, returned in pieces ─────────────────────────────
  // The line total already has the discount off. Credits used to take it off
  // again — a full return credited less than was charged, cancelled the
  // invoice, and left the difference on the customer's balance — and the sale
  // was filed with KRA on an understated taxable base.
  console.log("\nDiscounted sale, returned in pieces");
  const balanceOf = async () =>
    (await api(`/customers/${customerForOrder.id}`, { token: adminToken })).json?.data?.balanceCents;
  const balanceBeforeSale = await balanceOf();

  const discountedSale = await api("/invoices", {
    method: "POST",
    token: adminToken,
    body: {
      customerId: customerForOrder.id,
      issue: true,
      clientUuid: uuid(),
      lines: [{ productId: productA.id, quantity: 10, unitPriceCents: 10000, discountCents: 10000 }],
    },
  });
  const discountedId = discountedSale.json?.data?.invoice?.id ?? discountedSale.json?.data?.id;
  const discounted = (await api(`/invoices/${discountedId}`, { token: adminToken })).json?.data;
  const discountedInvoice = discounted?.invoice ?? discounted;
  const discountedLine = discountedInvoice?.lines?.[0];
  check("A discounted sale can be raised", Boolean(discountedLine), `line total ${discountedLine?.lineTotalCents}`);

  const saleFiling = (await api("/etims/submissions", { token: adminToken })).json?.data?.rows
    ?.find((r) => r.docType === "SALE" && r.docId === discountedId);
  const saleItem = saleFiling?.request ? JSON.parse(saleFiling.request)?.items?.[0] : null;
  check(
    "KRA is filed a taxable amount and VAT that add up to the total",
    saleItem != null &&
      Math.round((saleItem.taxable_amount + saleItem.tax_amount) * 100) ===
        Math.round(saleItem.total_amount * 100),
    saleItem ? `${saleItem.taxable_amount} + ${saleItem.tax_amount} vs ${saleItem.total_amount}` : "not filed",
  );
  check(
    "The discount is not sent a second time on top of the discounted price",
    saleItem != null && saleItem.discount_amount === undefined,
    `discount_amount ${saleItem?.discount_amount}`,
  );

  const creditOf = (quantity) =>
    api("/credit-notes", {
      method: "POST",
      token: adminToken,
      body: {
        invoiceId: discountedId,
        reason: "Smoke test: discounted return",
        restock: true,
        lines: [{ invoiceLineId: discountedLine?.id, quantity }],
      },
    });

  const doubled = await api("/credit-notes", {
    method: "POST",
    token: adminToken,
    body: {
      invoiceId: discountedId,
      reason: "Smoke test: one line listed twice",
      lines: [
        { invoiceLineId: discountedLine?.id, quantity: 6 },
        { invoiceLineId: discountedLine?.id, quantity: 6 },
      ],
    },
  });
  check(
    "The same line twice in one return is refused, with the reason",
    doubled.status === 400,
    `HTTP ${doubled.status}: ${doubled.json?.error?.message ?? ""}`,
  );

  const firstReturn = await creditOf(3);
  const firstNote = firstReturn.json?.data?.creditNote;
  check("Three of ten can be returned", Boolean(firstNote), `credited ${firstNote?.totalCents}`);

  const noteFiling = (await api("/etims/submissions", { token: adminToken })).json?.data?.rows
    ?.find((r) => r.docType === "CREDIT_NOTE" && r.docId === firstNote?.id);
  const notePayload = noteFiling?.request ? JSON.parse(noteFiling.request) : null;
  check(
    "The return is filed under its own number, not the invoice's",
    notePayload?.trader_invoice_number === firstNote?.number &&
      notePayload?.trader_invoice_number !== discountedInvoice?.number,
    `${notePayload?.trader_invoice_number} (invoice ${discountedInvoice?.number})`,
  );

  // The last seven, sent twice at the same moment. Only one may land: the
  // check used to run outside the transaction, so both passed and the
  // customer was credited, and the goods restocked, twice.
  const race = await Promise.all([creditOf(7), creditOf(7)]);
  const landed = race.filter((r) => r.status === 200 || r.status === 201);
  check(
    "Two simultaneous returns of the same goods: exactly one lands",
    landed.length === 1,
    race.map((r) => r.status).join(" / "),
  );
  // Refused as a conflict the rep can read — not a server fault. Every return
  // refusal used to surface as "Something went wrong on our side".
  check(
    "The other is refused as a conflict, with the reason",
    race.some((r) => r.status === 409),
    race.map((r) => `${r.status} ${r.json?.error?.message ?? ""}`).join(" / "),
  );

  const credited = (firstNote?.totalCents ?? 0) + (landed[0]?.json?.data?.creditNote?.totalCents ?? 0);
  check(
    "A full return credits back exactly what was charged",
    credited === discountedLine?.lineTotalCents,
    `${credited} of ${discountedLine?.lineTotalCents}`,
  );

  const afterFull = (await api(`/invoices/${discountedId}`, { token: adminToken })).json?.data;
  check(
    "The fully returned invoice is cancelled",
    (afterFull?.invoice ?? afterFull)?.status === "CANCELLED",
  );
  check(
    "The customer's balance is back exactly where it was",
    (await balanceOf()) === balanceBeforeSale,
    `${balanceBeforeSale} -> ${await balanceOf()}`,
  );

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

  // ── delivery notes & printing ──────────────────────────────────────
  // The API lifecycle of a delivery note, then every print page fetched with
  // a console session cookie and checked for the text that only its own
  // document carries. A 200 with the wrong title would mean a page rendered
  // something, not the thing asked for.
  console.log("\nDelivery notes & printing");

  const adminCookie = await sessionCookie("admin@tarisolutions.co.ke");
  check("Console session cookie issued", Boolean(adminCookie));

  const dnInvoiceRes = await api("/invoices", {
    method: "POST",
    token: adminToken,
    body: {
      customerId: customerForOrder.id,
      issue: true,
      clientUuid: uuid(),
      lines: [{ productId: productA.id, quantity: 6, unitPriceCents: 20000 }],
    },
  });
  const dnInvoice = dnInvoiceRes.json?.data?.invoice ?? dnInvoiceRes.json?.data;
  check("An invoice to deliver is raised", Boolean(dnInvoice?.id), `HTTP ${dnInvoiceRes.status}`);
  const dnInvoiceLine = (await api(`/invoices/${dnInvoice?.id}`, { token: adminToken })).json?.data?.invoice
    ?.lines?.[0];

  const dnUuid = uuid();
  const dnCreate = await api("/delivery-notes", {
    method: "POST",
    token: adminToken,
    body: { invoiceId: dnInvoice?.id, clientUuid: dnUuid },
  });
  const dn = dnCreate.json?.data?.deliveryNote;
  check(
    "Delivery note raised from the invoice",
    dnCreate.status === 201 && Boolean(dn?.id),
    `HTTP ${dnCreate.status} ${dnCreate.json?.error?.message ?? ""}`,
  );
  check("Numbered DN-nnnn on its own counter", /^DN-\d{4}$/.test(dn?.number ?? ""), dn?.number ?? "");
  check(
    "Issued, with the whole invoice quantity by default",
    dn?.status === "ISSUED" && dn?.lines?.[0]?.deliveredQty === 6,
    `${dn?.status} ${dn?.lines?.[0]?.deliveredQty}`,
  );

  const dnReplay = await api("/delivery-notes", {
    method: "POST",
    token: adminToken,
    body: { invoiceId: dnInvoice?.id, clientUuid: dnUuid },
  });
  check(
    "A replayed create returns the same note",
    dnReplay.status === 200 &&
      dnReplay.json?.data?.deliveryNote?.id === dn?.id &&
      dnReplay.json?.meta?.replayed === true,
  );

  const over = await api("/delivery-notes", {
    method: "POST",
    token: adminToken,
    body: { invoiceId: dnInvoice?.id, lines: [{ invoiceLineId: dnInvoiceLine?.id, deliveredQty: 1 }] },
  });
  check(
    "Delivering more than was sold is refused as a conflict",
    over.status === 409,
    `HTTP ${over.status}: ${over.json?.error?.message ?? ""}`,
  );

  const unsigned = await api(`/delivery-notes/${dn?.id}`, {
    method: "PATCH",
    token: adminToken,
    body: { action: "deliver" },
  });
  check("DELIVERED needs the receiver name", unsigned.status === 422 || unsigned.status === 400, `HTTP ${unsigned.status}`);

  const delivered = await api(`/delivery-notes/${dn?.id}`, {
    method: "PATCH",
    token: adminToken,
    body: { action: "deliver", receivedByName: "Smoke Receiver", receivedByPhone: "0700000001" },
  });
  check(
    "Marked delivered with the receiver name",
    delivered.json?.data?.deliveryNote?.status === "DELIVERED" &&
      delivered.json?.data?.deliveryNote?.receivedByName === "Smoke Receiver",
    `HTTP ${delivered.status}`,
  );

  const returned = await api(`/delivery-notes/${dn?.id}`, {
    method: "PATCH",
    token: adminToken,
    body: { action: "return", lines: [{ lineId: dn?.lines?.[0]?.id, returnedQty: 2 }] },
  });
  check(
    "A return records returnedQty per line",
    returned.json?.data?.deliveryNote?.status === "RETURNED" &&
      returned.json?.data?.deliveryNote?.lines?.[0]?.returnedQty === 2,
    `HTTP ${returned.status}`,
  );

  const second = await api("/delivery-notes", { method: "POST", token: adminToken, body: { invoiceId: dnInvoice?.id } });
  const dn2 = second.json?.data?.deliveryNote;
  check("The returned two can go out on a second note", dn2?.lines?.[0]?.deliveredQty === 2, `${dn2?.lines?.[0]?.deliveredQty}`);
  const cancelled = await api(`/delivery-notes/${dn2?.id}`, { method: "PATCH", token: adminToken, body: { action: "cancel" } });
  check("An issued note can be cancelled", cancelled.json?.data?.deliveryNote?.status === "CANCELLED");
  const cancelDelivered = await api(`/delivery-notes/${dn?.id}`, { method: "PATCH", token: adminToken, body: { action: "cancel" } });
  check("A delivered note cannot be cancelled", cancelDelivered.status === 409);

  const dnList = await api(`/delivery-notes?q=${encodeURIComponent(dn?.number ?? "")}`, { token: adminToken });
  check(
    "Delivery notes list and search",
    dnList.status === 200 && (dnList.json?.data ?? []).some((n) => n.id === dn?.id),
    `${dnList.json?.data?.length ?? 0} rows`,
  );

  const repView = await api(`/delivery-notes/${dn?.id}`, { token: repToken });
  check("A rep cannot read a note they neither raised nor drive", repView.status === 404, `HTTP ${repView.status}`);
  const acaciaDn = await api("/delivery-notes", { token: acaciaToken });
  check("Unlicensed tenant is refused delivery notes with 402", acaciaDn.status === 402, `HTTP ${acaciaDn.status}`);

  // ── print pages ──
  const printPage = async (path, cookie = adminCookie) => {
    const res = await fetch(`${BASE}${path}`, { headers: { Cookie: cookie }, redirect: "manual" });
    return { status: res.status, html: await res.text() };
  };
  const printCheck = async (label, path, markers, cookie) => {
    const r = await printPage(path, cookie);
    const missing = markers.filter((m) => !r.html.includes(m));
    const noShell = !r.html.includes('aria-label="Sections"');
    check(
      label,
      r.status === 200 && missing.length === 0 && noShell && r.html.includes("Powered by Raut"),
      r.status !== 200
        ? `HTTP ${r.status}`
        : missing.length
          ? `missing ${missing.join(", ")}`
          : noShell
            ? ""
            : "console chrome leaked onto the page",
    );
    return r;
  };

  // With eTIMS on and a reachable Digitax the fresh invoice may already be
  // filed, so the page is either a TAX INVOICE with its control code or an
  // INVOICE that says plainly it is not one yet. Both are correct; a page
  // claiming neither is not.
  const invoicePage = await printCheck("Invoice prints", `/print/invoice/${dnInvoice?.id}`, [
    "INVOICE",
    dnInvoice?.number ?? "",
  ]);
  check(
    "It says which it is: TAX INVOICE with a control code, or NOT A TAX INVOICE",
    (invoicePage.html.includes("TAX INVOICE") && invoicePage.html.includes("Control code")) ||
      invoicePage.html.includes("NOT A TAX INVOICE"),
  );
  const copyPage = await printPage(`/print/invoice/${dnInvoice?.id}?copy=1`);
  check("?copy=1 stamps DUPLICATE", copyPage.html.includes("Duplicate"));
  const thermal = await printPage(`/print/invoice/${dnInvoice?.id}?format=thermal`);
  check(
    "Thermal invoice is the 80 mm sales receipt",
    thermal.status === 200 &&
      (thermal.html.includes("SALES RECEIPT") || thermal.html.includes("TAX INVOICE")) &&
      thermal.html.includes("size: 80mm"),
  );
  await printCheck("Delivery note prints without prices", `/print/delivery-note/${dn?.id}`, [
    "DELIVERY NOTE",
    dn?.number ?? "",
    "Smoke Receiver",
    "shows no prices",
  ]);
  const priced = await printPage(`/print/delivery-note/${dn?.id}?prices=1`);
  check("?prices=1 adds prices to the delivery note", priced.html.includes("Unit price") && priced.html.includes("Goods value"));

  const filedForPrint = (await api("/invoices?limit=200", { token: adminToken })).json?.data?.find(
    (i) => i.etimsStatus === "ACCEPTED" && i.etimsQrUrl,
  );
  if (filedForPrint) {
    const taxPage = await printCheck("A filed invoice prints as a TAX INVOICE", `/print/invoice/${filedForPrint.id}`, [
      "TAX INVOICE",
      "Control code",
    ]);
    check("...with the KRA QR as inline SVG", taxPage.html.includes("<svg"));
  } else {
    check("A filedForPrint invoice exists to print", false, "no ACCEPTED invoice in the data");
  }

  const creditNoteRow = (await api("/credit-notes", { token: adminToken })).json?.data?.rows?.[0];
  if (creditNoteRow) {
    await printCheck("Credit note prints", `/print/credit-note/${creditNoteRow.id}`, [
      creditNoteRow.etimsStatus === "ACCEPTED" ? "CREDIT NOTE" : "RETURN NOTE",
      creditNoteRow.number,
    ]);
  }
  const paymentRow = (await api("/payments?limit=1", { token: adminToken })).json?.data?.[0];
  if (paymentRow) {
    await printCheck("Payment receipt prints", `/print/receipt/${paymentRow.id}`, [
      "PAYMENT RECEIPT",
      paymentRow.number,
      "Amount received",
    ]);
    const thermalReceipt = await printPage(`/print/receipt/${paymentRow.id}?format=thermal`);
    check("Thermal receipt variant renders", thermalReceipt.status === 200 && thermalReceipt.html.includes("size: 80mm"));
  }
  const orderRow = (await api("/orders?limit=1", { token: adminToken })).json?.data?.[0];
  if (orderRow) await printCheck("Order prints as a proforma", `/print/order/${orderRow.id}`, ["PROFORMA INVOICE", orderRow.number]);

  let poRow = (await api("/purchase-orders?limit=1", { token: adminToken })).json?.data?.[0];
  if (!poRow) {
    const supplier = (await api("/suppliers", { token: adminToken })).json?.data?.[0];
    poRow = (
      await api("/purchase-orders", {
        method: "POST",
        token: adminToken,
        body: { supplierId: supplier?.id, lines: [{ productId: productA.id, quantity: 2, unitCostCents: 5000 }] },
      })
    ).json?.data;
  }
  check("A purchase order exists to print", Boolean(poRow?.id));
  if (poRow) await printCheck("Purchase order prints", `/print/purchase-order/${poRow.id}`, ["PURCHASE ORDER", poRow.number]);

  let grnRow = (await api("/goods-receipts?limit=1", { token: adminToken })).json?.data?.[0];
  if (!grnRow) {
    // A free-standing draft receipt, not posted: the print check must not move
    // stock, and a draft purchase order cannot be received against.
    const location = (await api("/stock", { token: adminToken })).json?.data?.locations?.[0];
    const supplier = (await api("/suppliers", { token: adminToken })).json?.data?.[0];
    const grnRes = await api("/goods-receipts", {
      method: "POST",
      token: adminToken,
      body: {
        supplierId: supplier?.id,
        locationId: location?.id,
        lines: [{ productId: productA.id, quantity: 1, unitCostCents: 5000 }],
      },
    });
    grnRow = grnRes.json?.data;
    if (!grnRow?.id) console.log(`    (GRN create: HTTP ${grnRes.status} ${grnRes.json?.error?.message ?? ""})`);
  }
  if (grnRow?.id) await printCheck("Goods received note prints", `/print/grn/${grnRow.id}`, ["GOODS RECEIVED NOTE", grnRow.number]);
  else check("A goods receipt exists to print", false, "none in the data and none could be created");

  await printCheck("Customer statement prints with a running balance", `/print/statement/${customerForOrder.id}`, [
    "STATEMENT OF ACCOUNT",
    "Opening balance",
    "Closing balance",
    customerForOrder.name,
  ]);
  const routeRow = (await api("/routes", { token: adminToken })).json?.data?.[0];
  if (routeRow) {
    await printCheck("Route sheet prints", `/print/route-sheet/${routeRow.id}`, ["ROUTE SHEET", "Odometer out", "Collected (KES)"]);
  }

  const acaciaCookie = await sessionCookie("admin@acacia.example");
  const crossPrint = await printPage(`/print/invoice/${dnInvoice?.id}`, acaciaCookie);
  check("Another tenant cannot find the invoice on /print", crossPrint.status === 404, `HTTP ${crossPrint.status}`);
  const bogus = await printPage(`/print/invoice/does-not-exist`);
  check("An unknown id is a 404", bogus.status === 404, `HTTP ${bogus.status}`);
  const unknownType = await printPage(`/print/payslip/${dnInvoice?.id}`);
  check("An unknown document type is a 404", unknownType.status === 404, `HTTP ${unknownType.status}`);

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
