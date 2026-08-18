import 'dart:convert';

import 'package:uuid/uuid.dart';

import 'local_db.dart';

/// Operation types accepted by POST /api/v1/sync/push.
/// These strings are a contract with the server — changing one here without
/// changing the server's switch silently sends work that will never apply.
class OpType {
  const OpType._();

  static const visitCheckIn = 'visit.checkin';
  static const visitCheckOut = 'visit.checkout';
  static const visitCreate = 'visit.create';
  static const orderCreate = 'order.create';
  static const invoiceCreate = 'invoice.create';
  static const paymentCreate = 'payment.create';
  static const customerCreate = 'customer.create';
  static const customerUpdate = 'customer.update';
  static const activityCreate = 'activity.create';
  static const expenseCreate = 'expense.create';
}

class OutboxEntry {
  OutboxEntry({
    required this.uuid,
    required this.type,
    required this.payload,
    required this.createdAt,
    this.attempts = 0,
    this.lastError,
    this.syncedAt,
    this.serverId,
  });

  final String uuid;
  final String type;
  final Map<String, dynamic> payload;
  final DateTime createdAt;
  final int attempts;
  final String? lastError;
  final DateTime? syncedAt;
  final String? serverId;

  bool get isPending => syncedAt == null;

  /// An entry the server has repeatedly refused. Kept, not deleted, so the rep
  /// can see what did not go through rather than losing the work silently.
  bool get isStuck => syncedAt == null && attempts >= 5;

  factory OutboxEntry.fromRow(Map<String, Object?> row) => OutboxEntry(
        uuid: row['uuid'] as String,
        type: row['type'] as String,
        payload: jsonDecode(row['payload'] as String) as Map<String, dynamic>,
        createdAt: DateTime.parse(row['createdAt'] as String),
        attempts: (row['attempts'] as int?) ?? 0,
        lastError: row['lastError'] as String?,
        syncedAt: row['syncedAt'] != null
            ? DateTime.parse(row['syncedAt'] as String)
            : null,
        serverId: row['serverId'] as String?,
      );

  /// Shape expected by the server's batch endpoint.
  Map<String, dynamic> toOperation() => {
        'uuid': uuid,
        'type': type,
        'at': createdAt.toUtc().toIso8601String(),
        'payload': payload,
      };

  String get label => switch (type) {
        OpType.visitCheckIn => 'Check-in',
        OpType.visitCheckOut => 'Check-out',
        OpType.visitCreate => 'New visit',
        OpType.orderCreate => 'Order',
        OpType.invoiceCreate => 'Invoice',
        OpType.paymentCreate => 'Payment',
        OpType.customerCreate => 'New customer',
        OpType.customerUpdate => 'Customer update',
        OpType.activityCreate => 'Note',
        OpType.expenseCreate => 'Expense claim',
        _ => type,
      };
}

/// The queue of locally-authored work waiting to reach the server.
///
/// Every entry carries a client-generated UUID which the server uses as an
/// idempotency key. That is what makes retrying safe: a rep in a low-signal
/// market will push the same batch more than once, and without the key the
/// server would record the order twice.
///
/// Entries are appended in the order the rep performed them and drained in
/// that order, so an invoice raised against an order created minutes earlier
/// in the same batch resolves correctly.
class Outbox {
  Outbox(this._db);

  final LocalDb _db;
  static const _uuid = Uuid();

  /// Enqueues an operation and returns the UUID that identifies it forever.
  Future<String> enqueue(
    String type,
    Map<String, dynamic> payload, {
    DateTime? at,
  }) async {
    final uuid = _uuid.v4();
    await _db.insert('outbox', {
      'uuid': uuid,
      'type': type,
      'payload': jsonEncode(payload),
      'createdAt': (at ?? DateTime.now()).toIso8601String(),
      'attempts': 0,
    });
    return uuid;
  }

  Future<List<OutboxEntry>> pending({int limit = 100}) async {
    final rows = await _db.query(
      'outbox',
      where: 'syncedAt IS NULL',
      orderBy: 'createdAt ASC',
      limit: limit,
    );
    return rows.map(OutboxEntry.fromRow).toList();
  }

  Future<List<OutboxEntry>> recent({int limit = 40}) async {
    final rows = await _db.query('outbox', orderBy: 'createdAt DESC', limit: limit);
    return rows.map(OutboxEntry.fromRow).toList();
  }

  Future<int> pendingCount() =>
      _db.count('outbox', where: 'syncedAt IS NULL');

  Future<int> stuckCount() =>
      _db.count('outbox', where: 'syncedAt IS NULL AND attempts >= 5');

  Future<void> markSynced(String uuid, {String? serverId}) async {
    await _db.update(
      'outbox',
      {
        'syncedAt': DateTime.now().toIso8601String(),
        'serverId': serverId,
        'lastError': null,
      },
      where: 'uuid = ?',
      whereArgs: [uuid],
    );
  }

  /// Rewrites a placeholder id to the one the server issued, across every
  /// operation still waiting to be sent.
  ///
  /// A rep who creates an unplanned visit and checks in a minute later, both
  /// offline, queues `visit.create` then `visit.checkin`. The create comes back
  /// with a real id, but the check-in still names `local:<uuid>` — an id the
  /// server cannot resolve, so it is rejected on every drain from then on. The
  /// outbox never empties and the rep's check-in is silently lost, which is
  /// precisely the work the app exists to protect.
  ///
  /// Only unsent rows are touched; an acknowledged payload is a record of what
  /// was sent and is left alone.
  Future<int> remapId(String localId, String serverId) async {
    final rows = await _db.query(
      'outbox',
      where: 'syncedAt IS NULL AND payload LIKE ?',
      whereArgs: ['%$localId%'],
    );

    var rewritten = 0;
    for (final row in rows) {
      final payload = jsonDecode(row['payload'] as String) as Map<String, dynamic>;
      var touched = false;
      for (final key in payload.keys.toList()) {
        if (payload[key] == localId) {
          payload[key] = serverId;
          touched = true;
        }
      }
      if (!touched) continue; // matched the LIKE incidentally, not as an id

      await _db.update(
        'outbox',
        {'payload': jsonEncode(payload)},
        where: 'uuid = ?',
        whereArgs: [row['uuid']],
      );
      rewritten++;
    }
    return rewritten;
  }

  Future<void> markFailed(String uuid, String error) async {
    await _db.execute(
      'UPDATE outbox SET attempts = attempts + 1, lastError = ? WHERE uuid = ?',
      [error, uuid],
    );
  }

  /// Drops acknowledged entries older than a week. Recent ones are retained so
  /// the sync screen can show the rep what went through today.
  Future<void> prune() async {
    final cutoff = DateTime.now().subtract(const Duration(days: 7));
    await _db.delete(
      'outbox',
      where: 'syncedAt IS NOT NULL AND syncedAt < ?',
      whereArgs: [cutoff.toIso8601String()],
    );
  }

  /// Clears a stuck entry after the rep has acknowledged it cannot be applied.
  Future<void> discard(String uuid) async {
    await _db.delete('outbox', where: 'uuid = ?', whereArgs: [uuid]);
  }
}
