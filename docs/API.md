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
| `delivery.deliver` | `deliveryNoteId`, `receivedByName`, `receivedByPhone?`, `receivedBySignature?` (typed name or data: URL), `notes?` — marks a note the rep raised or drives as DELIVERED; `at` is the delivery time |

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
| `GET`/`POST /delivery-notes`, `GET`/`PATCH /delivery-notes/:id` | 02 | `delivery:*` — see Delivery notes below |
| `GET`/`POST /stock`, `POST /stock/repack` | 03 | `stock:*` |
| `GET`/`POST /transfers`, `POST /transfers/:id/{dispatch,receive,cancel,close-short}` | 03 | `stock:read` / `stock:write` |
| `GET`/`POST /goods-receipts`, `POST /goods-receipts/:id/post` | 04 | `purchase:read` / `grn:write` |
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

## Delivery notes (`delivery:read` / `delivery:write`)

The paper that travels with the goods and comes back signed. A delivery note
is a **dispatch and acknowledgement record, not a stock document**: stock
leaves the shelf when the invoice is issued, so a note raised against an
invoice moves nothing, and a note raised against an order that has not been
invoiced yet moves nothing either. Several notes may cover one invoice or
order; the server refuses to deliver more than was sold across all of them.

| Endpoint | Purpose |
| --- | --- |
| `GET /delivery-notes?status=&q=&invoiceId=&orderId=&page=&limit=` | List, newest first. `q` matches the note, invoice, order number or customer name |
| `POST /delivery-notes` | Raise a note from `invoiceId` **or** `orderId` (one is required). `lines[]` optional — see below. `clientUuid` makes the write replay-safe |
| `GET /delivery-notes/:id` | One note with its lines, customer, source document, driver, vehicle and route |
| `PATCH /delivery-notes/:id` | Move it through its lifecycle with `{ action }` |

`POST` body:

```jsonc
{
  "invoiceId": "cm…",                   // or "orderId"
  "lines": [                            // omit to deliver everything outstanding
    { "invoiceLineId": "cm…", "deliveredQty": 4, "note": "2 cartons short" }
  ],                                    // use "orderLineId" for an order
  "deliveredById": "cm…",               // the rep or driver; defaults to the caller for a FIELD_REP
  "vehicleId": "cm…", "routeId": "cm…", "visitId": "cm…",
  "deliveryAddress": "…",               // defaults to the customer's address, snapshotted
  "notes": "…",
  "issue": true,                        // false keeps it DRAFT
  "clientUuid": "…"
}
```

A line left out of `lines[]` is not delivered; a line listed without
`deliveredQty` goes out at whatever it still has undelivered. Over-delivery is
a `409` naming the line and the remainder. A draft invoice, a cancelled
invoice, a draft order and an order that has already been invoiced are all
`409`s — the last because the invoice is then the document to deliver against.

`PATCH` actions:

| Action | From → to | Body |
| --- | --- | --- |
| `issue` | DRAFT → ISSUED | — |
| `deliver` | DRAFT, ISSUED → DELIVERED | `receivedByName` (required), `receivedByPhone?`, `receivedBySignature?` (typed name or `data:` URL), `deliveredAt?`, `deliveredById?`, `notes?` |
| `return` | DELIVERED → RETURNED | `lines: [{ lineId, returnedQty }]`, `notes?` — what came straight back with the driver |
| `cancel` | DRAFT, ISSUED → CANCELLED | — |

A note the customer has signed for is a fact: it cannot be cancelled or
edited, only corrected by a `return` here or a credit note on the sale. A
returned quantity is treated as not delivered, so it can go out again on a
later note. When a note raised **from an order** is delivered, the order's
lines gain `fulfilled` and the order becomes `PARTIALLY_FULFILLED` or
`FULFILLED`; an invoiced order is left to its invoice.

Numbering is `DN-0001` on its own counter. Field reps see the notes they
raised or are the named driver on; everyone else sees the company's.

### Printing

Every document prints from `/print/<type>/<id>` with the console session
cookie, outside the console chrome, as one A4 layout shared by all of them;
the browser's print dialog is the PDF route. Types and the permission each
needs:

