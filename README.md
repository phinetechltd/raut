# Raut — One Platform. Every Mile.

Multi-tenant ERP, CRM and field-sales platform by **Tari Africa Platforms
Limited**. First deployed for **Zamar Solutions Limited**, to the scope in
`Zamar_ERP_Proposal.pdf` (31 July 2026).

> **Raut is the product. Zamar Solutions is a customer on it.**
> The proposal (§9–12) has Tari Africa licensing this platform to many
> businesses, so it carries its own name rather than the first client's. Zamar
> Solutions Limited remains throughout as the seeded tenant — that is a real
> company with real data, not a placeholder to be renamed.

Two systems, one database, one permission model:

```
xos/
├── platform/          Next.js 15 · TypeScript · Prisma · SQLite
│   ├── web console    Super Admin + tenant back office
│   └── /api/v1        REST API consumed by the mobile app
├── mobile/
│   └── raut_field/     Flutter · offline-first field sales app
├── brand/             Logo assets
└── docs/              Implementation plan, architecture, API reference
```

---

## Quick start

```bash
cd xos/platform && npm install && npx prisma db push && npm run db:seed && npm run dev
```

The console is at <http://localhost:3200>. Then, in a second terminal:

```bash
cd xos/mobile/raut_field && flutter pub get && flutter run --dart-define=RAUT_API_BASE=http://10.0.2.2:3200
```

`10.0.2.2` is the Android emulator's route to your machine — inside the
emulator, `localhost` is the emulator itself. On a physical handset, use your
computer's LAN address.

### Sign-in accounts

All seeded accounts use the password `Raut@2026`.

| Account | Role | Sees |
| --- | --- | --- |
| `admin@tariafrica.com` | Super Admin | Platform: companies, licences, audit |
| `admin@zamarsolutions.co.ke` | Company Admin | Raut — all ten modules |
| `sales@zamarsolutions.co.ke` | Sales Manager | Territories, targets, field team |
| `accounts@zamarsolutions.co.ke` | Accountant | Invoices, payments, receivables |
| `stores@zamarsolutions.co.ke` | Storekeeper | Stock, transfers, goods received |
| `rep@zamarsolutions.co.ke` | Field Rep | **The mobile app** — James Mwangi |
| `admin@acacia.example` | Company Admin | Core platform only — proves the module gate |

That last account matters: Acacia has bought the core platform and none of the
ten modules. Signing in as them shows what the product looks like without them.

---

## What was built

### Core platform (proposal §2 — KES 160,000)

- **Multi-tenancy.** One instance, many companies. Every tenant row carries
  `companyId`, and scoping is derived from the authenticated principal in
  `src/lib/tenant.ts` — never from client input.
- **Super Admin.** Create and activate companies, license modules, monitor the
  platform, read the cross-tenant audit log.
- **ERP foundation.** Customers, products, suppliers, sales, stock, dashboards.
- **GPS & mapping.** Customer location capture, map pins, territory rendering.
- **Security.** Bcrypt credentials, short-lived JWTs, device-bound rotating
  refresh tokens, role-based access control, append-only audit trail, seat
  limits enforced at user creation.

### The ten modules (proposal §3 — KES 190,000)

| # | Module | Price | Where it lives |
| --- | --- | --- | --- |
| 01 | CRM & Customer Management | 25,000 | `/app/customers` |
| 02 | Sales & POS | 30,000 | `/app/sales` |
| 03 | Inventory Management | 25,000 | `/app/inventory` |
| 04 | Procurement & Suppliers | 20,000 | `/app/procurement` |
| 05 | Finance, Expenses & Receivables | 25,000 | `/app/finance` |
| 06 | Field Sales Management | 20,000 | `/app/field` + mobile |
| 07 | Smart Routing | 15,000 | `/app/routes` + mobile |
| 08 | Geofencing & Location Intel | 15,000 | `/app/routes` + mobile |
| 09 | SMS Communication | 10,000 | `/app/sms` |
| 10 | Advanced Reporting & Analytics | 5,000 | `/app/reports` |

**Module licensing is enforced at runtime, not just in the sales deck.** Each
module's routes return `402 MODULE_NOT_LICENSED` and its console pages render
an upgrade screen when the company has not bought it. A `COMPANY_ADMIN` still
cannot open Procurement if Raut never purchased Procurement.

### Mobile field sales app (proposal §6 — quoted separately)

Every capability listed on proposal page 12:

- GPS check-in with geofence verification, and background breadcrumb capture
- Smart routing — today's sequenced itinerary, held stable offline
- Offline order and payment capture
- Customer and visit management, including creating customers in the field
- Camera photo uploads attached to visits
- Automatic synchronisation on reconnect
- Native field-sales interface

---

## How the two systems connect

