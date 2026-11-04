import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';
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
///
/// What the handset *does* remember is which collections it started and has
/// not yet seen finish ("open intents"), per customer, so that a prompt the
/// customer answered after the rep closed the screen is still checked the next
/// time the screen opens, and so a retry within two minutes reuses the same
/// request instead of pushing a second prompt at the customer.
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
///
/// `reversed` is a success the provider later took back (a card chargeback or
/// refund). The office deals with it; for the rep it reads as "not paid".
enum GatewayStatus {
  pending,
  processing,
  succeeded,
  failed,
  cancelled,
  expired,
  reversed,
}

GatewayStatus gatewayStatusFrom(String raw) {
  switch (raw.toUpperCase()) {
    case 'SUCCEEDED':
      return GatewayStatus.succeeded;
    case 'FAILED':
      return GatewayStatus.failed;
    case 'CANCELLED':
      return GatewayStatus.cancelled;
    case 'EXPIRED':
      return GatewayStatus.expired;
    case 'REVERSED':
      return GatewayStatus.reversed;
    case 'PROCESSING':
    case 'SETTLING':
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
    this.redirectUrl,
    this.createdAt,
  });

  final String id;
  final String provider;
  final GatewayStatus status;
  final int amountCents;
  final String? receiptRef;
  final String? failureReason;
  final String? paymentId;

  /// Hosted checkout for redirect providers (Paystack). Null for STK pushes.
  final String? redirectUrl;
  final DateTime? createdAt;

  bool get isTerminal =>
      status == GatewayStatus.succeeded ||
      status == GatewayStatus.failed ||
      status == GatewayStatus.cancelled ||
      status == GatewayStatus.expired ||
      status == GatewayStatus.reversed;

  /// Still live: the customer may yet act on it.
  bool get isOpen => !isTerminal;

  factory GatewayIntent.fromJson(Map<String, dynamic> j) => GatewayIntent(
        id: j['id'] as String,
        provider: j['provider'] as String? ?? '',
        status: gatewayStatusFrom(j['status'] as String? ?? 'PENDING'),
        amountCents: (j['amountCents'] as num?)?.toInt() ?? 0,
        receiptRef: j['receiptRef'] as String?,
        failureReason: j['failureReason'] as String?,
        paymentId: j['paymentId'] as String?,
        redirectUrl: j['redirectUrl'] as String?,
        createdAt: j['createdAt'] is String
            ? DateTime.tryParse(j['createdAt'] as String)
            : null,
      );
}

/// A collection this handset started and has not yet seen finish.
class OpenIntent {
  const OpenIntent({
    required this.id,
    required this.clientUuid,
    required this.customerId,
    required this.provider,
    required this.amountCents,
    required this.createdAt,
    this.payer,
    this.redirectUrl,
  });

  final String id;

  /// The idempotency key the intent was started with. Re-sending with the same
  /// key within the resend window returns the same intent — no second prompt.
  final String clientUuid;
  final String customerId;
  final String provider;
  final int amountCents;
  final DateTime createdAt;
  final String? payer;
  final String? redirectUrl;

  Map<String, dynamic> toJson() => {
        'id': id,
        'clientUuid': clientUuid,
        'customerId': customerId,
        'provider': provider,
        'amountCents': amountCents,
        'createdAt': createdAt.toUtc().toIso8601String(),
        if (payer != null) 'payer': payer,
        if (redirectUrl != null) 'redirectUrl': redirectUrl,
      };

  factory OpenIntent.fromJson(Map<String, dynamic> j) => OpenIntent(
        id: j['id'] as String,
        clientUuid: j['clientUuid'] as String,
        customerId: j['customerId'] as String,
        provider: j['provider'] as String,
        amountCents: (j['amountCents'] as num).toInt(),
        createdAt: DateTime.parse(j['createdAt'] as String),
        payer: j['payer'] as String?,
        redirectUrl: j['redirectUrl'] as String?,
      );
}

