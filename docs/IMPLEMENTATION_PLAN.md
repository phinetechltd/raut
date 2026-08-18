# Raut — One Platform. Every Mile. · Implementation Plan

**Product:** Raut, owned by Tari Africa Platforms Limited
**First client:** Zamar Solutions Limited
**Source of truth:** `Zamar_ERP_Proposal.pdf` (31 July 2026)

The proposal names the engagement after the client. The platform does not:
§9–12 make it a reusable product licensed to many businesses, and a product
named after one customer cannot be sold to the next. Zamar Solutions is
therefore a tenant on Raut, not the thing being built.

---

## 1. What the proposal asks for

The proposal defines a **single centralized application instance** serving many
companies, branches and users, with a Super Admin environment on top. Commercially
it is split into a core platform plus ten independently-licensed modules.

| Scope item | Proposal price | Delivered as |
| --- | --- | --- |
| Core Multi-Tenant Platform | KES 160,000 | Tenancy, Super Admin, ERP foundation, basic GPS, security |
| 01 CRM & Customer Management | KES 25,000 | Module `CRM` |
| 02 Sales & POS | KES 30,000 | Module `SALES_POS` |
| 03 Inventory Management | KES 25,000 | Module `INVENTORY` |
| 04 Procurement & Suppliers | KES 20,000 | Module `PROCUREMENT` |
| 05 Finance, Expenses & Receivables | KES 25,000 | Module `FINANCE` |
| 06 Field Sales Management | KES 20,000 | Module `FIELD_SALES` |
| 07 Smart Routing | KES 15,000 | Module `ROUTING` |
| 08 Geofencing & Location Intel | KES 15,000 | Module `GEOFENCING` |
| 09 SMS Communication | KES 10,000 | Module `SMS` |
| 10 Advanced Reporting & Analytics | KES 5,000 | Module `ANALYTICS` |
| **Full platform** | **KES 350,000** | |
| Native field-sales app (p.12) | separate quotation | Flutter app in `mobile/` |

Because modules are sold separately, **module licensing is a first-class runtime
concern**, not a packaging detail. Every module-owned API route and console screen
is gated on a `CompanyModule` row. Turning a module off must degrade the product
cleanly rather than break it.

## 2. Systems being built

Two deployable systems, as requested:

```
xos/
├── platform/     Next.js 15 + TypeScript + Prisma + SQLite
│                 ├─ web console  (Super Admin + tenant back office)
│                 └─ REST API /api/v1  (consumed by the mobile app)
└── mobile/       Flutter field-sales app (offline-first)
```

One Next.js app serves both surfaces. The console renders server-side from Prisma
directly; the mobile app talks only to `/api/v1`. They share the same database,
the same tenant scoping and the same permission matrix, so a visit checked in on a
phone is visible in the console on the next page load.

## 3. Architecture decisions

**Tenancy — shared database, row-level isolation.** Every tenant-owned table carries
`companyId`. Access goes through a scoping helper that derives `companyId` from the
authenticated principal, never from client input. This matches the proposal's "single
instance, multiple companies, tenant-level data isolation" and keeps SQLite viable.
Super Admin is the only principal with `companyId = null`, and it reaches tenant data
through explicit, audited cross-tenant queries.

**Why SQLite is acceptable here.** Chosen by the client for this build. It is a real
constraint, not a neutral one, so it is stated plainly: SQLite serialises writes,
which is fine for a distributor with tens of concurrent users but will not hold the
"48 companies / 1,204 active users" figure illustrated on page 5 under real
concurrent load. The Prisma schema uses no SQLite-only constructs, so moving to
Postgres later is a provider swap plus a migration, not a rewrite. Flagged for the
client rather than silently designed around.

**Auth.** One credential store, two token shapes. The console uses an HTTP-only
session cookie; the mobile app uses a short-lived JWT access token plus a rotating
refresh token bound to a device row. Both carry the same claims (`userId`,
`companyId`, `role`), so authorization code is shared.

**Offline sync.** The field app is the system of record between check-ins. It keeps a
local SQLite mirror and an outbox. Writes are pushed with a client-generated UUID
used as an **idempotency key**, so a retried push after a dropped connection cannot
double-post an order or a payment. Reads are pulled by `updatedAt` watermark per
entity. Server IDs and local IDs are kept distinct and reconciled explicitly — never
interchanged.

**Geo.** Haversine for distances, ray-casting point-in-polygon for territory
geofences, nearest-neighbour with 2-opt refinement for route sequencing. All
computed in-process; no external routing API, so nothing here depends on a
third-party contract the proposal excludes from scope.

## 4. Build order

| # | Stage | Covers |
| --- | --- | --- |
| 1 | Schema | All entities for core + 10 modules, sync tables |
| 2 | Core libs | auth, tenancy, RBAC, audit, module gate, geo |
| 3 | API v1 | auth, sync, and every module's endpoints |
| 4 | Seed | Raut tenant with realistic Kenyan distributor data |
| 5 | Super Admin console | p.5 — companies, users, modules, monitoring |
| 6 | Tenant console | p.7, p.9 — CRM/POS, inventory, field ops, maps |
| 7 | Mobile core | auth, local store, sync engine |
| 8 | Mobile features | route, visits, check-in, orders, photos, GPS |
| 9 | Integration | prove offline order → sync → console |

## 5. Role model

| Role | Scope | Purpose |
| --- | --- | --- |
| `SUPER_ADMIN` | platform | Create/activate companies, licence modules, monitor |
| `COMPANY_ADMIN` | company | Full access within one company |
| `BRANCH_MANAGER` | branch | Branch operations, approves expenses and discounts |
| `SALES_MANAGER` | company | Territories, targets, routes, field-team performance |
| `ACCOUNTANT` | company | Invoices, payments, receivables, expenses |
| `STORekeeper` → `STOREKEEPER` | branch | Stock, transfers, goods received |
| `FIELD_REP` | self | Mobile app: own route, visits, orders, payments |

Permissions are string tuples (`customer:write`, `invoice:approve`, …) resolved from
role plus module licence. A permission held by role but belonging to an unlicensed
module resolves to denied.

## 6. What is explicitly out of scope

Per proposal pages 11 and 15, these are excluded and are **not** built here — the
seams exist, the integrations do not:

- Digitax / eTIMS tax invoicing
- Accounting software sync
- M-Pesa / card payment gateways
- WhatsApp Business API
- A live bulk-SMS provider account (the SMS module ships with a `console` adapter
  that logs messages, plus an adapter interface for Africa's Talking / Twilio)

## 7. Verification

The build is not "done" because files exist. It is done when:

- `npm run typecheck` passes
- the platform serves the console and `/api/v1` health
- seeded credentials sign in to Super Admin and tenant consoles
- `flutter analyze` passes on the mobile app
- an order captured **with the device offline** reaches the tenant console after
  reconnect, exactly once, with the geofence verification flag intact
