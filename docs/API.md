# API Reference — `/api/v1`

Base URL: `http://localhost:3200/api/v1` in development.

## Envelope

Every response uses one shape, so a client needs one parser:

```jsonc
// success
{ "ok": true, "data": { … }, "meta": { … } }

// failure
{ "ok": false, "error": { "code": "MODULE_NOT_LICENSED", "message": "…", "details": { … } } }
```

### Error codes

| HTTP | Code | Meaning |
| --- | --- | --- |
| 400 | `BAD_REQUEST` / `BAD_REFERENCE` | Malformed input, or a referenced record does not exist |
| 401 | `UNAUTHENTICATED` / `INVALID_CREDENTIALS` / `REFRESH_INVALID` | Sign in, or refresh |
| 402 | `MODULE_NOT_LICENSED` | The company has not bought this module — **not retryable** |
| 403 | `FORBIDDEN` / `TENANT_REQUIRED` / `ACCOUNT_INACTIVE` / `COMPANY_INACTIVE` | Role or tenancy |
| 404 | `NOT_FOUND` | Absent, *or* owned by another tenant — indistinguishable by design |
| 409 | `CONFLICT` | Duplicate record, or seat limit reached |
| 422 | `VALIDATION_FAILED` | Zod issues in `details.issues` |
| 503 | `UNHEALTHY` | Database unreachable |

`402` is the one worth handling specially: it means the feature was never
bought, so retrying or queueing the request will never succeed.

## Authentication

Send `Authorization: Bearer <accessToken>`. The console uses an HTTP-only
cookie instead; both decode to the same claims.

---

## Auth

### `POST /auth/login`

```jsonc
{
  "email": "rep@tarisolutions.co.ke",
  "password": "…",
  "device": {                        // omit for web; present for mobile
    "deviceId": "stable-install-id",
    "platform": "android",
    "model": "Tecno Spark 10",
    "appVersion": "1.0.0"
  }
}
```

Returns `accessToken`, `refreshToken` (only when `device` is sent), the user,
their company, **licensed `modules`**, and the effective `permissions` with
unlicensed-module permissions already stripped — so the client never renders a
button the server would refuse. Also `maps: { provider: "OSM" | "GOOGLE",
googleAvailable }` — the basemap the company's admin chose, which the handset's
Directions buttons follow. `/auth/me` returns the same block.

### `POST /auth/refresh`

`{ "refreshToken": "…" }` → a new pair. The old token is revoked in the
exchange; replaying it returns 401.

### `POST /auth/logout` · `GET /auth/me`

`/auth/me` re-reads live licences. The mobile app calls it on resume so a
module revoked overnight takes effect without waiting for token expiry.

---

## Sync — the mobile contract

### `GET /sync/pull?since=<ISO>&deviceId=<id>`

Omit `since` for a full bootstrap. Returns:

```jsonc
{
  "syncedAt": "2026-08-03T09:12:44.101Z",   // store this verbatim as the next watermark
  "bootstrap": true,
  "counts": { "customers": 8, "products": 10, … },
  "entities": {
    "customers": [ … ], "products": [ … ], "territories": [ … ],
    "stock": [ … ], "visits": [ … ], "routes": [ … ],   // routes carry nested stops
    "orders": [ … ], "invoices": [ … ], "payments": [ … ],
    "expenseCategories": [ … ]
  }
}
```

Notes that matter:

- **Store `syncedAt`, not the handset's clock.** A fast phone would skip records.
- Field reps receive only their own visits, routes and documents; managers
  receive the company's.
- Bootstrap is capped at a 90-day horizon — reps do not need last year's
  invoices offline, and pulling them makes first sync unusable on 3G.
- Deletes are not tombstoned. Records are deactivated, not removed.

### `POST /sync/push`

Drains the offline queue. Operations apply **in array order**, so a payment
against an order created earlier in the same batch resolves.

```jsonc
{
  "deviceId": "stable-install-id",
  "operations": [                      // max 200
    {
      "uuid": "client-generated-uuid",  // the idempotency key
      "type": "order.create",
      "at": "2026-08-03T08:31:00.000Z", // when the rep actually did it
      "payload": { … }
    }
  ]
}
```

Response reports each operation independently:

```jsonc
{
  "summary": { "total": 4, "applied": 4, "duplicates": 0, "failed": 0 },
  "results": [
    { "uuid": "…", "status": "applied",   "entityId": "cm…", "entityType": "SalesOrder" },
    { "uuid": "…", "status": "duplicate", "entityId": "cm…" },
    { "uuid": "…", "status": "failed",    "error": "Customer not found" }
  ]
}
```

**Treat `duplicate` as success** — it means an earlier attempt landed. That is
the entire point of the UUID.

#### Operation types

