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
  "email": "rep@zamarsolutions.co.ke",
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
button the server would refuse.

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
| `location.batch` | `pings[]` — breadcrumbs, batched as one operation |

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
| `GET /routes?today=true` | 07 | The mobile home screen's one call |
| `POST /routes` | 07 | Builds and sequences; optionally creates visits |
| `GET /geofence/events` | 08 | Read-only — written by check-in, never by a client |
| `GET`/`POST /location/pings` | 08 | Breadcrumbs; `POST` accepts up to 500 |

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

## Other

- `GET /health` — touches the database; a process that is up but cannot reach
  SQLite reports 503, because reporting 200 in that state is how outages get
  missed.
- `GET`/`POST /users` — seat limit enforced on create; `SUPER_ADMIN` cannot be
  minted by a tenant admin.