| Type | Permission | Notes |
| --- | --- | --- |
| `invoice` | `invoice:read` | **TAX INVOICE** with control code and inline-SVG QR once KRA has accepted it; otherwise **INVOICE** with the "NOT A TAX INVOICE / Awaiting KRA" wording the field app prints. `?format=thermal` is the 80 mm **SALES RECEIPT** |
| `credit-note` | `creditnote:read` | **CREDIT NOTE** when accepted, **RETURN NOTE** otherwise, against the invoice it reverses |
| `receipt` | `payment:read` | **PAYMENT RECEIPT**: the invoices the payment was applied to, what each still owes, and the account balance. `?format=thermal` supported |
| `delivery-note` | `delivery:read` | **DELIVERY NOTE**: ordered / delivered / returned per line, no prices unless `?prices=1`, signature boxes with the recorded receiver |
| `order` | `order:read` | **PROFORMA INVOICE** for a sales order |
| `purchase-order` | `purchase:read` | **PURCHASE ORDER** with supplier and delivery address |
| `grn` | `purchase:read` | **GOODS RECEIVED NOTE** |
| `statement` | `invoice:read` | `/print/statement/<customerId>?from=YYYY-MM-DD&to=YYYY-MM-DD` — **STATEMENT OF ACCOUNT** with opening balance, every invoice, payment and credit note in the period, a running balance, and the open invoices with what each still owes. Defaults to the last 90 days |
| `route-sheet` | `route:read` | **ROUTE SHEET**: the day's stops with blank Delivered / Collected / Signature columns, the vehicle plate and odometer lines |

`?copy=1` stamps **DUPLICATE**; `?autoprint=1` opens the print dialog on load.
An id from another company, or a type the role may not read, is a `404`.

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

## Payments (`payment:read` / `payment:write`)

Gateway collections: M-Pesa STK push (Safaricom Daraja), Paystack hosted
checkout, KCB Buni. The rule the whole section rests on: **only the provider
decides whether money moved.** Nothing books a Payment because a client, a rep
or a callback body said so — every success path ends in a verify call to the
gateway. A callback is a nudge to go and ask; the one thing taken from it is
the M-Pesa receipt number, and only after verify agreed.

| Endpoint | Purpose |
| --- | --- |
| `GET /payments/providers` | Which gateways *this company* can collect through (`configured` per provider) |
| `POST /payments/initiate` | Start a collection. Rate limited: 5 per user per minute (429) |
| `GET /payments/intents/:id` | Poll one collection; re-asks the provider while live. `?recheck=1` re-asks a SUCCEEDED Paystack intent too (detects a reversal) |
| `POST /payments/callbacks/{paystack \| mpesa_daraja \| kcb_buni}` | Provider callbacks (public, rate limited per IP, untrusted; always 200 except a bad signature → 401) |
| `GET /payments/return/paystack?reference=` | Where Paystack sends the payer's browser afterwards; settles, then 303 → `/payments/return/status?s=succeeded \| pending \| failed \| unknown` (a plain HTML page) |
| `POST /payments/reconcile` | Reconcile open collections (systemd timer; `Authorization: Bearer $PAYMENTS_RUNNER_TOKEN`) |

### `POST /payments/initiate`

```json
{ "customerId": "…", "provider": "MPESA_DARAJA", "amountCents": 125000,
  "payerPhone": "0712345678", "payerEmail": "…", "visitId": "…", "clientUuid": "…" }
```

Returns the **public intent** — `id, status, provider, amountCents, currency,
receiptRef, failureReason, redirectUrl, paymentId, createdAt, completedAt` —
never the provider's raw payload or the company id. For Paystack `redirectUrl`
is the hosted checkout to open or share; for STK pushes it is null and the
customer gets a PIN prompt.

- `clientUuid` replays within the company: the same key returns the same
  intent and sends **no second prompt**. The field app reuses it for retries
  inside two minutes.
- M-Pesa and Buni take whole shillings: an amount with cents is a 422
  `AMOUNT_NOT_WHOLE`, never rounded. Paystack takes minor units as given.
- `PROVIDER_NOT_CONFIGURED` (503) when neither the company nor the deployment
  has credentials for that provider.

### Statuses

`PENDING` (row created, provider not yet asked) → `PROCESSING` (prompt or
checkout live) → `SETTLING` (transient claim while the payment is booked) →
`SUCCEEDED` | `FAILED` | `EXPIRED` (no confirmation in 24 h) | `REVERSED`.

`REVERSED` is a `SUCCEEDED` Paystack charge the provider later refunded or
charged back. The intent is marked and audited; **the ledger is not reversed
automatically** — Finance → Collections lists it for a person to act on.

When the initiate call to the provider is lost *after* it may have been sent
(timeout, reset), the intent stays `PROCESSING` under a `lookup:` key rather
than failing: Paystack is re-verified by our reference, and a Daraja callback
for the same phone and amount adopts the `CheckoutRequestID`. A provider that
was never reached (connection refused) fails the intent with `provider
unreachable`.

### Callbacks

