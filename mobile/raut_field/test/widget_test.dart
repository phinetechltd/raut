import 'package:flutter_test/flutter_test.dart';

import 'package:raut_field/core/geo.dart';
import 'package:raut_field/core/money.dart';

/// These tests guard the two places where the handset and the server compute
/// the same thing independently. If they ever disagree, a rep reads one figure
/// to a shopkeeper and the office invoices another — so the arithmetic is
/// pinned here rather than trusted.
void main() {
  group('Money — must match src/lib/money.ts', () {
    test('line total applies VAT after discount', () {
      // 12 × KES 1,500 = 18,000 gross, +16% VAT = 20,880
      expect(
        Money.lineTotal(quantity: 12, unitPriceCents: 150000, taxRateBp: 1600),
        2088000,
      );
    });

    test('discount reduces the taxable amount, not just the total', () {
      // 10 × 1,000 = 10,000 gross, less 1,000 discount = 9,000 net,
      // +16% = 10,440. Taxing the gross would have given 10,600.
      expect(
        Money.lineTotal(
          quantity: 10,
          unitPriceCents: 100000,
          discountCents: 100000,
          taxRateBp: 1600,
        ),
        1044000,
      );
    });

    test('discount cannot exceed the line and drive the total negative', () {
      expect(
        Money.lineTotal(
          quantity: 1,
          unitPriceCents: 5000,
          discountCents: 999999,
          taxRateBp: 1600,
        ),
        0,
      );
    });

    test('zero-rated products carry no VAT', () {
      expect(
        Money.lineTotal(quantity: 3, unitPriceCents: 20000, taxRateBp: 0),
        60000,
      );
    });

    test('cents conversion rounds rather than truncates', () {
      expect(Money.toCents(1234.567), 123457);
      expect(Money.toCents(0.005), 1);
    });

    test('formats the way the proposal mockups show', () {
      expect(Money.format(21450000), 'KES 214,500');
      expect(Money.compact(1840000000), 'KES 18.4M');
    });
  });

  group('Geo — must match src/lib/geo.ts', () {
    test('haversine distance is accurate at city scale', () {
      // Nairobi CBD to Eastlands.
      final metres = Geo.distanceM(-1.28472, 36.82361, -1.28640, 36.89150);
      expect(metres, greaterThan(7400));
      expect(metres, lessThan(7700));
    });

    test('distance to the same point is zero', () {
      expect(Geo.distanceM(-1.28472, 36.82361, -1.28472, 36.82361), 0);
    });

    test('point inside a territory polygon is detected', () {
      // The seeded Nairobi Central ring.
      final polygon = Geo.parseBoundary(
        '[[-1.22,36.76],[-1.22,36.92],[-1.34,36.92],[-1.34,36.76]]',
      );
      expect(polygon.length, 4);
      expect(Geo.insidePolygon(-1.28472, 36.82361, polygon), isTrue);
    });

    test('point outside the polygon is rejected', () {
      final polygon = Geo.parseBoundary(
        '[[-1.22,36.76],[-1.22,36.92],[-1.34,36.92],[-1.34,36.76]]',
      );
      // Mombasa is nowhere near Nairobi Central.
      expect(Geo.insidePolygon(-4.05466, 39.66359, polygon), isFalse);
    });

    test('malformed boundary data yields an empty ring, not a crash', () {
      expect(Geo.parseBoundary('not json'), isEmpty);
      expect(Geo.parseBoundary(null), isEmpty);
      expect(Geo.parseBoundary('[]'), isEmpty);
    });
  });

  group('Visit verification', () {
    const customerLat = -1.28472;
    const customerLng = 36.82361;

    test('a check-in at the shop verifies', () {
      final result = verifyVisitLocation(
        checkInLat: customerLat + 0.0002,
        checkInLng: customerLng,
        customerLat: customerLat,
        customerLng: customerLng,
        geofenceRadiusM: 150,
        accuracyM: 15,
      );
      expect(result.verified, isTrue);
      expect(result.distanceM, lessThan(150));
    });

    test('a check-in a kilometre away does not verify', () {
      final result = verifyVisitLocation(
        checkInLat: customerLat + 0.01,
        checkInLng: customerLng,
        customerLat: customerLat,
        customerLng: customerLng,
        geofenceRadiusM: 150,
        accuracyM: 10,
      );
      expect(result.verified, isFalse);
      expect(result.reason, contains('outside'));
    });

    test('poor GPS accuracy widens the allowance', () {
      // ~200m out with a 150m fence fails on a good fix, but a 90m accuracy
      // reading extends the allowance to 240m — a rep in a doorway under a
      // tin roof must not be marked absent by their own handset.
      const offset = 0.0018;

      expect(
        verifyVisitLocation(
          checkInLat: customerLat + offset,
          checkInLng: customerLng,
          customerLat: customerLat,
          customerLng: customerLng,
          geofenceRadiusM: 150,
          accuracyM: 5,
        ).verified,
        isFalse,
      );

      expect(
        verifyVisitLocation(
          checkInLat: customerLat + offset,
          checkInLng: customerLng,
          customerLat: customerLat,
          customerLng: customerLng,
          geofenceRadiusM: 150,
          accuracyM: 90,
        ).verified,
        isTrue,
      );
    });

    test('the accuracy allowance is capped so it cannot be gamed', () {
      // A handset reporting 10km accuracy must not thereby verify a check-in
      // from another part of town.
      final result = verifyVisitLocation(
        checkInLat: customerLat + 0.05,
        checkInLng: customerLng,
        customerLat: customerLat,
        customerLng: customerLng,
        geofenceRadiusM: 150,
        accuracyM: 10000,
      );
      expect(result.verified, isFalse);
    });

    test('a customer with no pin cannot be verified', () {
      final result = verifyVisitLocation(
        checkInLat: customerLat,
        checkInLng: customerLng,
        customerLat: null,
        customerLng: null,
        geofenceRadiusM: 150,
      );
      expect(result.verified, isFalse);
      expect(result.distanceM, isNull);
      expect(result.reason, contains('no GPS pin'));
    });
  });
}
