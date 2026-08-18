import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:raut_field/core/local_db.dart';
import 'package:raut_field/main.dart';

/// Walks the app and photographs each screen.
///
/// Run through `flutter drive`, not `flutter test` — the driver is what
/// receives the image bytes. See test_driver/integration_test.dart.
///
/// Needs the platform running and reachable at RAUT_API_BASE.
void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('capture the field app UI', (tester) async {
    // Start from a signed-out device so the login screen is real.
    await LocalDb.instance.wipe();
    await (await SharedPreferences.getInstance()).clear();

    await tester.pumpWidget(buildRautApp());
    await tester.pumpAndSettle(const Duration(seconds: 3));

    // Android renders Flutter into a SurfaceView that screen capture cannot
    // read; this swaps it for an offscreen image the engine can hand back.
    await binding.convertFlutterSurfaceToImage();
    await tester.pumpAndSettle();

    await binding.takeScreenshot('01-login');

    // ── sign in ───────────────────────────────────────────────────────
    final fields = find.byType(TextFormField);
    expect(fields, findsNWidgets(2), reason: 'login form not found');

    await tester.enterText(fields.at(0), 'rep@zamarsolutions.co.ke');
    await tester.pumpAndSettle();
    await tester.enterText(fields.at(1), 'Raut@2026');
    await tester.pumpAndSettle();
    await binding.takeScreenshot('02-login-filled');

    await tester.tap(find.widgetWithText(FilledButton, 'Sign in'));

    // Sign-in kicks off the first sync, which pulls the whole customer book,
    // the route and 90 days of documents. Screenshotting too early catches the
    // empty state mid-pull — which is what happened on the first attempt and
    // read as a bug rather than a race. Wait for real content, with a ceiling
    // so a genuine failure still surfaces instead of hanging.
    final deadline = DateTime.now().add(const Duration(seconds: 45));
    while (DateTime.now().isBefore(deadline)) {
      await tester.pumpAndSettle(const Duration(seconds: 2));
      if (find.byType(Card).evaluate().isNotEmpty) break;
    }
    await tester.pumpAndSettle(const Duration(seconds: 2));
    await binding.takeScreenshot('03-route');

    // ── customers ─────────────────────────────────────────────────────
    final customersTab = find.text('Customers');
    if (customersTab.evaluate().isNotEmpty) {
      await tester.tap(customersTab.first);
      await tester.pumpAndSettle(const Duration(seconds: 3));
      await binding.takeScreenshot('04-customers');
    }

    // ── today ─────────────────────────────────────────────────────────
    final todayTab = find.text('Today');
    if (todayTab.evaluate().isNotEmpty) {
      await tester.tap(todayTab.first);
      await tester.pumpAndSettle(const Duration(seconds: 3));
      await binding.takeScreenshot('05-today');
    }

    // ── more ──────────────────────────────────────────────────────────
    final moreTab = find.text('More');
    if (moreTab.evaluate().isNotEmpty) {
      await tester.tap(moreTab.first);
      await tester.pumpAndSettle(const Duration(seconds: 3));
      await binding.takeScreenshot('06-more');
    }

    // ── a visit, which is the app's core screen ───────────────────────
    final routeTab = find.text('Route');
    if (routeTab.evaluate().isNotEmpty) {
      await tester.tap(routeTab.first);
      await tester.pumpAndSettle(const Duration(seconds: 3));

      final stop = find.byType(Card);
      if (stop.evaluate().length > 1) {
        await tester.tap(stop.at(1));

        // The visit screen pushes a route *and* loads the customer, the visit
        // and its outstanding invoices. Settling once caught the push
        // transition mid-flight — a blank frame with a ghosted nav bar, which
        // looks like a broken screen rather than a race. Wait for the loaded
        // screen, on the same pattern as the route above.
        final visitDeadline = DateTime.now().add(const Duration(seconds: 30));
        while (DateTime.now().isBefore(visitDeadline)) {
          await tester.pumpAndSettle(const Duration(seconds: 1));
          if (find.text('Outstanding invoices').evaluate().isNotEmpty) break;
        }
        await tester.pumpAndSettle(const Duration(seconds: 2));
        await binding.takeScreenshot('07-visit');
      }
    }
  });
}
