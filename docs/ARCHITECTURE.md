# Architecture

How the Raut platform is put together, and why. Decisions that cost something
are stated with their trade-off rather than presented as free.

---

## 1. One app, two surfaces

A single Next.js 15 application serves both the web console and the mobile
REST API.

```
                    ┌────────────────────────────┐
   Browser ───────► │  app/(console)  RSC pages  │
                    │      ↓ direct Prisma       │
                    │  ┌──────────────────────┐  │
                    │  │  src/server/*        │  │  domain services
                    │  │  sales, inventory,   │  │  (shared)
                    │  │  field, routing,     │  │
                    │  │  analytics           │  │
                    │  └──────────────────────┘  │
                    │      ↑ via handler()       │
   Flutter ───────► │  app/api/v1/*  routes      │
                    └────────────┬───────────────┘
                                 ▼
                          Prisma → SQLite
```

The console renders server-side from Prisma directly; the mobile app talks only
to `/api/v1`. Both go through the same domain services in `src/server/`, so an
invoice raised on a handset and one raised at a counter take the identical code
path — same stock movement, same customer balance update, same SMS trigger.

**Why not separate services?** Two deployables would double the operational
surface for a product whose first customer is one distributor. The seam that
matters — domain logic in `src/server/`, transport in route handlers and pages —
is already drawn, so splitting later is mechanical.

---

## 2. Tenancy

**Shared database, row-level isolation.** Every tenant-owned table carries
`companyId`.

The single rule: **`companyId` comes from the authenticated principal, never
from the request.** It is enforced in one file, `src/lib/tenant.ts`:

```ts
scope(principal)                              // { companyId: <from token> }
scope(principal, { selfField: 'repId' })      // + narrows a FIELD_REP to their own
```

Every query touching tenant data goes through it, so there is one place to audit
rather than a `where` clause per route to review.

Two deliberate behaviours:

- **Cross-tenant lookups return 404, not 403.** Absence and denial are made
  indistinguishable, so probing ids cannot confirm another company's records
  exist. Verified in `scripts/smoke.mjs`.
- **Super Admin is the only principal with `companyId = null`**, and it reaches
  tenant data through `crossTenantScope()`, which requires naming the company
  explicitly and is audited.

### Why SQLite is a real constraint

Chosen by the client for this build. SQLite serialises writes. At a
distributor's scale — tens of concurrent users, a few hundred documents a day —
that is comfortable. It will **not** hold the "48 companies / 1,204 active
users" figure illustrated on proposal page 5 under genuine concurrent load.

The schema uses no SQLite-only constructs, so the migration path is a provider
swap in `schema.prisma` plus a data migration. Flagged rather than designed
around silently.

---

## 3. Authentication

One credential store, two token shapes, identical claims.

| Surface | Credential | Lifetime |
| --- | --- | --- |
| Web console | `xos_session` HTTP-only cookie holding the JWT | 60 min |
| Mobile app | `Authorization: Bearer` JWT | 60 min |
| Mobile app | Rotating refresh token, bound to a `Device` row | 30 days |

Because both decode to the same claims, `can(principal, permission)` is written
once and used by pages and routes alike.

**Refresh tokens rotate on use and the old one is revoked.** A token captured
off the wire stops working the moment the real device refreshes. Replaying a
rotated token returns 401 — tested.

**Licences are read per request, not baked into the token.** Revoking a module
takes effect immediately rather than at the next sign-in. That costs one query
per authenticated request; on SQLite it is sub-millisecond, and the alternative
is a company keeping access to something they stopped paying for until their
token lapses.

---

## 4. Module licensing

The commercial spine of the proposal, and a first-class runtime concern.

A permission resolves to ALLOWED only when **both** hold:

1. the principal's role carries it, and
2. the module that owns it is licensed to their company.

```
permission          →  owning module     →  CompanyModule.enabled?
'invoice:write'        SALES_POS            no  →  402 MODULE_NOT_LICENSED
'customer:read'        (core)               n/a →  allowed
```

`src/lib/rbac.ts` holds the permission→module map. Route handlers get the check
free via `handler({ permission })`; console pages call `ModuleLocked`.

Unlicensed modules **degrade, they do not break**:

- API returns `402` with the module's name, not a 500 or an empty list
- Console nav shows the section locked, not hidden — the upgrade path stays visible
- Business flows that *touch* an unlicensed module no-op rather than fail: an
  order still saves when the SMS module is off, it just sends no confirmation

Seeded proof: **Acacia Distributors** has the core platform and zero modules.

---

## 5. Offline sync

The field app is the system of record between check-ins. Four properties make
that safe.

### Push before pull

Local work is authoritative until the server has it. Pulling first would
overwrite an unsynced check-in with the server's older copy and lose it.

