import 'package:flutter_test/flutter_test.dart';

import 'package:raut_field/core/money.dart';
import 'package:raut_field/models/models.dart';

/// A faithful mirror of the server's computeLine
/// (platform/src/lib/money.ts): discount capped at the gross line, VAT on the
/// discounted consideration, tax rounded half-up. If the handset ever drifts
/// from the back office, a case here fails — which is the whole point, because
/// the drift otherwise surfaces as a customer disputing a receipt.
Map<String, int> serverLine(int qty, int unit, int disc, int bp) {
  final gross = qty * unit;
  final d = disc > gross ? gross : disc;
  final net = gross - d;
  final tax = (net * bp / 10000).round();
  return {'gross': gross, 'discount': d, 'net': net, 'tax': tax, 'total': net + tax};
}

void main() {
  group('Money.lineTotal matches the server computeLine', () {
    test('a discounted, taxed line', () {
      final e = serverLine(3, 25000, 1000, 1600);
      expect(Money.lineTotal(quantity: 3, unitPriceCents: 25000, discountCents: 1000, taxRateBp: 1600), e['total']);
    });

    test('discount never drives the line below zero', () {
      expect(Money.lineTotal(quantity: 1, unitPriceCents: 5000, discountCents: 999999, taxRateBp: 1600), 0);
    });

    test('a VAT-exempt line carries no tax', () {
      expect(Money.lineTotal(quantity: 4, unitPriceCents: 12000, taxRateBp: 0), 48000);
    });
  });

  group('CartLine totals match the server', () {
    Product p(int price, {int bp = 1600}) => Product(id: 'p', name: 'X', sellPriceCents: price, taxRateBp: bp);

    test('gross, discount, net, tax and total line up', () {
      final l = CartLine(product: p(25000), quantity: 3, discountCents: 1000);
      final e = serverLine(3, 25000, 1000, 1600);
      expect(l.grossCents, e['gross']);
      expect(l.effectiveDiscountCents, e['discount']);
      expect(l.netCents, e['net']);
      expect(l.taxCents, e['tax']);
      expect(l.totalCents, e['total']);
    });

    test('discount is capped at the gross line', () {
      final l = CartLine(product: p(5000), quantity: 1, discountCents: 999999);
      expect(l.effectiveDiscountCents, 5000);
      expect(l.netCents, 0);
      expect(l.totalCents, 0);
    });

    test('document totals sum per line, like computeTotals', () {
      final lines = [
        CartLine(product: p(25000), quantity: 3, discountCents: 1000),
        CartLine(product: p(12000, bp: 0), quantity: 4),
      ];
      var sub = 0, disc = 0, tax = 0, tot = 0;
      for (final l in lines) {
        sub += l.grossCents;
        disc += l.effectiveDiscountCents;
        tax += l.taxCents;
        tot += l.totalCents;
      }
      final a = serverLine(3, 25000, 1000, 1600);
      final b = serverLine(4, 12000, 0, 0);
      expect(sub, a['gross']! + b['gross']!);
      expect(disc, a['discount']! + b['discount']!);
      expect(tax, a['tax']! + b['tax']!);
      expect(tot, a['total']! + b['total']!);
    });
  });
}