The mobile app is not a thin client. Between check-ins it is the system of
record, and sync reconciles it with the server:

1. **Push before pull.** Local work is authoritative until the server has it.
   Pulling first would overwrite an unsynced check-in with the server's older
   copy and lose it.
2. **Every write carries a client UUID** used as an idempotency key. A rep in a
   low-signal market *will* retry a batch; without the key, one order becomes
   two. Replays return the original record.
3. **The watermark is the server's clock**, never the handset's — a phone
   running fast would silently skip records written in the gap.
4. **Server ids and local ids never mix.** Offline-created records are prefixed
   `local:` until sync assigns a real id.

Verified by `npm run test:integration`, which drives the exact contract the
Flutter client speaks and then confirms the result renders in the console.

---

## Verification

```bash
cd xos/platform && npm run verify          # typecheck + 3 suites
cd xos/mobile/raut_field && flutter test  # unit, no device needed

# on-device, needs the platform running and an emulator/handset attached
flutter test integration_test/app_test.dart -d <device-id> \
  --dart-define=RAUT_API_BASE=http://10.0.2.2:3200
```

Every suite is repeatable — they create their own fixtures rather than
consuming seeded ones, so a second run passes as cleanly as the first.

### Platform

| Check | Result |
| --- | --- |
| `npm run typecheck` | clean |
| `next build` | all routes compiled |
| `test:smoke` — API, auth, tenancy, module gating | **48/48** |
| `test:pages` — every console page renders real content | **24/24** |
| `test:integration` — offline → sync → console | **35/35** |

### Mobile

| Check | Result |
| --- | --- |
| `flutter analyze` | no issues |
| `test/widget_test.dart` — money & geo arithmetic | **16/16** |
| `test/offline_store_test.dart` — offline store, outbox, repository | **28/28** |
| `integration_test/app_test.dart` — real device against a live platform | **9/9** |

The on-device suite was run on an Android 17 (API 37) emulator against a
running platform: it builds and installs the real APK, signs in, syncs, queues
work offline, drains it, and confirms a second sync resends nothing.

> **Rolling out to a handset that already has the pre-Raut build needs care.**
> The rebrand changed the `applicationId`, so Android installs Raut as a
> *second* app rather than upgrading — and the old one keeps its unsynced
> outbox. Drain the old app's queue before uninstalling it. See
> [`mobile/raut_field/README.md`](mobile/raut_field/README.md).

The unit tests pin the money and geo arithmetic that the handset and server
compute *independently*. If those diverge, a rep reads one figure to a
shopkeeper and the office invoices another. The offline-store tests cover what
only happens with no signal — queue ordering, idempotency, stuck entries,
optimistic balances — which is precisely what a hands-on demo cannot show.

---

## Known limitations

Stated plainly rather than left to be discovered:

- **SQLite serialises writes.** Chosen by the client for this build. Fine for a
  distributor with tens of concurrent users; it will not hold the "48 companies
  / 1,204 active users" figure illustrated on proposal page 5 under real load.
  No SQLite-specific constructs are used, so moving to Postgres is a provider
  swap plus a migration, not a rewrite.
- **Tokens are stored in SharedPreferences**, which is readable on a rooted
  handset. Mitigated server-side by short token lifetimes and revocable
  device-bound refresh tokens. Moving to the platform keystore is worthwhile
  hardening.
- **Visit photos are written to local disk** under `public/uploads`. Correct for
  a single-VPS deployment; a multi-instance deployment needs object storage.
  Only one route touches the filesystem, so this is a config change.
- **The maps are coordinate plots, not tile maps.** Basemap tiles require a
  Google or Mapbox contract, which the proposal excludes from the platform
  price. Pins, fences and route legs render accurately from stored coordinates.
- **The SMS module ships with a `console` adapter** that records messages
  without transmitting them, plus an Africa's Talking adapter that activates
  when credentials are supplied. A bulk SMS account is quoted separately.
- **The Super Admin dashboard omits the mockup's "96% Uptime SLA" tile.** There
  is no uptime probe in this system, and a hard-coded 96% would be a fabricated
  metric on an operations dashboard. Licensed platform value is shown instead.

## Out of scope

Per proposal §5 and §15, and **not built** — the seams exist, the integrations
do not: Digitax/eTIMS, accounting software sync, M-Pesa and card gateways,
WhatsApp Business API, live bulk-SMS accounts.

---

## Documentation

- [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md) — scope mapping, build order, decisions
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — tenancy, auth, sync contract, module gating
- [`docs/API.md`](docs/API.md) — every `/api/v1` endpoint

## Licensing

Per proposal §7 and §8: the platform is a Tari Africa-owned software product.
Payment for development does not transfer source code or intellectual property.
Zamar Solutions receives a commercial licence to the configured platform for up
to 50 users, enforced by the `seatLimit` on their company record.