/// The outcome of re-checking one open intent.
class OpenIntentCheck {
  const OpenIntentCheck(this.open, this.current);
  final OpenIntent open;

  /// Null when the server could not be reached.
  final GatewayIntent? current;
}

class PaymentsService extends ChangeNotifier {
  PaymentsService(this._api, {DateTime Function()? clock})
      : _clock = clock ?? DateTime.now;

  final ApiClient _api;
  final DateTime Function() _clock;
  static const _uuid = Uuid();

  /// How long after a prompt a rep must wait before a *second* prompt may be
  /// sent for the same collection. Inside this window a retry reuses the same
  /// request; Daraja keeps the first prompt alive for about this long.
  static const resendAfter = Duration(minutes: 2);

  /// How long an open intent is remembered before it is dropped as hopeless.
  /// The server expires its side after the same 24 hours.
  static const forgetAfter = Duration(hours: 24);

  List<GatewayProvider> _providers = const [];
  List<GatewayProvider> get providers => _providers;

  /// Only the gateways this deployment can actually complete.
  List<GatewayProvider> get usable =>
      _providers.where((p) => p.configured).toList();

  /// The usable provider by name, or null — never a StateError.
  GatewayProvider? usableNamed(String name) {
    for (final p in usable) {
      if (p.name == name) return p;
    }
    return null;
  }

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
  ///
  /// Pass the [clientUuid] of an open intent to retry it without a second
  /// prompt; omit it for a new collection.
  Future<GatewayIntent> initiate({
    required String customerId,
    required String provider,
    required int amountCents,
    String? payerPhone,
    String? payerEmail,
    String? visitId,
    String? clientUuid,
  }) async {
    final key = clientUuid ?? _uuid.v4();
    final res = await _api.post('/payments/initiate', {
      'customerId': customerId,
      'provider': provider,
      'amountCents': amountCents,
      if (payerPhone != null && payerPhone.isNotEmpty) 'payerPhone': payerPhone,
      if (payerEmail != null && payerEmail.isNotEmpty) 'payerEmail': payerEmail,
      if (visitId != null && !visitId.startsWith('local:')) 'visitId': visitId,
      // Same idempotency contract as the offline outbox: a retried request
      // must not charge the customer twice.
      'clientUuid': key,
    });
    final intent = GatewayIntent.fromJson(res);
    if (intent.isOpen) {
      await rememberOpen(OpenIntent(
        id: intent.id,
        clientUuid: key,
        customerId: customerId,
        provider: provider,
        amountCents: amountCents,
        createdAt: _clock(),
        payer: payerPhone ?? payerEmail,
        redirectUrl: intent.redirectUrl,
      ));
    }
    return intent;
  }

  Future<GatewayIntent> status(String intentId) async {
    final res = await _api.get('/payments/intents/$intentId');
    return GatewayIntent.fromJson(res);
  }

  /// Polls until the gateway reaches a terminal state or the deadline passes.
  ///
  /// The deadline matters: an STK prompt that is never answered stays PENDING
  /// forever from the app's point of view, and a rep cannot stand at a counter
  /// watching a spinner indefinitely. Timing out is **not** a failure — the
  /// stream simply ends on a non-terminal state; the collection may still
  /// land, the intent stays in the open list, and the next screen open or
  /// `recheckOpen` picks it up.
  Stream<GatewayIntent> watch(
    String intentId, {
    Duration interval = const Duration(seconds: 3),
    Duration timeout = const Duration(minutes: 2),
  }) async* {
    final deadline = _clock().add(timeout);

    while (_clock().isBefore(deadline)) {
      await Future<void>.delayed(interval);
      GatewayIntent last;
      try {
        last = await status(intentId);
      } catch (_) {
        // A dropped request mid-collection is expected on a field network.
        // Keep polling; the deadline is the backstop.
        continue;
      }
      yield last;
      if (last.isTerminal) {
        await forgetOpen(intentId);
        return;
      }
    }
  }

  // ── open intents ──────────────────────────────────────────────────────

  static String _key(String customerId) => 'open_intents:$customerId';

