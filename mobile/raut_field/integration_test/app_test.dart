import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:raut_field/core/api_client.dart';
import 'package:raut_field/core/auth_service.dart';
import 'package:raut_field/core/config.dart';
import 'package:raut_field/core/local_db.dart';
import 'package:raut_field/core/outbox.dart';
import 'package:raut_field/core/sync_service.dart';
import 'package:raut_field/data/field_repository.dart';
import 'package:raut_field/main.dart';
import 'package:raut_field/models/models.dart';

/// On-device tests that drive the real app against a running platform.
///
/// Unlike the unit tests, these exercise the parts that only exist on a
/// handset: the sqflite engine, the HTTP stack, the widget tree and the sync
/// engine working together. They need the Raut platform running and reachable
/// at [AppConfig.apiBase] — from an emulator that means 10.0.2.2, not
/// localhost.
///
///   flutter test integration_test/app_test.dart -d emulator-5554 \
///     --dart-define=RAUT_API_BASE=http://10.0.2.2:3200
void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  const email = 'rep@zamarsolutions.co.ke';
  const password = 'Raut@2026';

  group('Platform reachability', () {
    testWidgets('the server is up and healthy', (tester) async {
      final api = ApiClient();
      final health = await api.get('/health');
      expect(health['status'], 'healthy');
      api.dispose();
    });
  });

  group('Sign-in', () {
    testWidgets('rejects a wrong password without signing in', (tester) async {
      final db = LocalDb.instance;
      final api = ApiClient();
      final auth = AuthService(api: api, db: db);

      final ok = await auth.signIn(email, 'definitely-not-the-password');

      expect(ok, isFalse);
      expect(auth.isSignedIn, isFalse);
      expect(auth.error, isNotNull);
      api.dispose();
    });

    testWidgets('signs a field rep in and reports their licences', (tester) async {
      final db = LocalDb.instance;
      final api = ApiClient();
      final auth = AuthService(api: api, db: db);

      final ok = await auth.signIn(email, password);

      expect(ok, isTrue, reason: auth.error ?? 'sign-in failed');
      expect(auth.session!.role, 'FIELD_REP');
      // The tenant, not the product. A rep signs in to a company on Raut —
      // asserting 'Raut' here would be asserting the platform's own name against
      // a customer record, which is exactly backwards.
      expect(auth.session!.companyName, contains('Zamar Solutions'));

      // The seeded tenant holds all ten modules, so the field-facing
      // capabilities must all be on.
      expect(auth.session!.hasModule('FIELD_SALES'), isTrue);
      expect(auth.session!.geofencingEnabled, isTrue);
      expect(auth.session!.routingEnabled, isTrue);
      expect(auth.session!.canTakePayments, isTrue);

      api.dispose();
    });
  });

  group('Sync against the live platform', () {
    late LocalDb db;
    late ApiClient api;
    late Outbox outbox;
    late AuthService auth;
    late SyncService sync;
    late FieldRepository repo;

    setUp(() async {
      db = LocalDb.instance;
      await db.wipe();

      api = ApiClient();
      outbox = Outbox(db);
      auth = AuthService(api: api, db: db);
      sync = SyncService(api: api, db: db, outbox: outbox);
      repo = FieldRepository(db: db, outbox: outbox);

      final ok = await auth.signIn(email, password);
      expect(ok, isTrue, reason: auth.error ?? 'sign-in failed');
      await sync.reset();
    });

    tearDown(() => api.dispose());

    testWidgets('a full sync fills the offline store', (tester) async {
      final ok = await sync.sync(reason: 'integration-test');
      expect(ok, isTrue, reason: sync.status.message);

      final customers = await repo.customers();
      final products = await repo.products();

      expect(customers, isNotEmpty, reason: 'no customers downloaded');
      expect(products, isNotEmpty, reason: 'no products downloaded');
      expect(sync.status.lastSyncedAt, isNotNull);

      // Pins are what make routing and geofencing possible at all.
      expect(customers.any((c) => c.hasPin), isTrue);
    });

    testWidgets('work captured offline reaches the server exactly once',
        (tester) async {
      await sync.sync(reason: 'bootstrap');

      final customer = (await repo.customers()).firstWhere((c) => c.hasPin);
      final products = await repo.products();

      // Queue an order and a payment with no attempt to send them — this is
      // the state a handset is in when the rep is out of coverage.
      await repo.createOrder(
        customerId: customer.id,
        lines: [CartLine(product: products.first, quantity: 6)],
        note: 'on-device integration test',
      );
      await repo.recordPayment(
        customerId: customer.id,
        amountCents: 1500000,
        method: 'MPESA',
        reference: 'DEVICE-TEST',
      );

      expect(await outbox.pendingCount(), 2);

      // Signal returns.
      final drained = await sync.sync(reason: 'reconnect');
      expect(drained, isTrue, reason: sync.status.message);
      expect(await outbox.pendingCount(), 0, reason: 'queue did not drain');

      // A second sync must not resend anything.
      await sync.sync(reason: 'second-pass');
      expect(await outbox.pendingCount(), 0);

      // The server assigned real numbers, which came back on the pull.
      final orders = await db.query(
        'orders',
        where: "number != 'PENDING'",
        orderBy: 'orderDate DESC',
      );
      expect(orders, isNotEmpty, reason: 'no server-numbered order came back');
    });

    testWidgets('a customer created offline syncs and comes back real',
        (tester) async {
      await sync.sync(reason: 'bootstrap');

      final name = 'Device Test Shop ${DateTime.now().millisecondsSinceEpoch}';
      final created = await repo.createCustomer(
        name: name,
        phone: '0722000999',
        town: 'Nairobi',
        latitude: -1.2921,
        longitude: 36.8219,
      );

      expect(created.id, startsWith('local:'));
      expect(created.isPending, isTrue);

      await sync.sync(reason: 'push-customer');
      expect(await outbox.pendingCount(), 0);

      // The real record arrives on the pull with a server-issued code.
      final matches = await repo.customers(search: name);
      expect(matches, isNotEmpty);
      expect(
        matches.any((c) => !c.id.startsWith('local:')),
        isTrue,
        reason: 'server copy of the customer did not come back',
      );
    });

    testWidgets('offline check-in verifies against the customer geofence',
        (tester) async {
      await sync.sync(reason: 'bootstrap');

      final customer = (await repo.customers()).firstWhere((c) => c.hasPin);
      await repo.createAdHocVisit(customerId: customer.id);

      // Sync so the visit gets a server id. The local `local:` id it was
      // created with is deliberately discarded here — the server-issued one
      // is looked up from the day's visits below.
      await sync.sync(reason: 'push-visit');

      // Only this customer's visits, and only a checkable one. Falling back to
      // an arbitrary visit and returning early when it could not be checked in
      // meant the test could pass having asserted nothing — which is how it
      // came to flake against a store that accumulates visits across runs.
      final todays = await repo.visitsForDay();
      final mine = todays.where((v) => v.customerId == customer.id).toList();
      expect(
        mine,
        isNotEmpty,
        reason: 'the ad-hoc visit just created for ${customer.name} is not in today\'s visits',
      );

      final checkable = mine.where((v) => v.canCheckIn).toList();
      expect(
        checkable,
        isNotEmpty,
        reason: 'no checkable visit for ${customer.name}; '
            '${mine.length} visit(s) with status ${mine.map((v) => v.status).join(", ")}',
      );
      final visit = checkable.first;

      final verification = await repo.checkIn(
        visitId: visit.id,
        latitude: customer.latitude! + 0.0002,
        longitude: customer.longitude!,
        accuracyM: 12,
        geofencingEnabled: true,
      );

      expect(verification.verified, isTrue, reason: verification.reason);
      expect(verification.distanceM, lessThan(150));

      final after = await repo.visit(visit.id);
      expect(after!.status, 'IN_PROGRESS');
      expect(after.geofenceVerified, isTrue);

      await sync.sync(reason: 'push-checkin');
      expect(await outbox.pendingCount(), 0);
    });
  });

  group('Screens refresh when a sync lands', () {
    testWidgets('route and customers populate without a manual pull', (tester) async {
      // The regression this guards: a sync writes straight to the local store,
      // which FieldRepository never observes. Screens that load their data once
      // in initState therefore kept rendering the pre-sync empty state, and the
      // rep had to pull-to-refresh on the first screen they ever saw.
      await LocalDb.instance.wipe();
      await (await SharedPreferences.getInstance()).clear();

      await tester.pumpWidget(buildRautApp());
      await tester.pumpAndSettle(const Duration(seconds: 2));

      await tester.enterText(find.byType(TextFormField).at(0), email);
      await tester.enterText(find.byType(TextFormField).at(1), password);
      await tester.tap(find.widgetWithText(FilledButton, 'Sign in'));

      // Give the sign-in sync room to finish, then stop pumping. No manual
      // refresh anywhere in this test.
      final deadline = DateTime.now().add(const Duration(seconds: 60));
      var populated = false;
      while (DateTime.now().isBefore(deadline)) {
        await tester.pumpAndSettle(const Duration(milliseconds: 500));
        if (find.byType(Card).evaluate().isNotEmpty) {
          populated = true;
          break;
        }
      }

      expect(
        populated,
        isTrue,
        reason: 'route did not populate after the sign-in sync — the screen is '
            'not reloading when the sync watermark moves',
      );
    });
  });

  group('App shell', () {
    setUp(() async {
      // Both stores must be cleared: the session lives in SharedPreferences,
      // so wiping only sqflite would leave the earlier sign-in tests' session
      // in place and the app would open on the route, not the login screen.
      await LocalDb.instance.wipe();
      await (await SharedPreferences.getInstance()).clear();
    });

    testWidgets('cold start shows the login screen', (tester) async {
      await tester.pumpWidget(buildRautApp());
      await tester.pumpAndSettle(const Duration(seconds: 3));

      // Not signed in, so the app must land on sign-in rather than an empty
      // route the rep cannot explain.
      expect(find.byType(TextFormField), findsNWidgets(2));
      expect(find.widgetWithText(FilledButton, 'Sign in'), findsOneWidget);
    });

    testWidgets('the login screen shows which server it will talk to',
        (tester) async {
      await tester.pumpWidget(buildRautApp());
      await tester.pumpAndSettle(const Duration(seconds: 3));

      // The commonest setup failure is pointing at the wrong host, and it is
      // invisible unless the app says so. Matched by widget rather than
      // find.text because the address is rendered in a SelectableText.
      expect(
        find.byWidgetPredicate(
          (w) => w is SelectableText && w.data == AppConfig.apiBase,
        ),
        findsOneWidget,
      );
    });
  });
}
