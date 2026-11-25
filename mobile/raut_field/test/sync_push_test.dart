import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

import 'package:raut_field/core/api_client.dart';
import 'package:raut_field/core/local_db.dart';
import 'package:raut_field/core/outbox.dart';
import 'package:raut_field/core/sync_service.dart';

/// A server that answers each pushed operation the way a test tells it to.
class FakeApi implements ApiClient {
  FakeApi(this.answer);

  final Map<String, dynamic> Function(Map<String, dynamic> op) answer;
  final pushed = <Map<String, dynamic>>[];

  @override
  bool get hasSession => true;

  @override
  Future<Map<String, dynamic>> post(String path, Object? body) async {
    if (path != '/sync/push') return const {};
    final ops = ((body! as Map)['operations'] as List).cast<Map<String, dynamic>>();
    pushed.addAll(ops);
    return {'results': ops.map(answer).toList()};
  }

  @override
  Future<Map<String, dynamic>> get(String path, {Map<String, String>? query}) async => {
        'entities': <String, dynamic>{},
        'syncedAt': DateTime.now().toUtc().toIso8601String(),
      };

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

Map<String, dynamic> applied(Map<String, dynamic> op) =>
    {'uuid': op['uuid'], 'status': 'applied', 'entityId': 'srv-${op['uuid']}'};

/// What the push endpoint does with an operation the rep's role or the
/// company's licence does not allow.
Map<String, dynamic> refused(Map<String, dynamic> op) => {
      'uuid': op['uuid'],
      'status': 'failed',
      'code': 'FORBIDDEN',
      'error': 'Your role does not permit this action',
    };

Map<String, dynamic> broken(Map<String, dynamic> op) =>
    {'uuid': op['uuid'], 'status': 'failed', 'error': 'Customer not found'};

void main() {
  sqfliteFfiInit();
  databaseFactory = databaseFactoryFfi;

  late LocalDb db;
  late Outbox outbox;

  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    db = LocalDb.at(inMemoryDatabasePath);
    outbox = Outbox(db);
  });

  tearDown(() async => db.close());

  SyncService serviceFor(FakeApi api) => SyncService(api: api, db: db, outbox: outbox);

  Future<void> bufferPings(int n, {int? batteryPct}) async {
    final start = DateTime.utc(2026, 9, 19, 6);
    for (var i = 0; i < n; i++) {
      await db.insert('location_buffer', {
        'latitude': -1.28,
        'longitude': 36.82,
        'batteryPct': ?batteryPct,
        'recordedAt': start.add(Duration(minutes: i)).toIso8601String(),
      });
    }
  }

  group('Refused work', () {
    test('is shown as stuck at once, and kept', () async {
      await outbox.enqueue(OpType.paymentCreate, {'customerId': 'c1', 'amountCents': 500});

      await serviceFor(FakeApi((op) => refused(op))).sync();

      // Retrying cannot change a refusal, so there is no point spending four
      // more cycles failing quietly before the rep is told.
      expect(await outbox.stuckCount(), 1);
      expect(await outbox.pendingCount(), 1, reason: 'refused work is never thrown away');
      final entry = (await outbox.pending()).single;
      expect(entry.lastError, 'Your role does not permit this action');
    });

    test('an operation that merely failed is retried, not declared stuck', () async {
      await outbox.enqueue(OpType.paymentCreate, {'customerId': 'c1', 'amountCents': 500});

      await serviceFor(FakeApi((op) => broken(op))).sync();

      expect(await outbox.stuckCount(), 0);
      expect((await outbox.pending()).single.attempts, 1);
    });
  });

  group('Location breadcrumbs', () {
    test('a sent batch clears only the pings it carried', () async {
      // More than one batch holds. Clearing the whole buffer on success threw
      // away every ping after the first 400 — most of an offline afternoon.
      await bufferPings(450);
      final api = FakeApi((op) => applied(op));

      await serviceFor(api).sync();

      final batch = api.pushed.singleWhere((op) => op['type'] == 'location.batch');
      final sent = ((batch['payload'] as Map)['pings'] as List).length;
      expect(sent, 400);
      expect(await db.count('location_buffer'), 50, reason: 'the unsent pings are still waiting');
    });

    test('a batch that failed to apply is kept for the next cycle', () async {
      await bufferPings(10);

      await serviceFor(FakeApi((op) => broken(op))).sync();

      expect(await db.count('location_buffer'), 10);
    });

    test('a refused batch is dropped rather than retried for ever', () async {
      await bufferPings(10);

      await serviceFor(FakeApi((op) => refused(op))).sync();

      expect(await db.count('location_buffer'), 0);
    });

    test('the battery level rides along with each breadcrumb', () async {
      await bufferPings(3, batteryPct: 42);
      final api = FakeApi((op) => applied(op));

      await serviceFor(api).sync();

      final batch = api.pushed.singleWhere((op) => op['type'] == 'location.batch');
      final pings = ((batch['payload'] as Map)['pings'] as List).cast<Map<String, dynamic>>();
      expect(pings, hasLength(3));
      expect(pings.every((p) => p['batteryPct'] == 42), isTrue);
    });

    test('an unknown battery level is omitted, not sent as null', () async {
      await bufferPings(1);
      final api = FakeApi((op) => applied(op));

      await serviceFor(api).sync();

      final batch = api.pushed.singleWhere((op) => op['type'] == 'location.batch');
      final ping = (((batch['payload'] as Map)['pings'] as List).single) as Map;
      expect(ping.containsKey('batteryPct'), isFalse);
    });
  });

  group('Odometer readings', () {
    test('are queued as route.odometer and drained like any other write', () async {
      await outbox.enqueue('route.odometer', {'routeId': 'r1', 'odometerStartKm': 84210});
      final api = FakeApi((op) => applied(op));

      await serviceFor(api).sync();

      final op = api.pushed.singleWhere((o) => o['type'] == 'route.odometer');
      expect(op['payload'], {'routeId': 'r1', 'odometerStartKm': 84210});
      expect(op['uuid'], isNotEmpty, reason: 'the server dedupes on the uuid');
      expect(await outbox.pendingCount(), 0);
    });

    test('a reading the server could not apply is retried, and a refused one is shown as stuck', () async {
      await outbox.enqueue('route.odometer', {'routeId': 'gone', 'odometerEndKm': 84300});
      await serviceFor(FakeApi((op) => broken(op))).sync();
      expect((await outbox.pending()).single.attempts, 1);
      expect(await outbox.stuckCount(), 0);

      await serviceFor(FakeApi((op) => refused(op))).sync();
      expect(await outbox.stuckCount(), 1);
      expect(await outbox.pendingCount(), 1, reason: 'the reading is kept for the rep to see');
    });
  });
}