### Idempotency

Every mutation carries a client-generated UUID, stored server-side in
`IdempotencyKey`. A replayed batch resolves to the already-created records.

```
POST /sync/push  { operations: [{ uuid: "abc", type: "order.create", … }] }
  → { applied: 4, duplicates: 0 }

… connection drops before the reply arrives, handset retries the same batch …

POST /sync/push  { same batch }
  → { applied: 0, duplicates: 4 }   ← same entityIds returned
```

This is the single most important guarantee in the design. Reps work in exactly
the conditions that cause retries; without it, one order becomes two.

### The watermark is the server's clock

`syncedAt` comes from the server and the client stores it verbatim. A handset
running a few minutes fast would silently skip every record written in the gap.

### Ids never mix

Offline-created records get a `local:<uuid>` id until sync assigns a real one.
References to a `local:` id are omitted from payloads rather than sent — a
reference the server cannot resolve would fail the whole operation.

### Independently fallible

Each operation in a batch is applied separately and reported on. One bad
operation does not reject the other nineteen; the client clears what succeeded
and keeps what failed, surfacing it in the sync queue screen.

### What is not handled

**Deletes have no tombstones.** For this product that is acceptable: customers
and products are deactivated (`status`, `active`), never removed, so the client
sees the state change on the next pull. A hard delete would need a tombstone
table.

**Last-write-wins on conflicts.** Two reps editing the same customer's phone
number is rare and low-stakes. Anything higher-stakes (orders, payments,
visits) is append-only, so conflicts cannot arise.

---

## 6. Money

**Integer KES cents everywhere. No floats, ever.**

A single document tops out around KES 21M, comfortably inside distributor
invoice sizes; aggregates are summed in JS as Numbers, safe to 2^53.

Line maths lives in `src/lib/money.ts` and is mirrored in
`mobile/lib/core/money.dart`. Discount applies to the gross line *before* tax,
because Kenyan VAT is charged on the discounted consideration.

The duplication is deliberate — the rep must see the total before the server
sees the order — and it is pinned by tests on both sides. If they diverge, a rep
reads one figure to a shopkeeper and the office invoices another.

---

## 7. Geo

No external routing or mapping API. The proposal excludes third-party
integrations from the platform price, so nothing here depends on a contract
that was not bought.

| Need | Implementation |
| --- | --- |
| Distance | Haversine, ×1.35 road-winding factor for planning |
| Territory fences | Ray-casting point-in-polygon, circular fallback |
| Route sequencing | Nearest-neighbour + 2-opt refinement |
| Console maps | SVG equirectangular projection of stored coordinates |

**Why 2-opt.** Exact TSP is not worth solving for a 5–20 stop day, and the
road-winding estimate already dominates the error. But nearest-neighbour alone
leaves visible crossings, and reps notice and distrust a route that doubles
back. 2-opt converges in milliseconds at this size and removes them.

**Visit verification** folds GPS accuracy into the allowance:

```
verified  ⟺  distance ≤ customer.geofenceRadiusM + min(accuracy, 100)
```

Without the accuracy term, a rep standing in the shop doorway with a 60 m fix
gets marked absent by their own handset. The cap at 100 m stops a handset
reporting 10 km accuracy from verifying a check-in across town.

The verdict is **stored on the visit**, not recomputed later — a customer pin
corrected next month must not retroactively rewrite what happened.

---

## 8. Audit

Append-only trail of authentication and state changes, per Phase One's security
scope.

Audit writes are deliberately **outside** the business transaction and swallow
their own failures: an audit write must never be the reason a legitimate
transaction fails. The trade-off is accepted because this is an operational
trail, not a regulatory ledger. If it becomes the latter — eTIMS — it has to
move inside the transaction, and that is a real change, not a config flag.

---

## 9. Roles

| Role | Scope | Purpose |
| --- | --- | --- |
| `SUPER_ADMIN` | platform | Companies, licences, monitoring |
| `COMPANY_ADMIN` | company | Everything within one tenant |
| `BRANCH_MANAGER` | branch | Branch ops, approves expenses and discounts |
| `SALES_MANAGER` | company | Territories, targets, routes, field team |
| `ACCOUNTANT` | company | Invoices, payments, receivables, expenses |
| `STOREKEEPER` | branch | Stock, transfers, goods received |
| `FIELD_REP` | self | Mobile: own route, visits, orders, payments |

`FIELD_REP` is deliberately narrow and self-scoped. A rep may create orders,
payments and visits, and correct a customer's contact details and GPS pin — but
not edit credit limits, payment terms, or approve their own expense claim.
Enforced in `rbac.ts` (permissions), `tenant.ts` (self-scoping) and the
`REP_EDITABLE` allowlist on the customer route.