| Type | Payload |
| --- | --- |
| `visit.checkin` | `visitId`, `latitude`, `longitude`, `accuracyM?` |
| `visit.checkout` | `visitId`, `latitude?`, `longitude?`, `outcome?`, `notes?` |
| `visit.create` | `customerId`, `purpose?`, `scheduledAt?`, `notes?` |
| `order.create` | `customerId`, `lines[]`, `visitId?`, `note?` |
| `invoice.create` | `customerId`, `lines[]`, `locationId?`, `orderId?`, `visitId?` |
| `payment.create` | `customerId`, `amountCents`, `method?`, `reference?`, `visitId?` |
| `customer.create` | `name`, `phone?`, `town?`, `latitude?`, `longitude?`, … |
| `customer.update` | `id`, plus contact fields and GPS pin only |
| `activity.create` | `customerId`, `subject`, `body?`, `type?` |
| `expense.create` | `description`, `amountCents`, `categoryId?`, `latitude?` |
| `location.batch` | `pings[]` — breadcrumbs, batched as one operation; a resent batch stores nothing twice |
| `route.odometer` | `routeId`, `odometerStartKm?`, `odometerEndKm?` — dash readings for the rep's own route |

A line is `{ productId, quantity, unitPriceCents?, discountCents?, description? }`.
Omit price to use the catalogue price.

---

## Field operations

