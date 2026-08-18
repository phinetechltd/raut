import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

import 'package:raut_field/core/local_db.dart';
import 'package:raut_field/core/outbox.dart';
import 'package:raut_field/data/field_repository.dart';
import 'package:raut_field/models/models.dart';

/// Tests the offline store against the real sqflite engine.
///
/// These cover the behaviour that only shows up when the rep has no signal —
/// which is exactly the behaviour that cannot be checked by hand during a demo,
/// and exactly where an offline app loses people's money if it is wrong.
void main() {
  sqfliteFfiInit();
  databaseFactory = databaseFactoryFfi;

  late LocalDb db;
  late Outbox outbox;
  late FieldRepository repo;

  setUp(() async {
    db = LocalDb.at(inMemoryDatabasePath);
    outbox = Outbox(db);
    repo = FieldRepository(db: db, outbox: outbox);

    // A minimal mirror, as a sync pull would have left it.
    await db.upsertAll('customers', [
      {
        'id': 'cust-1',
        'code': 'CUS-0001',
        'name': 'Nairobi Fresh Traders',
        'phone': '+254722000010',
        'town': 'Nairobi CBD',
        'latitude': -1.28472,
        'longitude': 36.82361,
        'geofenceRadiusM': 150,
        'creditLimitCents': 50000000,
        'balanceCents': 21450000,
        'status': 'ACTIVE',
        'paymentTermsDays': 30,
        'segment': 'A',
        'type': 'WHOLESALE',
      },
      {
        'id': 'cust-2',
        'code': 'CUS-0002',
        'name': 'Westlands Mini Mart',
        'town': 'Westlands',
        'balanceCents': 0,
        'status': 'ACTIVE',
        'geofenceRadiusM': 150,
      },
    ]);

    await db.upsertAll('products', [
      {
        'id': 'prod-1',
        'sku': 'OIL-5L',
        'name': 'Cooking Oil 5L',
        'unit': 'CTN',
        'sellPriceCents': 150000,
        'taxRateBp': 1600,
        'active': 1,
      },
      {
        'id': 'prod-2',
        'sku': 'RICE-25',
        'name': 'Rice 25kg',
        'unit': 'BAG',
        'sellPriceCents': 210000,
        'taxRateBp': 1600,
        'active': 1,
      },
    ]);

    // The server stamps a route at the *local* midnight of the working day and
    // serialises it as UTC — which, east of Greenwich, is the previous
    // calendar date. Seeding it exactly as the wire does is the point: the
    // fixture used to write naive local strings, which is why no unit test
    // ever saw the day-boundary bug.
    final today = DateTime.now();
    final localMidnight = DateTime(today.year, today.month, today.day);

    await db.upsertAll('routes', [
      {
        'id': 'route-1',
        'name': 'Nairobi CBD — Monday',
        'routeDate': localMidnight.toUtc().toIso8601String(),
        'status': 'IN_PROGRESS',
        'totalDistanceM': 12400,
        'estimatedMin': 95,
      },
    ]);

    await db.upsertAll('visits', [
      {
        'id': 'visit-1',
        'customerId': 'cust-1',
        'routeId': 'route-1',
        'status': 'SCHEDULED',
        'purpose': 'SALES',
        'scheduledAt': DateTime.now().toUtc().toIso8601String(),
        'geofenceVerified': 0,
        'dirty': 0,
      },
    ]);

    await db.upsertAll('route_stops', [
      {
        'id': 'stop-1',
        'routeId': 'route-1',
        'customerId': 'cust-1',
        'sequence': 1,
        'status': 'PENDING',
      },
    ]);
  });

  tearDown(() async => db.close());

  group('Outbox', () {
    test('queues an operation and reports it pending', () async {
      final uuid = await outbox.enqueue('order.create', {'customerId': 'cust-1'});

      expect(uuid, isNotEmpty);
      expect(await outbox.pendingCount(), 1);

      final pending = await outbox.pending();
      expect(pending.single.uuid, uuid);
      expect(pending.single.type, 'order.create');
    });

    test('each enqueue gets a distinct UUID — the idempotency key', () async {
      final a = await outbox.enqueue('order.create', {'x': 1});
      final b = await outbox.enqueue('order.create', {'x': 1});

      // Identical payloads must NOT collapse: two genuine orders for the same
      // goods are two orders, and only the client UUID distinguishes them.
      expect(a, isNot(b));
      expect(await outbox.pendingCount(), 2);
    });

    test('drains in the order the rep performed the work', () async {
      final first = await outbox.enqueue(
        OpType.orderCreate,
        {'n': 1},
        at: DateTime.now().subtract(const Duration(minutes: 10)),
      );
      final second = await outbox.enqueue(
        OpType.paymentCreate,
        {'n': 2},
        at: DateTime.now().subtract(const Duration(minutes: 5)),
      );

      // A payment against an order created earlier in the same batch only
      // resolves if order-before-payment is preserved.
      final pending = await outbox.pending();
      expect(pending.map((e) => e.uuid).toList(), [first, second]);
    });

    test('acknowledged entries leave the pending queue', () async {
      final uuid = await outbox.enqueue(OpType.orderCreate, {});
      await outbox.markSynced(uuid, serverId: 'cm-server-id');

      expect(await outbox.pendingCount(), 0);

      final entry = (await outbox.recent()).single;
      expect(entry.isPending, isFalse);
      expect(entry.serverId, 'cm-server-id');
    });

    test('repeated rejection marks an entry stuck rather than losing it', () async {
      final uuid = await outbox.enqueue(OpType.orderCreate, {});

      for (var i = 0; i < 5; i++) {
        await outbox.markFailed(uuid, 'Customer not found');
      }

      expect(await outbox.stuckCount(), 1);

      final entry = (await outbox.recent()).single;
      expect(entry.isStuck, isTrue);
      expect(entry.lastError, 'Customer not found');
      // Still present: work the rep did is never silently discarded.
      expect(entry.isPending, isTrue);
    });

    test('pruning keeps unsynced work and recent history', () async {
      final pending = await outbox.enqueue(OpType.orderCreate, {});
      final recent = await outbox.enqueue(OpType.paymentCreate, {});
      await outbox.markSynced(recent);

      await outbox.prune();

      final uuids = (await outbox.recent()).map((e) => e.uuid).toSet();
      expect(uuids, containsAll([pending, recent]));
    });

    test('payload survives the round trip through storage', () async {
      final uuid = await outbox.enqueue(OpType.orderCreate, {
        'customerId': 'cust-1',
        'lines': [
          {'productId': 'prod-1', 'quantity': 12},
        ],
      });

      final entry = (await outbox.pending()).single;
      expect(entry.uuid, uuid);
      expect(entry.payload['customerId'], 'cust-1');
      expect((entry.payload['lines'] as List).length, 1);

      // And it serialises into the shape /sync/push expects.
      final op = entry.toOperation();
      expect(op['uuid'], uuid);
      expect(op['type'], OpType.orderCreate);
      expect(op['at'], isA<String>());
      expect(jsonEncode(op), contains('prod-1'));
    });
  });

  group('Orders captured offline', () {
    test('writes locally and queues in one action', () async {
      final products = await repo.products();
      final uuid = await repo.createOrder(
        customerId: 'cust-1',
        lines: [
          CartLine(product: products.firstWhere((p) => p.id == 'prod-1'), quantity: 12),
          CartLine(product: products.firstWhere((p) => p.id == 'prod-2'), quantity: 30),
        ],
        visitId: 'visit-1',
      );

      expect(await outbox.pendingCount(), 1);

      final orders = await db.query('orders');
      expect(orders.length, 1);
      // The local id is namespaced so nothing can mistake it for a server id.
      expect(orders.single['id'], 'local:$uuid');
      expect(orders.single['clientUuid'], uuid);
      expect(orders.single['channel'], 'FIELD');
    });

    test('total matches the server VAT calculation exactly', () async {
      final products = await repo.products();

      await repo.createOrder(
        customerId: 'cust-1',
        lines: [
          CartLine(product: products.firstWhere((p) => p.id == 'prod-1'), quantity: 12),
        ],
      );

      // 12 × 1,500 = 18,000 net, +16% VAT = 20,880 → 2,088,000 cents.
      final order = (await db.query('orders')).single;
      expect(order['totalCents'], 2088000);
    });

    test('an empty order is refused before it reaches the queue', () async {
      expect(
        () => repo.createOrder(customerId: 'cust-1', lines: []),
        throwsA(isA<StateError>()),
      );
      expect(await outbox.pendingCount(), 0);
    });

    test('a local visit id is not sent to the server', () async {
      final products = await repo.products();
      await repo.createOrder(
        customerId: 'cust-1',
        lines: [CartLine(product: products.first, quantity: 1)],
        visitId: 'local:some-unsynced-visit',
      );

      // A reference the server cannot resolve would fail the whole operation,
      // so it is dropped rather than sent.
      final entry = (await outbox.pending()).single;
      expect(entry.payload.containsKey('visitId'), isFalse);
    });
  });

  group('Payments captured offline', () {
    test('reduces the customer balance immediately', () async {
      await repo.recordPayment(customerId: 'cust-1', amountCents: 5000000);

      final customer = await repo.customer('cust-1');
      // The rep is holding the cash; the balance must reflect that at once,
      // not after the next sync.
      expect(customer!.balanceCents, 21450000 - 5000000);
      expect(await outbox.pendingCount(), 1);
    });

    test('rejects a zero or negative amount', () async {
      expect(
        () => repo.recordPayment(customerId: 'cust-1', amountCents: 0),
        throwsA(isA<StateError>()),
      );
      expect(await outbox.pendingCount(), 0);
    });

    test('overpayment is allowed and leaves a credit', () async {
      // Prepayments are real; refusing them would strand the rep.
      await repo.recordPayment(customerId: 'cust-1', amountCents: 30000000);

      final customer = await repo.customer('cust-1');
      expect(customer!.balanceCents, lessThan(0));
    });
  });

  group('Check-in and check-out', () {
    test('verifies a check-in at the shop and advances the route stop', () async {
      final result = await repo.checkIn(
        visitId: 'visit-1',
        latitude: -1.28472 + 0.0002,
        longitude: 36.82361,
        accuracyM: 14,
        geofencingEnabled: true,
      );

      expect(result.verified, isTrue);
      expect(result.distanceM, lessThan(150));

      final visit = await repo.visit('visit-1');
      expect(visit!.status, 'IN_PROGRESS');
      expect(visit.geofenceVerified, isTrue);
      expect(visit.dirty, isTrue);

      final stop = (await db.query('route_stops')).single;
      expect(stop['status'], 'ARRIVED');
    });

    test('records an out-of-range check-in but does not verify it', () async {
      final result = await repo.checkIn(
        visitId: 'visit-1',
        latitude: -1.28472 + 0.01, // ~1.1km away
        longitude: 36.82361,
        accuracyM: 10,
        geofencingEnabled: true,
      );

      expect(result.verified, isFalse);

      final visit = await repo.visit('visit-1');
      // Still checked in — the rep is not blocked, the visit is just flagged.
      expect(visit!.status, 'IN_PROGRESS');
      expect(visit.geofenceVerified, isFalse);
      expect(visit.distanceFromCustomerM, greaterThan(1000));
    });

    test('does not claim verification when Geofencing is not licensed', () async {
      final result = await repo.checkIn(
        visitId: 'visit-1',
        latitude: -1.28472,
        longitude: 36.82361,
        accuracyM: 5,
        geofencingEnabled: false,
      );

      // The position is a match, but the company has not bought Module 08.
      // Showing a green tick the back office does not agree with would be worse
      // than showing nothing.
      expect(result.verified, isTrue);
      final visit = await repo.visit('visit-1');
      expect(visit!.geofenceVerified, isFalse);
    });

    test('refuses a second check-in on the same visit', () async {
      await repo.checkIn(
        visitId: 'visit-1',
        latitude: -1.28472,
        longitude: 36.82361,
        geofencingEnabled: true,
      );

      expect(
        () => repo.checkIn(
          visitId: 'visit-1',
          latitude: -1.28472,
          longitude: 36.82361,
          geofencingEnabled: true,
        ),
        throwsA(isA<StateError>()),
      );
    });

    test('check-out derives duration and closes the stop', () async {
      await repo.checkIn(
        visitId: 'visit-1',
        latitude: -1.28472,
        longitude: 36.82361,
        geofencingEnabled: true,
      );
      await repo.checkOut(visitId: 'visit-1', outcome: 'Order placed');

      final visit = await repo.visit('visit-1');
      expect(visit!.status, 'COMPLETED');
      expect(visit.durationMin, isNotNull);
      expect(visit.outcome, 'Order placed');

      final stop = (await db.query('route_stops')).single;
      expect(stop['status'], 'DONE');

      // Two operations queued: the check-in and the check-out.
      expect(await outbox.pendingCount(), 2);
    });

    test('check-out before check-in is refused', () async {
      expect(
        () => repo.checkOut(visitId: 'visit-1'),
        throwsA(isA<StateError>()),
      );
    });
  });

  group('Customers created in the field', () {
    test('gets a namespaced local id and is flagged pending', () async {
      final customer = await repo.createCustomer(
        name: 'Kariobangi Grocers',
        phone: '0722123456',
        town: 'Kariobangi',
        latitude: -1.24,
        longitude: 36.88,
      );

      expect(customer.id, startsWith('local:'));
      expect(customer.isPending, isTrue);
      expect(customer.hasPin, isTrue);
      expect(await outbox.pendingCount(), 1);
    });

    test('appears in the searchable customer book straight away', () async {
      await repo.createCustomer(name: 'Kariobangi Grocers');

      final found = await repo.customers(search: 'Kariobangi');
      expect(found.single.name, 'Kariobangi Grocers');
    });

    test('a pin correction on an unsynced customer is not sent by id', () async {
      final customer = await repo.createCustomer(name: 'Kariobangi Grocers');
      await repo.updateCustomerLocation(customer.id, latitude: -1.24, longitude: 36.88);

      // Only the create is queued: the server has no id to update yet, and
      // sending one would fail. The pin rides along on the create instead.
      final pending = await outbox.pending();
      expect(pending.length, 1);
      expect(pending.single.type, OpType.customerCreate);

      final updated = await repo.customer(customer.id);
      expect(updated!.latitude, -1.24);
    });

    test('a pin correction on a synced customer queues an update', () async {
      await repo.updateCustomerLocation('cust-2', latitude: -1.267, longitude: 36.802);

      final pending = await outbox.pending();
      expect(pending.single.type, OpType.customerUpdate);
      expect(pending.single.payload['id'], 'cust-2');
    });
  });

  group('Search and day summary', () {
    test('search matches name, code, phone and town', () async {
      expect((await repo.customers(search: 'Nairobi Fresh')).length, 1);
      expect((await repo.customers(search: 'CUS-0002')).length, 1);
      expect((await repo.customers(search: '722000010')).length, 1);
      expect((await repo.customers(search: 'Westlands')).length, 1);
      expect((await repo.customers(search: 'nonexistent')), isEmpty);
    });

    test('owing filter excludes settled accounts', () async {
      final owing = await repo.customers(owingOnly: true);
      expect(owing.map((c) => c.id), ['cust-1']);
    });

    test('day summary counts the rep\'s own work', () async {
      final products = await repo.products();
      await repo.createOrder(
        customerId: 'cust-1',
        lines: [CartLine(product: products.first, quantity: 10)],
      );
      await repo.recordPayment(customerId: 'cust-1', amountCents: 1000000);
      await repo.checkIn(
        visitId: 'visit-1',
        latitude: -1.28472,
        longitude: 36.82361,
        geofencingEnabled: true,
      );
      await repo.checkOut(visitId: 'visit-1');

      final summary = await repo.todaySummary();
      expect(summary.visitsPlanned, 1);
      expect(summary.visitsDone, 1);
      expect(summary.ordersCount, 1);
      expect(summary.collectionsCents, 1000000);
      expect(summary.salesCents, greaterThan(0));
    });
  });

  group('Placeholder ids adopt the server id', () {
    // The scenario the app exists for: a rep passes a shop that is not on the
    // route, creates the visit and checks in, all with no signal. Both ops
    // queue against `local:<uuid>`. When the create is acknowledged the
    // check-in must be rewritten to the id the server issued, or it is
    // rejected on every drain from then on and the rep's work is lost.
    test('a queued check-in follows the visit to its server id', () async {
      final visitId = await repo.createAdHocVisit(customerId: 'cust-1');
      expect(visitId, startsWith('local:'));

      await repo.checkIn(
        visitId: visitId,
        latitude: -1.28472,
        longitude: 36.82361,
        geofencingEnabled: true,
      );

      final uuid = visitId.substring('local:'.length);
      final rewritten = await outbox.remapId(visitId, 'srv-visit-1');
      expect(rewritten, 1, reason: 'the queued check-in was not rewritten');

      final queued = await outbox.pending();
      final checkin = queued.firstWhere((e) => e.type == OpType.visitCheckIn);
      expect(checkin.payload['visitId'], 'srv-visit-1');

      // The create's own payload never named the local id, so it is untouched.
      final create = queued.firstWhere((e) => e.uuid == uuid);
      expect(create.type, OpType.visitCreate);
    });

    test('an acknowledged payload is never rewritten', () async {
      final visitId = await repo.createAdHocVisit(customerId: 'cust-1');
      await repo.checkIn(
        visitId: visitId,
        latitude: -1.28472,
        longitude: 36.82361,
        geofencingEnabled: true,
      );

      // Everything already sent: the outbox is a record of what went over the
      // wire, so remapping must leave it alone.
      for (final entry in await outbox.pending()) {
        await outbox.markSynced(entry.uuid);
      }

      expect(await outbox.remapId(visitId, 'srv-visit-2'), 0);
    });
  });

  group('Day boundaries', () {
    // Regression: the store held two timestamp formats at once — UTC from the
    // server, naive local from offline writes — and every day-range query in
    // SQL compared across them. At UTC+3 the boundary sat three hours out, so
    // today's route was never matched and the route header read "Unplanned
    // visits" over a route that was sitting right there in the store.
    test("today's route is found even when its UTC date is yesterday", () async {
      final route = await repo.todaysRoute();

      expect(route, isNotNull, reason: 'route stamped at local midnight was missed');
      expect(route!.name, 'Nairobi CBD — Monday');
      expect(route.stops, hasLength(1));
    });

    test('every timestamp written offline is stored in UTC', () async {
      await repo.createAdHocVisit(customerId: 'cust-2');
      await repo.recordPayment(customerId: 'cust-1', amountCents: 5000);
      await repo.createOrder(
        customerId: 'cust-1',
        lines: [CartLine(product: (await repo.products()).first, quantity: 1)],
      );

      // One format in the store, or the comparisons above are meaningless.
      final stamps = <String, String>{
        'visits.scheduledAt': (await db.query('visits', where: "id LIKE 'local:%'"))
            .single['scheduledAt'] as String,
        'payments.paidAt': (await db.query('payments')).single['paidAt'] as String,
        'orders.orderDate': (await db.query('orders')).single['orderDate'] as String,
      };

      stamps.forEach((column, value) {
        expect(value, endsWith('Z'), reason: '$column is not UTC: $value');
      });
    });

    test('a visit created late in the local evening still counts as today', () async {
      final id = await repo.createAdHocVisit(customerId: 'cust-2');
      final todays = await repo.visitsForDay();

      expect(todays.map((v) => v.id), contains(id));
    });
  });

  group('Sign-out safety', () {
    test('wipe clears the mirror and the queue together', () async {
      await repo.createOrder(
        customerId: 'cust-1',
        lines: [CartLine(product: (await repo.products()).first, quantity: 1)],
      );
      expect(await outbox.pendingCount(), 1);

      await db.wipe();

      expect(await outbox.pendingCount(), 0);
      expect(await repo.customers(), isEmpty);
      // A shared handset must not leak one rep's customer book to the next.
      expect(await db.count('orders'), 0);
    });
  });
}
