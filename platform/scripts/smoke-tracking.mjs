/**
 * End-to-end proof of vehicle tracking and the tracker API, against a running
 * server. Plays both sides: an admin issuing keys and matching devices, and a
 * tracker platform posting positions.
 *
 *   node scripts/smoke-tracking.mjs [baseUrl]
 *
 * Creates its own vehicles and keys, and revokes the keys when done.
 */

const BASE = process.argv[2] ?? "http://localhost:3200";
const API = `${BASE}/api/v1`;
const PASSWORD = "Raut@2026";

let passed = 0;
let failed = 0;
const failures = [];

function check(name, ok, detail = "") {
  if (ok) {
    passed++;
    console.log(`    ✓ ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`    ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function call(path, { method = "GET", token, key, body, raw, headers = {} } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(key ? { "X-Api-Key": key } : {}),
      ...headers,
    },
    ...(raw !== undefined ? { body: raw } : body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json, data: json?.data, code: json?.error?.code };
}

async function signIn(email) {
  const res = await call("/auth/login", { method: "POST", body: { email, password: PASSWORD } });
  if (res.status !== 200) throw new Error(`Could not sign in as ${email}: ${res.status}`);
  return res.data.accessToken;
}

const uid = Date.now().toString(36).toUpperCase();
const minutesAgo = (m) => new Date(Date.now() - m * 60_000).toISOString();

async function main() {
  const admin = await signIn("admin@tarisolutions.co.ke");
  const sales = await signIn("sales@tarisolutions.co.ke");
  const accounts = await signIn("accounts@tarisolutions.co.ke");
  const rep = await signIn("rep@tarisolutions.co.ke");

  const plate = `TRK ${uid.slice(-5)}`;
  const plateB = `TRB ${uid.slice(-5)}`;
  const vehicle = (await call("/vehicles", { method: "POST", token: admin, body: { plate, make: "Toyota", model: "Hiace" } })).data;
  const vehicleB = (await call("/vehicles", { method: "POST", token: admin, body: { plate: plateB } })).data;
  const imei = `35${uid}01`;
  const imeiB = `35${uid}02`;

  console.log("\n  Who may manage trackers");
  const salesKey = await call("/tracking/integrations", { method: "POST", token: sales, body: { name: "Nope" } });
  check("A sales manager cannot issue an API key", salesKey.status === 403, String(salesKey.status));
  const repList = await call("/tracking/integrations", { token: rep });
  check("A field rep cannot list API keys", repList.status === 403, String(repList.status));
  const anonList = await call("/tracking/integrations");
  check("Anonymous cannot list API keys", anonList.status === 401, String(anonList.status));
  const accountsLive = await call("/vehicles/live", { token: accounts });
  check("An accountant cannot follow the fleet", accountsLive.status === 403, String(accountsLive.status));

  console.log("\n  Issuing a key");
  const created = await call("/tracking/integrations", { method: "POST", token: admin, body: { name: `Smoke ${uid}`, provider: "GENERIC" } });
  check("An admin can issue a key", created.status === 201, String(created.status));
  const key = created.data?.apiKey;
  const integrationId = created.data?.id;
  check("The key is returned once, in full", typeof key === "string" && key.startsWith("rtk_") && key.length > 40);
  const listed = await call("/tracking/integrations", { token: admin });
  const row = listed.data?.find((i) => i.id === integrationId);
  check("A listing shows the prefix", row?.keyPrefix === key?.slice(0, 12));
  check("A listing never carries the key or its hash", !JSON.stringify(listed.json).includes(key) && !JSON.stringify(listed.json).includes("keyHash"));

  console.log("\n  Authenticating a tracker");
  const fix = (over = {}) => ({ deviceId: imei, latitude: -1.2864, longitude: 36.8172, recordedAt: minutesAgo(10), ...over });
  const noKey = await call("/tracking/ingest", { method: "POST", body: { positions: [fix()] } });
  check("No key is refused", noKey.status === 401 && noKey.code === "API_KEY_REQUIRED", `${noKey.status} ${noKey.code}`);
  const badKey = await call("/tracking/ingest", { method: "POST", key: "rtk_not-a-real-key", body: { positions: [fix()] } });
  check("A wrong key is refused", badKey.status === 401 && badKey.code === "INVALID_API_KEY", `${badKey.status} ${badKey.code}`);
  const userToken = await call("/tracking/ingest", { method: "POST", token: admin, body: { positions: [fix()] } });
  check("A user's session token is not a tracker key", userToken.status === 401, String(userToken.status));
  const test = await call("/tracking/ingest", { key });
  check("A GET tests the connection", test.status === 200 && test.data?.connected === true && test.data?.company?.length > 0, String(test.status));
  const viaBearer = await call("/tracking/ingest", { headers: { Authorization: `Bearer ${key}` } });
  check("The key also works as a bearer token", viaBearer.status === 200, String(viaBearer.status));

  console.log("\n  A device's first report");
  const first = await call("/tracking/ingest", { method: "POST", key, body: { positions: [fix()] } });
  check("An unknown device is accepted as unassigned", first.status === 200 && first.data?.unassigned === 1 && first.data?.accepted === 0, JSON.stringify(first.data));
  check("The reply names it", first.data?.unassignedDevices?.includes(imei));
  const unassigned = await call(`/tracking/devices?assigned=false&q=${imei}`, { token: admin });
  const device = unassigned.data?.[0];
  check("It appears for the admin, with its position", device?.externalId === imei && device?.lastLatitude === -1.2864);
  check("It is linked to the key that reported it", device?.integrationId === integrationId);

  console.log("\n  Assigning a device");
  const assign = await call(`/tracking/devices/${device?.id}`, { method: "PATCH", token: admin, body: { vehicleId: vehicle?.id, label: "Dash" } });
  check("An admin can assign it to a vehicle", assign.status === 200 && assign.data?.vehicle?.plate === plate, String(assign.status));
  const salesAssign = await call(`/tracking/devices/${device?.id}`, { method: "PATCH", token: sales, body: { vehicleId: null } });
  check("A sales manager cannot reassign it", salesAssign.status === 403, String(salesAssign.status));
  const second = await call("/tracking/devices", { method: "POST", token: admin, body: { externalId: imeiB, vehicleId: vehicle?.id } });
  check("A vehicle cannot take a second tracker", second.status === 409, String(second.status));
  const dupId = await call("/tracking/devices", { method: "POST", token: admin, body: { externalId: imei } });
  check("A device id is unique within the company", dupId.status === 409, String(dupId.status));
  const foreign = await call(`/tracking/devices/${device?.id}`, { method: "PATCH", token: admin, body: { vehicleId: "not-a-vehicle" } });
  check("An unknown vehicle is refused", foreign.status === 400, String(foreign.status));
  const registered = await call("/tracking/devices", { method: "POST", token: admin, body: { externalId: imeiB, vehicleId: vehicleB?.id } });
  check("A device can be registered by hand ahead of its first report", registered.status === 201, String(registered.status));

  console.log("\n  Positions");
  // A drive north ending now: ten fixes a minute apart, speed in km/h.
  const drive = Array.from({ length: 10 }, (_, i) =>
    fix({
      latitude: -1.3 + i * 0.002,
      longitude: 36.8,
      recordedAt: minutesAgo(9 - i),
      speedKmh: 45,
      heading: 0,
      ignition: true,
      batteryPct: 90,
      accuracyM: 5,
      odometerKm: 90_000 + i,
    }),
  );
  const batch = await call("/tracking/ingest", { method: "POST", key, body: { positions: drive } });
  check("A batch is stored", batch.status === 200 && batch.data?.accepted === 10, JSON.stringify(batch.data));
  const resend = await call("/tracking/ingest", { method: "POST", key, body: { positions: drive } });
  check("Resending it stores nothing twice", resend.data?.accepted === 0 && resend.data?.duplicates === 10, JSON.stringify(resend.data));
  const mixed = await call("/tracking/ingest", {
    method: "POST",
    key,
    body: {
      positions: [
        fix({ recordedAt: minutesAgo(30) }),
        fix({ latitude: 95 }),
        fix({ latitude: 0, longitude: 0 }),
        fix({ recordedAt: new Date(Date.now() + 3_600_000).toISOString() }),
        { latitude: -1, longitude: 36, recordedAt: minutesAgo(1) },
      ],
    },
  });
  check("One bad position does not lose the rest", mixed.status === 200 && mixed.data?.accepted === 1 && mixed.data?.rejected === 4, JSON.stringify(mixed.data));
  check("Each refusal says why", mixed.data?.rejections?.some((r) => r.reason === "TIMESTAMP_IN_FUTURE"));
  const garbage = await call("/tracking/ingest", { method: "POST", key, raw: "not json" });
  check("A body that is not JSON is refused", garbage.status === 400, String(garbage.status));
  const huge = await call("/tracking/ingest", { method: "POST", key, body: new Array(1001).fill(fix()) });
  check("An oversized batch is refused", huge.status === 413, String(huge.status));

  const traccar = await call("/tracking/ingest", {
    method: "POST",
    key,
    body: {
      device: { id: 1, uniqueId: imeiB, name: "Pick-up" },
      position: {
        deviceId: 1,
        latitude: -1.25,
        longitude: 36.75,
        speed: 20,
        course: 45,
        accuracy: 7,
        valid: true,
        fixTime: minutesAgo(1),
        attributes: { ignition: true, batteryLevel: 77 },
      },
    },
  });
  check("A Traccar forward is understood", traccar.status === 200 && traccar.data?.accepted === 1, JSON.stringify(traccar.data));

  const afterOdo = await call(`/vehicles/${vehicle?.id}`, { token: admin });
  check("The tracker's odometer reaches the vehicle", afterOdo.data?.odometerKm === 90_009, String(afterOdo.data?.odometerKm));
  await call("/tracking/ingest", { method: "POST", key, body: { positions: [fix({ recordedAt: minutesAgo(20), odometerKm: 5 })] } });
  const notWound = await call(`/vehicles/${vehicle?.id}`, { token: admin });
  check("A lower reading does not wind it back", notWound.data?.odometerKm === 90_009, String(notWound.data?.odometerKm));

  console.log("\n  Tracking a vehicle");
  const live = await call("/vehicles/live", { token: sales });
  check("A manager can follow the fleet", live.status === 200 && Array.isArray(live.data?.vehicles), String(live.status));
  const mine = live.data?.vehicles?.find((v) => v.id === vehicle?.id);
  check("The van shows its newest fix", Math.abs((mine?.fix?.latitude ?? 0) - -1.282) < 1e-6, String(mine?.fix?.latitude));
  check("It is reported as moving", mine?.status === "MOVING", mine?.status);
  check("Its speed is in km/h", mine?.fix?.speedKmh === 45, String(mine?.fix?.speedKmh));
  check("Its source is the tracker", mine?.fix?.source === "TRACKER", mine?.fix?.source);
  const other = live.data?.vehicles?.find((v) => v.id === vehicleB?.id);
  check("Traccar's knots arrive as km/h", other?.fix?.speedKmh === 37, String(other?.fix?.speedKmh));
  const silent = (await call("/vehicles", { method: "POST", token: admin, body: { plate: `TRS ${uid.slice(-5)}` } })).data;
  const refetched = await call("/vehicles/live", { token: sales });
  check("A van that never reported still appears", refetched.data?.vehicles?.find((v) => v.id === silent?.id)?.status === "NO_SIGNAL");

  // Nairobi calendar day, since that is the day the fixes are grouped under.
  const day = new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10);
  const track = await call(`/vehicles/${vehicle?.id}/track?date=${day}`, { token: sales });
  check("A vehicle's day can be read", track.status === 200 && track.data?.source === "TRACKER", String(track.status));
  check("It carries the trail", track.data?.points?.length >= 10, String(track.data?.points?.length));
  check("Distance is measured from the trail", track.data?.summary?.distanceM > 1800, String(track.data?.summary?.distanceM));
  check("Top speed is reported", track.data?.summary?.maxSpeedKmh === 45, String(track.data?.summary?.maxSpeedKmh));
  const badDate = await call(`/vehicles/${vehicle?.id}/track?date=2026-02-31`, { token: sales });
  check("A date that does not exist is refused", badDate.status === 400, String(badDate.status));
  const missing = await call(`/vehicles/nope/track?date=${day}`, { token: sales });
  check("An unknown vehicle is a 404", missing.status === 404, String(missing.status));

  console.log("\n  A field rep's view");
  const repLive = await call("/vehicles/live", { token: rep });
  check("A rep can call the endpoint", repLive.status === 200, String(repLive.status));
  check("A rep does not see another driver's van", !repLive.data?.vehicles?.some((v) => v.id === vehicle?.id));
  const repTrack = await call(`/vehicles/${vehicle?.id}/track?date=${day}`, { token: rep });
  check("A rep cannot read another van's trail", repTrack.status === 404, String(repTrack.status));
  const repId = JSON.parse(Buffer.from(rep.split(".")[1], "base64url").toString()).sub;
  const repVan = (await call("/vehicles", { method: "POST", token: admin, body: { plate: `TRR ${uid.slice(-5)}`, defaultRepId: repId } })).data;
  const repImei = `35${uid}03`;
  await call("/tracking/devices", { method: "POST", token: admin, body: { externalId: repImei, vehicleId: repVan?.id } });
  await call("/tracking/ingest", { method: "POST", key, body: { positions: [fix({ deviceId: repImei, recordedAt: minutesAgo(2), speedKmh: 30 })] } });
  const repOwn = await call("/vehicles/live", { token: rep });
  const repRow = repOwn.data?.vehicles?.find((v) => v.id === repVan?.id);
  check("A rep sees the van they drive", repRow?.fix?.source === "TRACKER", JSON.stringify(repRow?.fix ?? null));
  const repOwnTrack = await call(`/vehicles/${repVan?.id}/track?date=${day}`, { token: rep });
  check("A rep can read their own van's trail", repOwnTrack.status === 200 && repOwnTrack.data?.points?.length >= 1, String(repOwnTrack.status));
  await call(`/vehicles/${repVan?.id}`, { method: "PATCH", token: admin, body: { active: false } });
  const repAfter = await call("/vehicles/live", { token: rep });
  check("A retired van leaves the rep's list", !repAfter.data?.vehicles?.some((v) => v.id === repVan?.id));

  console.log("\n  Switching things off");
  const off = await call(`/tracking/devices/${device?.id}`, { method: "PATCH", token: admin, body: { active: false } });
  check("A device can be switched off", off.status === 200 && off.data?.active === false);
  const ignored = await call("/tracking/ingest", { method: "POST", key, body: { positions: [fix({ recordedAt: minutesAgo(0.5) })] } });
  check("Its reports are then ignored", ignored.data?.ignored === 1 && ignored.data?.accepted === 0, JSON.stringify(ignored.data));
  await call(`/tracking/devices/${device?.id}`, { method: "PATCH", token: admin, body: { active: true } });

  const rotated = await call(`/tracking/integrations/${integrationId}`, { method: "PATCH", token: admin, body: { rotate: true } });
  check("A key can be rotated", rotated.status === 200 && rotated.data?.apiKey?.startsWith("rtk_") && rotated.data.apiKey !== key);
  const oldKey = await call("/tracking/ingest", { key });
  check("The old key stops at once", oldKey.status === 401, String(oldKey.status));
  const newKey = await call("/tracking/ingest", { key: rotated.data?.apiKey });
  check("The new key works", newKey.status === 200, String(newKey.status));
  const revoked = await call(`/tracking/integrations/${integrationId}`, { method: "PATCH", token: admin, body: { active: false } });
  check("A key can be revoked", revoked.status === 200 && revoked.data?.active === false);
  const afterRevoke = await call("/tracking/ingest", { method: "POST", key: rotated.data?.apiKey, body: { positions: [fix()] } });
  check("A revoked key is refused", afterRevoke.status === 401, String(afterRevoke.status));

  console.log("\n  Tenant isolation");
  const platform = await signIn("admin@tariafrica.com");
  const platformDevice = await call(`/tracking/devices/${device?.id}`, { method: "PATCH", token: platform, body: { active: false } });
  check("A platform admin outside the company cannot touch a device", platformDevice.status === 403, String(platformDevice.status));

  // The seeded second company is licensed for routing only for these checks.
  const companies = await call("/platform/companies?q=acacia", { token: platform });
  const acacia = (Array.isArray(companies.data) ? companies.data : companies.data?.companies ?? []).find((c) => c.slug === "acacia");
  check("The second test company exists", Boolean(acacia?.id));
  const license = (enabled) =>
    call(`/platform/companies/${acacia?.id}/modules`, { method: "PUT", token: platform, body: { moduleKey: "ROUTING", enabled } });
  await license(true);
  try {
    const other = await signIn("admin@acacia.example");
    const before = await call(`/tracking/devices?q=${imei}`, { token: admin });

    const otherList = await call("/tracking/integrations", { token: other });
    check("Another company does not see this company's keys", otherList.status === 200 && !otherList.data?.some((i) => i.id === integrationId), String(otherList.status));
    const otherDevices = await call(`/tracking/devices?q=${imei}`, { token: other });
    check("Another company does not see this company's devices", otherDevices.status === 200 && otherDevices.data?.length === 0, JSON.stringify(otherDevices.data));
    const otherPatchDevice = await call(`/tracking/devices/${device?.id}`, { method: "PATCH", token: other, body: { active: false } });
    check("Another company cannot change this company's device", otherPatchDevice.status === 404, String(otherPatchDevice.status));
    const otherPatchKey = await call(`/tracking/integrations/${integrationId}`, { method: "PATCH", token: other, body: { rotate: true } });
    check("Another company cannot rotate this company's key", otherPatchKey.status === 404, String(otherPatchKey.status));
    const otherTrack = await call(`/vehicles/${vehicle?.id}/track?date=${day}`, { token: other });
    check("Another company cannot read this company's trail", otherTrack.status === 404, String(otherTrack.status));
    const otherLive = await call("/vehicles/live", { token: other });
    check("Another company's fleet leaves this one out", otherLive.status === 200 && !otherLive.data?.vehicles?.some((v) => v.id === vehicle?.id));

    const otherKey = (await call("/tracking/integrations", { method: "POST", token: other, body: { name: `Smoke ${uid}` } })).data;
    const sameImei = await call("/tracking/ingest", {
      method: "POST",
      key: otherKey?.apiKey,
      body: { positions: [fix({ latitude: -4.05, longitude: 39.66, recordedAt: minutesAgo(0.2) })] },
    });
    check("The same device id under another key stays in its own company", sameImei.data?.unassigned === 1 && sameImei.data?.accepted === 0, JSON.stringify(sameImei.data));
    const after = await call(`/tracking/devices?q=${imei}`, { token: admin });
    check("It does not move this company's device", after.data?.[0]?.lastLatitude === before.data?.[0]?.lastLatitude, String(after.data?.[0]?.lastLatitude));
    const otherDevice = (await call(`/tracking/devices?q=${imei}`, { token: other })).data?.[0];
    const stealVan = await call(`/tracking/devices/${otherDevice?.id}`, { method: "PATCH", token: other, body: { vehicleId: vehicleB?.id } });
    check("Another company cannot assign its device to this company's van", stealVan.status === 400, String(stealVan.status));

    await license(false);
    const unlicensed = await call("/tracking/ingest", { key: otherKey?.apiKey });
    check("A key stops when the company loses the routing licence", unlicensed.status === 402, String(unlicensed.status));
    await license(true);
    await call(`/tracking/integrations/${otherKey?.id}`, { method: "PATCH", token: other, body: { active: false } });
  } finally {
    await license(false);
  }

  // Clean up what shows on the fleet map.
  for (const v of [vehicle, vehicleB, silent]) {
    if (v?.id) await call(`/vehicles/${v.id}`, { method: "PATCH", token: admin, body: { active: false } });
  }

  console.log(`\n  ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log(`\n  Failures:\n${failures.map((f) => `    - ${f}`).join("\n")}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