Daraja does not sign; its callback only identifies the intent, and the STK
query decides. Paystack signs with HMAC-SHA512 (`x-paystack-signature`);
only `charge.success`, `charge.failed` and `refund.*` are acted on, the rest
are acknowledged and dropped. KCB signs with `x-buni-signature` when
`KCB_WEBHOOK_SECRET` is set. A callback whose amount or currency differs from
the intent fails it with `amount mismatch` (audited) — nothing is booked.
Duplicate and out-of-order callbacks settle once.

**Paystack dashboard:** set the webhook URL to
`https://<your domain>/api/v1/payments/callbacks/paystack`. The browser return
URL is set per transaction by the platform.

### Reconciliation

`POST /payments/reconcile` re-verifies `PROCESSING` intents older than two
minutes, moves a `PENDING` intent with no handle under a `lookup:` key, re-runs
stale `SETTLING` claims, and expires anything older than 24 hours. The
`deploy/raut-payments.timer` unit runs it every five minutes. Returns
`{ expired, orphansKeyed, rechecked, settled, failed, staleClaims, errors }`;
502 only when every re-check errored.

### Credentials and environment

A company's stored bundle (Settings → Payments) is used **on its own**; a
company with none uses the deployment's environment. Optional keys left blank
on "Replace keys" keep their stored value. Tenant-settable `*_BASE_URL` keys
must point at an official host (`api.paystack.co`, `api|sandbox.safaricom.co.ke`,
`api|uat.buni.kcbgroup.com`) unless `PAYMENTS_ALLOW_CUSTOM_HOSTS=1`. A
production deployment refuses a `sk_test_` key or `MPESA_ENV=sandbox` unless
`PAYMENTS_ALLOW_TEST_KEYS=1`. `PATCH … { action: "test" }` proves a key
without moving money: Paystack must answer "not found" (not 401) for an
impossible reference; Daraja must issue a token *and* answer an STK query for
an impossible `CheckoutRequestID` with "invalid CheckoutRequestID".

| Variable | Purpose |
| --- | --- |
| `PAYMENTS_TIMEOUT_MS` | Timeout on every outbound provider call (default 20000) |
| `PAYMENTS_RUNNER_TOKEN` | Shared token for `/payments/reconcile`; unset = endpoint refuses everything |
| `PAYMENTS_ALLOW_CUSTOM_HOSTS` | `1` lets tenants set non-official base URLs (test boxes only) |
| `PAYMENTS_ALLOW_TEST_KEYS` | `1` lets a production deployment store test keys / sandbox |
| `PAYMENTS_INITIATE_PER_MINUTE` | Per-user initiate limit (default 5; raised by the smoke test) |
| `MPESA_BASE_URL`, `PAYSTACK_BASE_URL`, `KCB_BASE_URL` | Deployment-level host overrides (mocks, staging) |
| `PUBLIC_BASE_URL` | Where providers reach this deployment for callbacks and the return page |

Manual records: `POST /payments` and `/sync/push payment.create` accept
`CASH | MPESA | BANK | CHEQUE` only. The gateway methods (`MPESA_STK`,
`PAYSTACK`, `KCB_BUNI`) are booked solely by settlement — 422 otherwise. A
manual `MPESA` record needs the 10-character confirmation code
(`^[A-Z0-9]{10}$`), unique per company (409 `DUPLICATE_REFERENCE` on reuse).

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

## Stock operations (`stock:write`, `grn:write`)

Stock is one pool per product in base units; a selling unit (variant) is only a
multiplier, so moving between two pack sizes of the *same* product is nothing.
Everything below writes `StockMovement` rows through the one choke point, so
balances stay the sum of their movements and the ledger follows.

### `POST /stock` — single or multi-location adjustment

```jsonc
{ "productId": "…", "locationId": "…", "quantity": -3, "note": "Damaged" }
// or, one product counted at several locations in one transaction:
{ "productId": "…", "note": "Cycle count",
  "lines": [ { "locationId": "A", "quantity": -3 }, { "locationId": "B", "quantity": 3 } ] }
```

The single body returns one movement, as before. With `lines`, every line is a
valued `ADJUSTMENT` — **unless the lines net to zero**, in which case nothing
was gained or lost, only found elsewhere, and the response is
`{ kind: "RELOCATION", transfers: [...] }`: one completed transfer per
source→destination pair, dispatched and received on the spot, posting nothing.
Otherwise `{ kind: "ADJUSTMENT", movements: [...] }`.

### `POST /stock/repack` — split / repack

```jsonc
{ "locationId": "…", "fromProductId": "<carton>", "fromQuantity": 2,
  "toProductId": "<piece>", "toQuantity": 24, "note": "optional" }
```

