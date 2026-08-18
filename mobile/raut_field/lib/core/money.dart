import 'package:intl/intl.dart';

/// Money helpers mirroring the server: integer KES cents, never floats.
///
/// The client and server must agree on this exactly — a rounding difference
/// between the handset and the back office shows up as a customer disputing a
/// receipt, which is the worst place to discover it.
class Money {
  const Money._();

  static final NumberFormat _plain = NumberFormat('#,##0', 'en_KE');
  static final NumberFormat _decimal = NumberFormat('#,##0.00', 'en_KE');

  static String format(int cents, {bool decimals = false}) {
    final value = cents / 100;
    return 'KES ${decimals ? _decimal.format(value) : _plain.format(value)}';
  }

  static String compact(int cents) {
    final value = cents / 100;
    final abs = value.abs();
    if (abs >= 1000000) return 'KES ${(value / 1000000).toStringAsFixed(1)}M';
    if (abs >= 1000) return 'KES ${(value / 1000).toStringAsFixed(1)}K';
    return 'KES ${value.toStringAsFixed(0)}';
  }

  static int toCents(double amount) => (amount * 100).round();

  static double fromCents(int cents) => cents / 100;

  /// Line total including VAT, matching the server's `computeLine`.
  ///
  /// Discount applies to the gross line before tax, because Kenyan VAT is
  /// charged on the discounted consideration.
  static int lineTotal({
    required int quantity,
    required int unitPriceCents,
    int discountCents = 0,
    int taxRateBp = 1600,
  }) {
    final gross = quantity * unitPriceCents;
    final discount = discountCents > gross ? gross : discountCents;
    final net = gross - discount;
    final tax = (net * taxRateBp / 10000).round();
    return net + tax;
  }
}
