# Raut Field Sales — mobile app

Offline-first Flutter app for field sales reps. Talks to `xos/platform` over
`/api/v1`.

Covers everything on proposal page 12: GPS tracking with background location,
geofencing and smart routing, offline order capture, customer and visit
management, camera photo uploads, and automatic synchronisation.

---

## Running it

The platform must be running first:

```bash
cd ../../platform && npm run dev
```

Then, pointing the app at it:

```bash
flutter pub get
flutter run --dart-define=RAUT_API_BASE=http://10.0.2.2:3200
```

**`10.0.2.2` is not a typo.** Inside an Android emulator, `localhost` resolves
to the emulator itself, not your machine — that is the single most common
reason the app "cannot reach the server". On a physical handset, use your
computer's LAN address (e.g. `http://192.168.1.20:3200`) and make sure the
phone is on the same network.

The login screen displays the server it will call, so a misconfigured build is
visible rather than mysterious.

Sign in as `rep@zamarsolutions.co.ke` / `Raut@2026` (James Mwangi, the rep from
proposal page 9).

### Cleartext HTTP

`android/app/src/main/res/xml/network_security_config.xml` permits plain HTTP
**only** for `10.0.2.2`, `localhost` and `127.0.0.1`. Everything else must be
HTTPS. Do not add a production hostname to that list — reps carry customer
balances and payment records, and the fix for a plain-HTTP server is a
certificate on the server, not an exemption in the app.

---

## Testing

```bash
flutter test                    # unit — no device needed
flutter test integration_test/app_test.dart -d <device-id> \
  --dart-define=RAUT_API_BASE=http://10.0.2.2:3200
```

Three layers, each testing something the others cannot:

| Suite | Needs | Covers |
| --- | --- | --- |
| `test/widget_test.dart` | nothing | Money and geo arithmetic that the handset and server compute **independently** |
| `test/offline_store_test.dart` | nothing | The offline store and outbox against the real sqflite engine |
| `integration_test/app_test.dart` | device + running platform | The whole stack: HTTP, sqflite, sync engine, widget tree |

The integration suite writes real records — point it at a development
instance, never production.

### What the tests are actually guarding

**`widget_test.dart`** pins the arithmetic duplicated between
`lib/core/money.dart` and `src/lib/money.ts`. The duplication is deliberate —
the rep must see a total before the server sees the order — so if the two
drift, a rep reads one figure to a shopkeeper and the office invoices another.

**`offline_store_test.dart`** covers behaviour that only appears with no
signal, which is exactly what cannot be checked by hand during a demo: that
identical payloads still get distinct UUIDs (two genuine orders are two
orders), that the queue drains in the order the rep worked, that a rejected
entry is marked stuck rather than dropped, that a payment moves the balance
immediately, and that a `local:` id is never sent to the server as a reference.

**`app_test.dart`** proves the round trip on a real device: queue work
offline, reconnect, drain, and confirm nothing resends on a second pass.

---

## Layout

```
lib/
├── core/
│   ├── config.dart           --dart-define surface
│   ├── api_client.dart       HTTP + one automatic token refresh
│   ├── auth_service.dart     Session, licences, sign-out safety
│   ├── local_db.dart         sqflite mirror + outbox schema
│   ├── outbox.dart           The offline write queue
│   ├── sync_service.dart     Push-before-pull sync engine
│   ├── location_service.dart GPS fixes + background breadcrumbs
│   ├── geo.dart              Mirrors src/lib/geo.ts
│   └── money.dart            Mirrors src/lib/money.ts
├── data/field_repository.dart    Every read and local-first write
├── models/models.dart
├── screens/                  login, home, route, visit, order, payment, customers, more
├── widgets/sync_banner.dart
└── theme.dart
```

### The rules that keep offline data safe

1. **Push before pull.** Local work is authoritative until the server has it.
2. **Every write carries a client UUID** — the server's idempotency key. A
   replayed batch returns `duplicate`, which is success, not an error.
3. **The sync watermark is the server's clock**, stored verbatim.
4. **`local:` ids never leave the device.** References to one are omitted from
   payloads rather than sent.

Adding a new offline-capable action means adding an `OpType` constant in
`outbox.dart` **and** a matching case in the platform's `/api/v1/sync/push`
switch. Those strings are a contract; a mismatch queues work that will never
apply, silently.

---

## Upgrading from the pre-Raut build

The rebrand changed the `applicationId` from `co.ke.tariafrica.zamar_field` to
`com.raut.app`. **Android treats a changed applicationId as a
different app**, so:

- The new build will not upgrade an existing install — it installs alongside it.
  A rep who already has the old app ends up with two icons.
- The old app keeps its own local database, **including anything still in its
  outbox**. Uninstalling it discards that work permanently.

Before rolling this out to handsets that already have the old build:

```bash
# 1. On each device, open the OLD app and sync until the queue is empty.
# 2. Confirm nothing is pending, then remove it.
adb uninstall co.ke.tariafrica.zamar_field
```

There is no automatic data migration between the two package ids, and building
one is not worthwhile for a pre-release rename — but it must not be discovered
after a rep has a day of unsynced orders in the old app.

---

## Screenshots

`adb screencap` cannot read Flutter's hardware SurfaceView on the emulator — it
returns the window beneath, which is the splash screen. Capture through the
driver instead, which makes the engine rasterise its own frames:

```bash
flutter drive \
  --driver=test_driver/integration_test.dart \
  --target=integration_test/screenshots_test.dart \
  -d emulator-5554 --dart-define=RAUT_API_BASE=http://10.0.2.2:3200
```

Output lands in `screenshots/`.

**Reseed the platform first if the last seed was not today.** The seed places
"today's route" relative to when it ran, so a day-old database leaves the route
screen legitimately empty — which reads as a bug in a screenshot but is the
correct empty state:

```bash
cd ../../platform && npm run db:seed
```

---

## Troubleshooting

**`adb shell screencap` shows the splash screen, not the app.** On Android
emulators using GFXSTREAM, `screencap` often cannot read Flutter's hardware
`SurfaceView` and captures the window beneath it — usually the Android 12+
splash. The app is fine; the capture is not. Confirm the UI is really live
another way:

```bash
adb shell input tap 540 890                  # where the email field sits
adb shell dumpsys input_method | grep mInputShown   # true → UI is laid out and interactive
```

Or drive it and check the server: a sign-in through the UI appears in the
platform audit log as `LOGIN {"channel":"mobile"}` and registers a row in
`Device`. That is a stronger proof than a screenshot anyway.

**`am start -W` reports `Status: timeout`.** Same cause — the launch is
considered incomplete until a frame is reported. Check `adb logcat --pid=$(adb
shell pidof com.raut.app)` for a real Dart error before
assuming a crash; a healthy start logs `Using the Impeller rendering backend`
and `The Dart VM service is listening`.

**Everything is glacial.** Check host RAM. A leftover Gradle daemon holds
~1 GB and starves the emulator VM; `android/gradlew --stop` reclaims it.

---

## Known limitations

- **Tokens live in SharedPreferences**, readable on a rooted handset. Mitigated
  server-side by short access-token lifetimes and revocable, device-bound
  refresh tokens. Moving to the platform keystore is worthwhile hardening.
- **Deletes are not tombstoned.** Records are deactivated rather than removed,
  so the client sees the state change on the next pull. A hard delete would
  need a tombstone table.
- **Background location stops when Android kills the process.** A persistent
  foreground service would fix it and is not built here; the permission and
  buffer plumbing are in place for it.
- **Photos are queued as file paths**, so clearing the app cache before a sync
  loses unsent images. The row is dropped rather than retried forever.