| Endpoint | Module | Notes |
| --- | --- | --- |
| `GET /visits` | 06 | `?status=&repId=&date=&customerId=` |
| `POST /visits` | 06 | Reps may only schedule for themselves |
| `POST /visits/:id/check-in` | 06+08 | Returns the verification verdict |
| `POST /visits/:id/check-out` | 06 | Derives duration, closes the route stop |
| `GET`/`POST /visits/:id/photos` | 06 | Base64 JPEG, 4 MB cap |
| `GET /routes?today=true` | 07 | The mobile home screen's one call; carries `vehicle` |
| `POST /routes` | 07 | Builds and sequences; optionally creates visits; `vehicleId?` (defaults to the rep's usual vehicle) |
| `GET`/`PATCH /routes/:id` | 07 | `PATCH` takes `vehicleId` (managers) and `odometerStartKm`/`odometerEndKm` (reps on their own route) |
| `POST /routes/:id/resequence` | 07 | Re-orders the stops still outstanding from `{latitude, longitude}` — or the rep's last breadcrumb when the body is empty |
| `PATCH /routes/:id/stops/:stopId` | 07 | `{ status: "SKIPPED", skipReason }` only; the visit becomes MISSED. ARRIVED/DONE come from check-in/out |
| `GET`/`POST /vehicles`, `GET`/`PATCH /vehicles/:id` | 07 | `vehicle:read` / `vehicle:write`; `?q=&active=`; plate unique per company; `active:false` retires |
| `GET /geofence/events` | 08 | Read-only — written by check-in, never by a client |
| `GET`/`POST /location/pings` | 08 | Breadcrumbs; `POST` accepts up to 500. `GET ?userId=&vehicleId=&routeId=&date=` drops fixes worse than 100 m and thins to ≤ 2000 points |
| `GET /location/latest` | 08 | One row per rep: last fix since midnight, vehicle, staleness, speed, battery, route progress |

### Vehicle tracking

Breadcrumbs arrive knowing nothing about routes. The server stamps each with
the rep's route for that day (and so the vehicle) as it lands, and rows are
unique per rep per instant — a handset that retries a batch cannot double the
trail. When a route completes, the distance actually driven is summed from its
breadcrumbs into `actualDistanceM`, next to the planned `totalDistanceM`.

```jsonc
// GET /location/latest
{
  "asOf": "2026-11-04T09:12:44.101Z",
  "positions": [
    {
      "userId": "cm…", "repName": "James Mwangi",
      "latitude": -1.2921, "longitude": 36.8219, "recordedAt": "2026-11-04T09:11:58.000Z",
      "stalenessS": 46, "tone": "success",          // success < 15 min, warning < 60 min, danger beyond
      "speedMps": 8.3, "speedKmh": 30, "heading": 40, "accuracyM": 12, "batteryPct": 77, "isMoving": true,
      "vehicle": { "id": "cm…", "plate": "KDG 445J", "make": "Toyota", "model": "Hiace" },
      "route": { "id": "cm…", "name": "Nairobi Central", "status": "ACTIVE", "done": 2, "total": 4, "skipped": 1,
                 "totalDistanceM": 48200, "odometerStartKm": 84210 }
    }
  ]
}
```

A field rep calling `/location/latest` or `/location/pings` sees only their own
row; both sit under `geofence:read`, so a company without Module 08 is refused.

### Check-in response

```jsonc
{
  "visit": { … },
  "verification": {
    "verified": true,
    "distanceM": 25,
    "reason": "Check-in 25m from customer pin",
    "enforced": true          // false when Geofencing (08) is not licensed
  }
}
```

`enforced: false` means the position was recorded but not judged — Phase One
captures location, Module 08 verifies it. The app must not show a green tick
the back office does not agree with.

---

## Commerce

| Endpoint | Module | Permission |
| --- | --- | --- |
| `GET`/`POST /customers`, `GET`/`PATCH`/`DELETE /customers/:id` | core / 01 | `customer:*` |
| `GET`/`POST /territories` | 01 | `territory:write` |
| `GET`/`POST /products` | core / 03 | `product:*` |
| `GET`/`POST /orders` | 02 | `order:*` |
| `GET`/`POST /invoices` | 02 | `invoice:*` |
| `GET`/`POST /payments` | 02 | `payment:*` |
| `GET`/`POST /stock` | 03 | `stock:*` |
| `GET`/`POST /suppliers`, `/purchase-orders` | 04 | `supplier:*`, `purchase:*` |
| `GET`/`POST /expenses`, `POST /expenses/:id/decision` | 05 | `expense:*` |
| `GET`/`POST /sms` | 09 | `sms:*` |
| `GET /analytics/dashboard` | core + 10 | `report:read` |

`DELETE /customers/:id` deactivates rather than deletes when the customer has
trading history — removing them would orphan invoices the business still needs
to collect. The response says which happened.

`POST /expenses/:id/decision` refuses self-approval.

Write endpoints accept an optional `clientUuid` for idempotency, the same
mechanism `/sync/push` uses.

---

## Platform (Super Admin only)

| Endpoint | Purpose |
| --- | --- |
| `GET /platform/overview` | The dashboard on proposal page 5 |
| `GET`/`POST /platform/companies` | List and provision tenants |
| `GET`/`PATCH /platform/companies/:id` | Detail, activate, suspend |
| `GET`/`PUT /platform/companies/:id/modules` | **Toggle module licences** |

`POST /platform/companies` provisions everything in one transaction: the
company, its module licences, document counters, head office branch, main
store, admin user, SMS templates and expense categories.

`PUT …/modules` warns when a module's prerequisite is missing — Smart Routing
without Field Sales has nothing to sequence — but permits it, because that is
the operator's commercial call.

---

## Settings (`settings:write`)

### `GET` / `PUT /settings/maps`

Which basemap the company uses: OpenStreetMap or Google Maps.

```jsonc
// PUT — every field optional; omitted fields are left as they are
{
  "provider": "GOOGLE",          // "OSM" | "GOOGLE" | null (null = platform default)
  "googleApiKey": "AIza…",       // "" removes the company's stored key
  "googleMapId": "1a2b3c4d5e6f"  // "" removes it
}
```

Both return the same view: `stored` (the company's own rows, key masked),
`platform` (whether the deployment supplies a default and a shared key) and
`effective` (what is actually rendered, with its source and any warning).
Choosing `GOOGLE` with no key anywhere is refused with `GOOGLE_KEY_REQUIRED`
rather than saved and silently ignored. The key is validated for shape
(`INVALID_GOOGLE_KEY`) and never appears in the audit log — only that it was
replaced or removed.

### `GET` / `POST` / `PATCH /settings/credentials`

Payment-gateway and eTIMS credentials. Write-only: no response ever carries a
stored secret.

For `DIGITAX`, `PATCH … { action: "test" }` does more than check that keys are
present: it rejects a `DIGITAX_TIN` that is not a KRA PIN (`^[AP]\d{9}[A-Z]$`),
calls `GET /etims-info` with the key, and fails when the PIN Digitax reports
differs from the TIN stored — a key that files as another taxpayer must never
pass a test.

---

## eTIMS (`etims:read` / `etims:configure` / `etims:submit`)

KRA electronic tax invoicing, through Digitax. Each company files under its own
PIN with its own stored key; there is no platform-wide account and no fallback
to the environment.

| Endpoint | Purpose |
| --- | --- |
| `GET`/`PUT /etims/config` | The switch, environment, auto-transmit, start date and default classification codes |
| `GET /etims/submissions?status=` | The transmission log: every attempt, request and response verbatim |
| `POST /etims/transmit` | Send one document by hand: `{ docType: "SALE" \| "CREDIT_NOTE", docId }` |
| `POST /etims/run` | Drain the queue (systemd timer; `Authorization: Bearer $ETIMS_RUNNER_TOKEN`) |
| `POST /etims/callbacks` | Digitax status callbacks (public, rate limited, untrusted) |

### Document statuses

`etimsStatus` on an invoice or credit note is one of:

- `NOT_APPLICABLE` — not filed through Raut (eTIMS off, raised before the start
  date, or the credit note's invoice was never filed).
- `QUEUED` — waiting to be sent, **or** sent and Digitax has it as `PENDING`
  (then `etimsSaleId` is set and the document is *read back*, never re-sent).
  `etimsError` says which, and why the last attempt failed.
- `SUBMITTED` — Digitax holds it (a 409, or Digitax's own `SUBMITTED`) but the
  final result has not been read yet. Never re-sent; reconciled by the sweep.
- `ACCEPTED` — KRA has it; `etimsControlCode` and `etimsQrUrl` are set.
- `REJECTED` — permanent: a 4xx, or eight retryable failures in a row (`Gave up
  after 8 attempts…`). Nothing retries it on its own; a person fixes the cause
  and uses `POST /etims/transmit`.

### Transmission rules

- A document is POSTed to Digitax **at most once per attempt and never while
  Digitax may already hold it.** Concurrent sends of the same document
  (auto-transmit, the timer, the console's Retry, the handset's "Send all")
  are serialised by a lock; the losers get `Another transmission … is already in
  progress`.
- A retryable failure (timeout, 429, 5xx, a non-JSON 2xx) backs off
  exponentially from 30 s to an hour; the attempt that follows a timeout first
  asks `GET /sales?trader_invoice_number=` whether the sale landed.
- A `409` means Digitax has it: the document is looked up by its number and
  applied, or parked as `SUBMITTED` until it can be — never `REJECTED`.
- Items are registered before the sale; a sale is never sent with a local
  product id in place of the Digitax item. Items are `REGISTERED` only when
  Digitax says `COMPLETE`; submissions are `ACCEPTED` only when the sale is
  `COMPLETED`.
- `sale_date`/`return_date` are the Nairobi calendar date. Amounts are
  two-decimal numbers; `unit_price` carries enough decimals for
  `quantity × unit_price` to round back to `total_amount` to the cent, and
  `taxable_amount + tax_amount = total_amount` always.
- Every POST carries `Idempotency-Key: <trader_invoice_number>`.
- Zero-rated (`C`) and exempt (`A`) are distinguished by the product's
  `etimsTaxTypeCode`; without it a zero rate files as `C`. Set it with
  `PATCH /products/:id { etimsItemClassCode, etimsTaxTypeCode, etimsItemTypeCode }`
  (each nullable; validated, `422 INVALID_ETIMS_CODE`).

### `POST /etims/transmit`

`200 { ok: true, status: "ACCEPTED" }` only when KRA has accepted the document.
Anything else is **`422 ETIMS_NOT_FILED`** with `details.status` (the document's
status now) and `details.reason`. The field app's "Send all" counts a 2xx as
sent, so a document still awaiting KRA must not be a 200.

### `POST /etims/run`

Returns the sweep summary: `{ processed, invoices, creditNotes, stock, awaiting,
failures, deferred, errors: [{ docType, docId, companyId, reason }], durationMs }`.
`?limit=` bounds documents *attempted* (default 50, max 500); documents inside
their backoff are skipped without counting, so they cannot starve the queue.
A sweep in which every attempted document failed answers **`502
ETIMS_RUN_FAILED`** so `curl -f` in the timer notices. One log line per run:
`[etims] run processed=… failures=…`.

### `POST /etims/callbacks`

Digitax signs nothing, so the body is a hint only: `id` / `sale_id` (a Digitax
sale id, which identifies the company) or `trader_invoice_number` (looked up
inside that company, or across companies that have a filed document under
that number). The document is then re-read from Digitax under the company's own
key; nothing in the body is written. Rate limited per source address (token
bucket, 30 burst / 1 per second) with `429`. Unknown references are `200
{ ignored: true }`.

### Environment

| Variable | Meaning |
| --- | --- |
| `DIGITAX_BASE_URL` | Deployment default API host (production). |
| `DIGITAX_SANDBOX_BASE_URL` | Host used by `SANDBOX` companies that store no URL of their own. **Falls back to the production URL when unset** — set it wherever sandbox keys are in use. |
| `ETIMS_TIMEOUT_MS` | Per-request timeout, default `20000`. |
| `ETIMS_BACKOFF_BASE_MS` | First retry delay, default `30000`. Test harnesses set `0`. |
| `ETIMS_RUNNER_TOKEN` | Shared secret for `POST /etims/run`. |
| `PUBLIC_BASE_URL` | Where Digitax sends callbacks; omitted from requests when unset. |

Tests: `npm run test:unit` covers the client and the state machine
(`src/lib/etims.test.ts`, `src/server/etims.test.ts`, the latter on a temp copy
of the dev database); `npm run test:etims` starts a platform on a copy of the
database against `scripts/mock-digitax.mjs` and walks every path over HTTP.

---

## Other

- `GET /health` — touches the database; a process that is up but cannot reach
  SQLite reports 503, because reporting 200 in that state is how outages get
  missed.
- `GET`/`POST /users` — seat limit enforced on create; `SUPER_ADMIN` cannot be
  minted by a tenant admin.