`toQuantity` defaults to `fromQuantity × unitsPerPack` of the source when that
is above 1; otherwise it is required. Both products must track stock, differ,
belong to the caller's company, and the source must have enough on hand at the
location (422 otherwise). Writes `REPACK_OUT` (−from at the source cost) and
`REPACK_IN` (+to at `floor(value / toQuantity)`) sharing `refType: "REPACK"` and
a `refId`. The cents the floor loses are posted as a `REPACK_ROUNDING` journal
entry (Dr stock adjustments / Cr inventory) against the IN movement, so the
inventory account still equals Σ quantity × cost. The target product is repriced
to the weighted average `(held × cost + value) / (held + toQuantity)`. Returns
`{ refId, out, in, valueCents, remainderCents, targetCostPriceCents, previousTargetCostPriceCents }`.

### Transfers — `GET`/`POST /transfers`

`GET` filters: `status`, `q` (number, note, product), `fromLocationId`,
`toLocationId`, paginated. `POST` creates a `DRAFT`:

```jsonc
{ "fromLocationId": "…", "toLocationId": "…", "note": "optional",
  "lines": [ { "productId": "…", "quantity": 10 } ], "dispatch": false }
```

Locations must differ, each product appears once, and `dispatch: true`
dispatches everything immediately. Each line carries `quantity`, `dispatched`
and `received` with `0 ≤ received ≤ dispatched ≤ quantity`; the status is
derived from the counters:

| Status | Meaning |
| --- | --- |
| `DRAFT` | nothing dispatched |
| `PARTIALLY_DISPATCHED` | some left the source, nothing received yet |
| `IN_TRANSIT` | everything left, nothing received |
| `PARTIALLY_RECEIVED` | something received, more to come |
| `RECEIVED` | everything received, or closed short |
| `CANCELLED` | a draft that was cancelled |

- `POST /transfers/:id/dispatch` and `POST /transfers/:id/receive` take an
  optional `{ "lines": [ { "lineId": "…", "quantity": 4 } ] }`; a bare POST
  moves everything still outstanding. Each quantity must be `0 < q ≤ remaining`
  (422). Lines are claimed with conditional updates, so two racing dispatches
  cannot both succeed (the loser gets 409). `dispatchedAt` is set on the first
  dispatch, `receivedAt` on completion.
- `POST /transfers/:id/cancel` — `DRAFT` only (409 otherwise).
- `POST /transfers/:id/close-short` with optional `{ "note" }` — for a transfer
  that will never complete. Whatever was dispatched but not received comes back
  to the source with `TRANSFER_IN` and is written off there with `WRITE_OFF`
  (which posts the loss). Undispatched quantity never moves. The transfer ends
  `RECEIVED` with `shortClosedAt` set.

Transfers permit negative stock at the source, as sales do.

### Goods receipts — `GET`/`POST /goods-receipts`

`GET` (`purchase:read`) filters: `status` (`DRAFT`|`POSTED`), `q`, `poId`,
`supplierId`. `POST` (`grn:write`) creates a `DRAFT`, or posts at once with
`post: true`:

```jsonc
{ "poId": "…",                 // optional; supplierId required without it
  "supplierId": "…",           // must match the PO's when both are given
  "locationId": "…",           // where lines land unless they say otherwise
  "receivedAt": "2026-11-04", "note": "DN 4471", "allowOver": false, "post": true,
  "lines": [
    { "productId": "…", "quantity": 8 },                                   // PO line matched by product
    { "productId": "…", "quantity": 4, "locationId": "<other store>" },    // lands elsewhere
    { "productId": "…", "quantity": 2, "poLineId": "…", "unitCostCents": 950 } ] }
```

`unitCostCents` defaults to the matched PO line's cost, else the product's.
A line naming `poLineId` fulfils that line; otherwise the product's PO lines
are filled in order, so a PO with the same product twice is handled. Receiving
beyond what the PO ordered is refused with 422 unless `allowOver` is true (the
excess lands on the last line it was being filled against). A PO must be
`SENT` or `PARTIALLY_RECEIVED`.

`POST /goods-receipts/:id/post` with optional `{ "allowOver": true }` posts a
draft: `DRAFT → POSTED` is claimed atomically (409 on a second post), a
`PURCHASE` movement lands at `line.locationId ?? receipt.locationId`, each
product's cost basis becomes the landed cost, PO lines and status update, and
inventory / GRNI are booked from the receipt's own lines.

---

## Other

- `GET /health` — touches the database; a process that is up but cannot reach
  SQLite reports 503, because reporting 200 in that state is how outages get
  missed.
- `GET`/`POST /users` — seat limit enforced on create; `SUPER_ADMIN` cannot be
  minted by a tenant admin.
