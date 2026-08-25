import 'package:flutter/foundation.dart';
import 'package:uuid/uuid.dart';

import 'api_client.dart';

/// Gateway collections — Paystack, M-Pesa via Daraja, and KCB Buni.
///
/// These are deliberately **online-only**, and that is not a shortcut. An STK
/// push is a conversation with Safaricom that has to happen while the customer
/// is standing there with their phone; there is nothing meaningful to queue.
/// Cash, bank transfer and cheque keep working offline exactly as before, so a
/// rep with no signal is never blocked from recording money they were handed.
///
/// The other rule worth stating: when a gateway succeeds, the server books the
/// Payment. The app must **not** also enqueue one, or the customer is credited
/// twice. It syncs instead, and the real payment arrives on the next pull.
class GatewayProvider {
  const GatewayProvider({
    required this.name,
    required this.label,
    required this.needs,
    required this.configured,
  });

  /// PAYSTACK | MPESA_DARAJA | KCB_BUNI
  final String name;
  final String label;

  /// 'phone' or 'email' — what the payer has to supply.
  final String needs;

  /// False when this deployment has no credentials for the provider. Such a
  /// provider is never offered: a button that always fails is worse than an
  /// absent one.
  final bool configured;

  factory GatewayProvider.fromJson(Map<String, dynamic> j) => GatewayProvider(
        name: j['name'] as String,
        label: j['label'] as String? ?? j['name'] as String,
        needs: j['needs'] as String? ?? 'phone',
        configured: j['configured'] as bool? ?? false,
      );
}

/// Where a collection has got to. Mirrors PaymentIntent.status on the server.
enum GatewayStatus { pending, processing, succeeded, failed, cancelled, expired }

GatewayStatus _statusFrom(String raw) {
  switch (raw.toUpperCase()) {
    case 'SUCCEEDED':
      return GatewayStatus.succeeded;
    case 'FAILED':
      return GatewayStatus.failed;
    case 'CANCELLED':
      return GatewayStatus.cancelled;
    case 'EXPIRED':
      return GatewayStatus.expired;
    case 'PROCESSING':
      return GatewayStatus.processing;
    default:
      return GatewayStatus.pending;
  }
}

class GatewayIntent {
  const GatewayIntent({
    required this.id,
    required this.provider,
    required this.status,
    required this.amountCents,
    this.receiptRef,
    this.failureReason,
    this.paymentId,
  });

  final String id;
  final String provider;
  final GatewayStatus status;
  final int amountCents;
  final String? receiptRef;
  final String? failureReason;
  final String? paymentId;

  bool get isTerminal =>
      status == GatewayStatus.succeeded ||
      status == GatewayStatus.failed ||
      status == GatewayStatus.cancelled ||
      status == GatewayStatus.expired;

  factory GatewayIntent.fromJson(Map<String, dynamic> j) => GatewayIntent(
        id: j['id'] as String,
        provider: j['provider'] as String? ?? '',
        status: _statusFrom(j['status'] as String? ?? 'PENDING'),
        amountCents: (j['amountCents'] as num?)?.toInt() ?? 0,
        receiptRef: j['receiptRef'] as String?,
        failureReason: j['failureReason'] as String?,
        paymentId: j['paymentId'] as String?,
      );
}

class PaymentsService extends ChangeNotifier {
  PaymentsService(this._api);

  final ApiClient _api;
  static const _uuid = Uuid();

  List<GatewayProvider> _providers = const [];
  List<GatewayProvider> get providers => _providers;

  /// Only the gateways this deployment can actually complete.
  List<GatewayProvider> get usable =>
      _providers.where((p) => p.configured).toList();

  bool _loaded = false;
  bool get loaded => _loaded;

  /// Reads the gateway list. Failure here is not an error worth surfacing —
  /// it just means no gateway buttons, and cash still works.
  Future<void> loadProviders() async {
    try {
      final res = await _api.get('/payments/providers');
      final list = (res['providers'] as List?) ?? const [];
      _providers = list
          .map((e) => GatewayProvider.fromJson(e as Map<String, dynamic>))
          .toList();
    } catch (_) {
      _providers = const [];
    } finally {
      _loaded = true;
      notifyListeners();
    }
  }

  /// Starts a collection. The returned intent is usually PROCESSING — the
  /// customer still has to act on their handset.
  Future<GatewayIntent> initiate({
    required String customerId,
    required String provider,
    required int amountCents,
    String? payerPhone,
    String? payerEmail,
    String? visitId,
  }) async {
    final res = await _api.post('/payments/initiate', {
      'customerId': customerId,
      'provider': provider,
      'amountCents': amountCents,
      if (payerPhone != null && payerPhone.isNotEmpty) 'payerPhone': payerPhone,
      if (payerEmail != null && payerEmail.isNotEmpty) 'payerEmail': payerEmail,
      if (visitId != null && !visitId.startsWith('local:')) 'visitId': visitId,
      // Same idempotency contract as the offline outbox: a retried request
      // must not charge the customer twice.
      'clientUuid': _uuid.v4(),
    });
    return GatewayIntent.fromJson(res);
  }

  Future<GatewayIntent> status(String intentId) async {
    final res = await _api.get('/payments/intents/$intentId');
    return GatewayIntent.fromJson(res);
  }

  /// Polls until the gateway reaches a terminal state or the deadline passes.
  ///
  /// The deadline matters: an STK prompt that is never answered stays PENDING
  /// forever from the app's point of view, and a rep cannot stand at a counter
  /// watching a spinner indefinitely. Timing out returns the last known state
  /// rather than throwing — the collection may still land, and the next sync
  /// will pick it up.
  Stream<GatewayIntent> watch(
    String intentId, {
    Duration interval = const Duration(seconds: 3),
    Duration timeout = const Duration(minutes: 2),
  }) async* {
    final deadline = DateTime.now().add(timeout);
    GatewayIntent? last;

    while (DateTime.now().isBefore(deadline)) {
      await Future<void>.delayed(interval);
      try {
        last = await status(intentId);
        yield last;
        if (last.isTerminal) return;
      } catch (_) {
        // A dropped request mid-collection is expected on a field network.
        // Keep polling; the deadline is the backstop.
      }
    }
  }
}
