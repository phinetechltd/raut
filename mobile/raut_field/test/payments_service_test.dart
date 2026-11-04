import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:raut_field/core/api_client.dart';
import 'package:raut_field/core/payments_service.dart';

/// A server that answers /payments/* the way a test tells it to.
class FakeApi implements ApiClient {
  FakeApi({this.onGet, this.onPost});

  Map<String, dynamic> Function(String path)? onGet;
  Map<String, dynamic> Function(String path, Map<String, dynamic> body)? onPost;
  final gets = <String>[];
  final posts = <Map<String, dynamic>>[];

  @override
  bool get hasSession => true;

  @override
  Future<Map<String, dynamic>> get(String path, {Map<String, String>? query}) async {
    gets.add(path);
    final fn = onGet;
    if (fn == null) throw NetworkException('offline');
    return fn(path);
  }

  @override
  Future<Map<String, dynamic>> post(String path, Object? body) async {
    final map = (body as Map).cast<String, dynamic>();
    posts.add(map);
    final fn = onPost;
    if (fn == null) throw NetworkException('offline');
    return fn(path, map);
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

Map<String, dynamic> intentJson(String status, {String id = 'int-1', String? receipt, String? redirectUrl}) => {
      'id': id,
      'provider': 'MPESA_DARAJA',
      'status': status,
      'amountCents': 25000,
      'currency': 'KES',
      'receiptRef': receipt,
      'failureReason': null,
      'redirectUrl': redirectUrl,
      'paymentId': null,
      'createdAt': '2026-11-04T10:00:00.000Z',
      'completedAt': null,
    };

void main() {
  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  group('status mapping', () {
    test('mirrors every PaymentIntent.status, SETTLING included', () {
      expect(gatewayStatusFrom('PENDING'), GatewayStatus.pending);
      expect(gatewayStatusFrom('PROCESSING'), GatewayStatus.processing);
      expect(gatewayStatusFrom('SETTLING'), GatewayStatus.processing);
      expect(gatewayStatusFrom('SUCCEEDED'), GatewayStatus.succeeded);
      expect(gatewayStatusFrom('FAILED'), GatewayStatus.failed);
      expect(gatewayStatusFrom('CANCELLED'), GatewayStatus.cancelled);
      expect(gatewayStatusFrom('EXPIRED'), GatewayStatus.expired);
      expect(gatewayStatusFrom('REVERSED'), GatewayStatus.reversed);
      expect(gatewayStatusFrom('something-new'), GatewayStatus.pending, reason: 'unknown is still open');
    });

    test('terminal means the rep can stop waiting; open means they cannot', () {
      for (final s in ['SUCCEEDED', 'FAILED', 'CANCELLED', 'EXPIRED', 'REVERSED']) {
        expect(GatewayIntent.fromJson(intentJson(s)).isTerminal, isTrue, reason: s);
      }
      for (final s in ['PENDING', 'PROCESSING', 'SETTLING']) {
        final i = GatewayIntent.fromJson(intentJson(s));
        expect(i.isTerminal, isFalse, reason: s);
        expect(i.isOpen, isTrue, reason: s);
      }
    });

    test('reads the public DTO, redirectUrl and createdAt included', () {
      final i = GatewayIntent.fromJson(intentJson('PROCESSING', redirectUrl: 'https://checkout.example/x', receipt: null));
      expect(i.redirectUrl, 'https://checkout.example/x');
      expect(i.createdAt, DateTime.utc(2026, 11, 4, 10));
      expect(i.amountCents, 25000);
    });
  });

  group('watch', () {
    test('ends on the first terminal state and forgets the open intent', () async {
      var calls = 0;
      final api = FakeApi(onGet: (_) => intentJson(++calls >= 2 ? 'SUCCEEDED' : 'PROCESSING', receipt: calls >= 2 ? 'QHX7K2M9PL' : null));
      final svc = PaymentsService(api);
      await svc.rememberOpen(OpenIntent(id: 'int-1', clientUuid: 'u1', customerId: 'c1', provider: 'MPESA_DARAJA', amountCents: 25000, createdAt: DateTime.now()));

      final seen = await svc.watch('int-1', interval: const Duration(milliseconds: 5), timeout: const Duration(seconds: 5)).toList();
      expect(seen.map((i) => i.status), [GatewayStatus.processing, GatewayStatus.succeeded]);
      expect(seen.last.receiptRef, 'QHX7K2M9PL');
      expect(await svc.openIntents('c1'), isEmpty, reason: 'a finished intent is no longer open');
    });

    test('a timeout ends the stream on a non-terminal state — not an error — and keeps the intent open', () async {
      final api = FakeApi(onGet: (_) => intentJson('PROCESSING'));
      final svc = PaymentsService(api);
      await svc.rememberOpen(OpenIntent(id: 'int-1', clientUuid: 'u1', customerId: 'c1', provider: 'MPESA_DARAJA', amountCents: 25000, createdAt: DateTime.now()));

      final seen = await svc.watch('int-1', interval: const Duration(milliseconds: 5), timeout: const Duration(milliseconds: 60)).toList();
      expect(seen, isNotEmpty);
      expect(seen.every((i) => i.status == GatewayStatus.processing), isTrue);
      expect(seen.last.isTerminal, isFalse);
      expect(api.gets.length, greaterThan(1), reason: 'kept polling until the deadline');
      expect((await svc.openIntents('c1')).map((o) => o.id), ['int-1']);
    });

    test('a dropped request mid-collection is swallowed and polling continues', () async {
      var calls = 0;
      final api = FakeApi(onGet: (_) {
        calls++;
        if (calls == 1) throw NetworkException('No connection to the Raut server');
        return intentJson(calls >= 3 ? 'FAILED' : 'PROCESSING');
      });
      final svc = PaymentsService(api);
      final seen = await svc.watch('int-1', interval: const Duration(milliseconds: 5), timeout: const Duration(seconds: 5)).toList();
      expect(seen.map((i) => i.status), [GatewayStatus.processing, GatewayStatus.failed]);
    });
  });

  group('open intents and retries', () {
    test('initiate remembers a live intent with its clientUuid; a failed one is not kept', () async {
      final api = FakeApi(onPost: (path, body) => intentJson(body['amountCents'] == 500 ? 'FAILED' : 'PROCESSING', id: 'int-${body['amountCents']}'));
      final svc = PaymentsService(api);

      final live = await svc.initiate(customerId: 'c1', provider: 'MPESA_DARAJA', amountCents: 25000, payerPhone: '0712345678');
      expect(live.status, GatewayStatus.processing);
      final open = await svc.openIntents('c1');
      expect(open.length, 1);
      expect(open.single.id, 'int-25000');
      expect(open.single.clientUuid, api.posts.single['clientUuid']);
      expect(open.single.payer, '0712345678');

      await svc.initiate(customerId: 'c1', provider: 'MPESA_DARAJA', amountCents: 500);
      expect((await svc.openIntents('c1')).length, 1, reason: 'the failed one is not remembered');
    });

    test('a retry inside two minutes reuses the clientUuid; after that a new prompt is allowed', () async {
      var now = DateTime(2026, 11, 4, 10, 0, 0);
      final api = FakeApi(onPost: (_, body) => intentJson('PROCESSING', id: 'int-1'));
      final svc = PaymentsService(api, clock: () => now);

      await svc.initiate(customerId: 'c1', provider: 'MPESA_DARAJA', amountCents: 25000, clientUuid: 'first-uuid');
      final open = (await svc.openIntents('c1')).single;

      now = now.add(const Duration(seconds: 90));
      final reuse = await svc.reusable(customerId: 'c1', provider: 'MPESA_DARAJA', amountCents: 25000);
      expect(reuse?.clientUuid, 'first-uuid');
      expect(svc.canResend(open), isFalse);
      expect(await svc.reusable(customerId: 'c1', provider: 'MPESA_DARAJA', amountCents: 10000), isNull, reason: 'a different amount is a different collection');
      expect(await svc.reusable(customerId: 'c1', provider: 'PAYSTACK', amountCents: 25000), isNull);

      // Replaying with the same key must send the same key.
      await svc.initiate(customerId: 'c1', provider: 'MPESA_DARAJA', amountCents: 25000, clientUuid: reuse!.clientUuid);
      expect(api.posts.last['clientUuid'], 'first-uuid');
      expect((await svc.openIntents('c1')).length, 1, reason: 'same intent id, stored once');

      now = now.add(const Duration(seconds: 45));
      expect(await svc.reusable(customerId: 'c1', provider: 'MPESA_DARAJA', amountCents: 25000), isNull, reason: 'past the window');
      expect(svc.canResend(open), isTrue);
    });

    test('recheckOpen drops finished intents, keeps live ones, and tolerates an unreachable server', () async {
      final api = FakeApi(onGet: (path) {
        if (path.endsWith('/done')) return intentJson('SUCCEEDED', id: 'done', receipt: 'ABC1234567');
        if (path.endsWith('/live')) return intentJson('PROCESSING', id: 'live');
        throw NetworkException('offline');
      });
      final svc = PaymentsService(api);
      final at = DateTime.now();
      for (final id in ['done', 'live', 'unknown']) {
        await svc.rememberOpen(OpenIntent(id: id, clientUuid: 'u-$id', customerId: 'c1', provider: 'MPESA_DARAJA', amountCents: 1000, createdAt: at));
      }

      final results = await svc.recheckOpen('c1');
      expect(results.length, 3);
      expect(results.firstWhere((r) => r.open.id == 'done').current?.status, GatewayStatus.succeeded);
      expect(results.firstWhere((r) => r.open.id == 'unknown').current, isNull);

      final kept = (await svc.openIntents('c1')).map((o) => o.id).toList();
      expect(kept, containsAll(['live', 'unknown']));
      expect(kept, isNot(contains('done')));
    });

    test('open intents older than 24 hours are forgotten', () async {
      var now = DateTime(2026, 11, 4, 10);
      final svc = PaymentsService(FakeApi(), clock: () => now);
      await svc.rememberOpen(OpenIntent(id: 'old', clientUuid: 'u', customerId: 'c1', provider: 'MPESA_DARAJA', amountCents: 1000, createdAt: now));
      now = now.add(const Duration(hours: 25));
      expect(await svc.openIntents('c1'), isEmpty);
    });

    test('usableNamed never throws when no provider is usable', () async {
      final svc = PaymentsService(FakeApi(onGet: (_) => {'providers': <dynamic>[]}));
      await svc.loadProviders();
      expect(svc.usable, isEmpty);
      expect(svc.usableNamed('MPESA_DARAJA'), isNull);
    });
  });
}