  Future<List<OpenIntent>> openIntents(String customerId) async {
    final prefs = await SharedPreferences.getInstance();
    final raw = prefs.getString(_key(customerId));
    if (raw == null || raw.isEmpty) return const [];
    try {
      final list = (jsonDecode(raw) as List)
          .map((e) => OpenIntent.fromJson(e as Map<String, dynamic>))
          .toList();
      final cutoff = _clock().subtract(forgetAfter);
      return list.where((o) => o.createdAt.isAfter(cutoff)).toList();
    } catch (_) {
      return const [];
    }
  }

  Future<void> _write(String customerId, List<OpenIntent> list) async {
    final prefs = await SharedPreferences.getInstance();
    if (list.isEmpty) {
      await prefs.remove(_key(customerId));
    } else {
      await prefs.setString(
        _key(customerId),
        jsonEncode(list.map((o) => o.toJson()).toList()),
      );
    }
  }

  /// A re-remembered intent (the same request replayed) keeps its original
  /// `createdAt`: the prompt on the customer's phone is as old as the first
  /// send, so the resend window must not restart with every retry.
  Future<void> rememberOpen(OpenIntent open) async {
    final list = await openIntents(open.customerId);
    OpenIntent? existing;
    for (final o in list) {
      if (o.id == open.id) existing = o;
    }
    final kept = existing == null
        ? open
        : OpenIntent(
            id: open.id,
            clientUuid: existing.clientUuid,
            customerId: open.customerId,
            provider: open.provider,
            amountCents: open.amountCents,
            createdAt: existing.createdAt,
            payer: open.payer ?? existing.payer,
            redirectUrl: open.redirectUrl ?? existing.redirectUrl,
          );
    final next = [...list.where((o) => o.id != open.id), kept];
    await _write(open.customerId, next);
    notifyListeners();
  }

  /// Drops an intent from whichever customer's list holds it.
  Future<void> forgetOpen(String intentId, {String? customerId}) async {
    if (customerId != null) {
      final list = await openIntents(customerId);
      await _write(customerId, list.where((o) => o.id != intentId).toList());
      notifyListeners();
      return;
    }
    final prefs = await SharedPreferences.getInstance();
    for (final key in prefs.getKeys().where((k) => k.startsWith('open_intents:'))) {
      final list = await openIntents(key.substring('open_intents:'.length));
      if (list.any((o) => o.id == intentId)) {
        await _write(
          key.substring('open_intents:'.length),
          list.where((o) => o.id != intentId).toList(),
        );
      }
    }
    notifyListeners();
  }

  /// An open intent for the same customer, provider and amount that is still
  /// inside the resend window — its request should be reused, not repeated.
  Future<OpenIntent?> reusable({
    required String customerId,
    required String provider,
    required int amountCents,
  }) async {
    final cutoff = _clock().subtract(resendAfter);
    for (final o in await openIntents(customerId)) {
      if (o.provider == provider &&
          o.amountCents == amountCents &&
          o.createdAt.isAfter(cutoff)) {
        return o;
      }
    }
    return null;
  }

  /// True once a second prompt may be sent for this intent.
  bool canResend(OpenIntent open) =>
      !_clock().isBefore(open.createdAt.add(resendAfter));

  /// Asks the server about every open intent for a customer. Finished ones
  /// are dropped from the list; live ones are kept. Called when the payment
  /// screen opens, so a prompt answered after the rep walked away is noticed.
  Future<List<OpenIntentCheck>> recheckOpen(String customerId) async {
    final list = await openIntents(customerId);
    final results = <OpenIntentCheck>[];
    final keep = <OpenIntent>[];
    for (final o in list) {
      GatewayIntent? current;
      try {
        current = await status(o.id);
      } catch (_) {
        current = null;
      }
      results.add(OpenIntentCheck(o, current));
      if (current == null || current.isOpen) keep.add(o);
    }
    if (keep.length != list.length) await _write(customerId, keep);
    notifyListeners();
    return results;
  }
}
