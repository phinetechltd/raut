# Raut — Play store listing copy

Paste each block into the matching field in Play Console. Character counts are
verified by `check-listing.py` in this folder.

---

## App name (30 max)

```
Raut Field Sales
```

---

## Short description (80 max)

```
Field sales that works with no signal — routes, check-ins, orders, collections.
```

The line above is **79/80** — one character of margin, so do not add a word to
it without re-running `check-listing.py`.

### Alternatives, if you want a different emphasis or more headroom

| Chars | Line |
|---|---|
| 79 | `Offline-first field sales: sequenced routes, GPS check-in, orders and payments.` |
| 78 | `Field sales that works with no signal: routes, check-ins, orders, collections.` |
| 77 | `Run your field team offline: routes, verified visits, orders and collections.` |
| 76 | `Field sales that keeps working with no signal. Routes, visits, orders, cash.` |

---

## Full description (4000 max)

```
Raut puts a day in the field into one app — and keeps working when the network does not.

Reps carry today's route, the whole customer book and ninety days of documents on their phone. Every order, payment and check-in is written to the device first and reaches the office when a connection appears. Nothing waits on a signal that isn't there.


TODAY'S ROUTE, ALREADY IN ORDER

Stops arrive sequenced by distance, with the planned time, the town and what each shop owes. Balances over the credit limit are called out before the rep walks in. A progress bar and driving estimate cover the whole day, so a rep can see at a glance whether they are ahead or behind.


CHECK IN, SELL AND COLLECT ON ONE SCREEN

Checking in captures GPS and verifies it against the customer's geofence, showing the distance plainly. The balance, the credit limit and every overdue invoice are on screen before an order is written — so the collection conversation happens while the rep is still standing in the shop.

Orders, payments, expense claims and photos are captured on the spot and queued for sync.


EVERY CUSTOMER, IN YOUR POCKET

The customer book lives on the device. Search by name, code, phone or town in a basement with no bars. Reps can add new shops in the field and drop a GPS pin; the record comes back with a real customer code once it syncs.


A DAY YOU CAN ACCOUNT FOR

The Today screen shows visits done, GPS-verified check-ins, orders written and cash collected — the rep's own numbers. The sync panel says in plain words whether the office has everything yet, and the queue shows exactly what is still waiting. Nobody has to re-enter work they think vanished.


BUILT FOR PATCHY NETWORKS

Every write lands in the device's own store and an outbox in the same action, so the screen never freezes waiting on a request. When a connection returns, work is pushed before anything is pulled down, so a check-in made offline is never overwritten by an older copy from the server. Each operation carries its own identifier, so a retry on a bad line resolves to the record already created rather than duplicating an order.


FOR THE OFFICE

Raut is the field half of a wider platform. Managers get a web console with live visit positions, sequenced routes, receivables ageing, sales trends and a full audit trail. Territories are drawn as circles or polygons and used to verify that field activity happened where it was reported.

The platform covers CRM, sales and POS, inventory, procurement, finance, field sales, smart routing, geofencing, SMS and reporting. Each module is licensed per company, so you buy the parts you use.


LOCATION

Raut uses location while the app is open, for two things: verifying that a check-in happened at the customer, and sequencing routes by distance. Continuous route tracking is off unless a rep switches it on, and the app always shows whether it is recording. Location is never sold or shared outside the company the rep works for.


ACCOUNT REQUIRED

Raut is sold to businesses. You need an account from your employer to sign in; the app is not usable on its own.

Privacy policy: https://raut.co.ke/policy
Contact and data deletion: https://raut.co.ke/contact-us

Tari Africa Platforms Limited, Nairobi.
```

---

## Notes on choices

- The short description leads with the offline promise, because that is the one
  thing a distributor with rural routes is actually shopping for.
- No feature is claimed that the app does not do. "GPS-verified" is accurate:
  the server recomputes the geofence result and its verdict is what is stored.
- Location gets its own section. Play reviews location-permission apps against
  the description, and a vague one invites a rejection.
- "Account required" is stated plainly — Play rejects listings where a reviewer
  cannot get past the login screen without explanation. Supply the demo
  credentials in the Play Console review notes as well.
