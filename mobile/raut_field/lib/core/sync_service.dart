import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'api_client.dart';
import 'config.dart';
import 'local_db.dart';
import 'outbox.dart';

enum SyncPhase { idle, pushing, pulling, done, failed }

class SyncStatus {
  const SyncStatus({
    this.phase = SyncPhase.idle,
    this.message,
    this.lastSyncedAt,
    this.pendingCount = 0,
    this.stuckCount = 0,
    this.online = true,
  });

  final SyncPhase phase;
  final String? message;
  final DateTime? lastSyncedAt;
  final int pendingCount;
  final int stuckCount;
  final bool online;

  bool get isBusy => phase == SyncPhase.pushing || phase == SyncPhase.pulling;
  bool get hasPending => pendingCount > 0;

  SyncStatus copyWith({
    SyncPhase? phase,
    String? message,
    DateTime? lastSyncedAt,
    int? pendingCount,
    int? stuckCount,
    bool? online,
  }) =>
      SyncStatus(
        phase: phase ?? this.phase,
        message: message,
        lastSyncedAt: lastSyncedAt ?? this.lastSyncedAt,
        pendingCount: pendingCount ?? this.pendingCount,
        stuckCount: stuckCount ?? this.stuckCount,
        online: online ?? this.online,
      );
}

/// Bidirectional sync between the handset and the platform.
///
/// Order matters and is not negotiable: **push before pull**. The rep's local
/// work is authoritative until the server has it; pulling first would overwrite
/// a check-in or an order with the server's older copy and lose it.
class SyncService extends ChangeNotifier {
  SyncService({
    required ApiClient api,
    required LocalDb db,
    required Outbox outbox,
  })  : _api = api,
        _db = db,
        _outbox = outbox;

  final ApiClient _api;
  final LocalDb _db;
  final Outbox _outbox;

  static const _lastSyncKey = 'raut.lastSyncedAt';
  static const _deviceIdKey = 'raut.deviceId';

  SyncStatus _status = const SyncStatus();
  SyncStatus get status => _status;

  Timer? _periodic;
  Timer? _debounce;
  StreamSubscription<List<ConnectivityResult>>? _connectivity;
  bool _running = false;

  Future<void> start() async {
    await refreshCounts();

    final prefs = await SharedPreferences.getInstance();
    final stored = prefs.getString(_lastSyncKey);
    if (stored != null) {
      _set(_status.copyWith(lastSyncedAt: DateTime.tryParse(stored)));
    }

    _connectivity = Connectivity().onConnectivityChanged.listen((results) {
      final online = !results.contains(ConnectivityResult.none);
      _set(_status.copyWith(online: online));

      // Debounced: a flapping connection would otherwise fire a push per
      // transition, which is exactly when the network is least able to take it.
      if (online) {
        _debounce?.cancel();
        _debounce = Timer(AppConfig.reconnectDebounce, () => sync(reason: 'reconnected'));
      }
    });

    _periodic = Timer.periodic(AppConfig.syncInterval, (_) {
      if (_status.online) sync(reason: 'scheduled');
    });
  }

  @override
  void dispose() {
    _periodic?.cancel();
    _debounce?.cancel();
    _connectivity?.cancel();
    super.dispose();
  }

  void _set(SyncStatus next) {
    _status = next;
    notifyListeners();
  }

  Future<void> refreshCounts() async {
    _set(_status.copyWith(
      pendingCount: await _outbox.pendingCount(),
      stuckCount: await _outbox.stuckCount(),
    ));
  }

  /// Runs a full cycle. Safe to call concurrently — overlapping calls are
  /// dropped rather than queued, because two simultaneous drains of the same
  /// outbox would double-send.
  Future<bool> sync({String reason = 'manual'}) async {
    if (_running || !_api.hasSession) return false;
    _running = true;

    try {
      _set(_status.copyWith(phase: SyncPhase.pushing, message: 'Sending your work…'));
      final pushed = await _push();

      _set(_status.copyWith(phase: SyncPhase.pulling, message: 'Fetching updates…'));
      final pulled = await _pull();

      await _outbox.prune();
      await refreshCounts();

      final now = DateTime.now();
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(_lastSyncKey, now.toIso8601String());

      _set(_status.copyWith(
        phase: SyncPhase.done,
        lastSyncedAt: now,
        online: true,
        message: pushed + pulled == 0
            ? 'Everything is up to date'
            : 'Sent $pushed, received $pulled',
      ));
      return true;
    } on NetworkException catch (error) {
      // Offline is the normal state in the field, not a failure to shout about.
      _set(_status.copyWith(
        phase: SyncPhase.failed,
        online: false,
        message: error.message,
      ));
      return false;
    } on ApiException catch (error) {
      _set(_status.copyWith(phase: SyncPhase.failed, message: error.message));
      return false;
    } catch (error) {
      _set(_status.copyWith(phase: SyncPhase.failed, message: 'Sync failed: $error'));
      return false;
    } finally {
      _running = false;
    }
  }

  /// Drains the outbox. Returns how many operations the server accepted.
  Future<int> _push() async {
    final entries = await _outbox.pending(limit: 100);
    final pings = await _db.query('location_buffer', orderBy: 'recordedAt ASC', limit: 400);

    if (entries.isEmpty && pings.isEmpty) return 0;

    final deviceId = await _deviceId();
    final operations = entries.map((e) => e.toOperation()).toList();

    // Breadcrumbs ride along as a single operation so a day of tracking cannot
    // crowd out real business writes in the 200-operation batch limit.
    if (pings.isNotEmpty) {
      operations.add({
        'uuid': 'pings-$deviceId-${DateTime.now().millisecondsSinceEpoch}',
        'type': 'location.batch',
        'payload': {
          'pings': pings
              .map((p) => {
                    'latitude': p['latitude'],
                    'longitude': p['longitude'],
                    'accuracyM': p['accuracyM'],
                    'speedMps': p['speedMps'],
                    'heading': p['heading'],
                    'batteryPct': p['batteryPct'],
                    'isMoving': (p['isMoving'] as int? ?? 1) == 1,
                    'recordedAt': p['recordedAt'],
                  })
              .toList(),
        },
      });
    }

    final response = await _api.post('/sync/push', {
      'deviceId': deviceId,
      'operations': operations,
    });

    final results = (response['results'] as List?) ?? const [];
    var applied = 0;

    for (final raw in results) {
      final result = raw as Map<String, dynamic>;
      final uuid = result['uuid'] as String;
      final status = result['status'] as String;

      if (status == 'applied' || status == 'duplicate') {
        // A duplicate means an earlier attempt already landed — treat it as
        // success, which is the entire point of the idempotency key.
        if (uuid.startsWith('pings-')) {
          await _db.delete('location_buffer');
        } else {
          final serverId = result['entityId'] as String?;
          await _outbox.markSynced(uuid, serverId: serverId);
          if (serverId != null) {
            await _adoptServerId(uuid, serverId, result['entityType'] as String?);
          }
          applied++;
        }
      } else {
        await _outbox.markFailed(uuid, (result['error'] ?? 'Rejected').toString());
      }
    }

    await _pushPhotos();
    return applied;
  }

  /// Retires the `local:<uuid>` placeholder once the server issues a real id.
  ///
  /// Two things go wrong without this. The placeholder row survives alongside
  /// the record the next pull brings down, so the rep sees the same shop twice
  /// in the customer book and the same stop twice on the route. And any queued
  /// operation still naming the placeholder — the check-in captured moments
  /// after the visit was created — is rejected for ever, so the outbox never
  /// drains and "All your work has been sent" never becomes true.
  Future<void> _adoptServerId(String uuid, String serverId, String? entityType) async {
    const tables = {'Customer': 'customers', 'Visit': 'visits'};
    final table = tables[entityType];
    final localId = 'local:$uuid';

    if (table != null) {
      // The pull may already have delivered the server row. Rewriting the
      // placeholder's primary key would collide with it, so in that case the
      // placeholder is simply dropped.
      final existing = await _db.query(
        table,
        where: 'id = ?',
        whereArgs: [serverId],
        limit: 1,
      );
      if (existing.isEmpty) {
        await _db.update(table, {'id': serverId}, where: 'id = ?', whereArgs: [localId]);
      } else {
        await _db.delete(table, where: 'id = ?', whereArgs: [localId]);
      }
    }

    await _outbox.remapId(localId, serverId);
  }

  /// Visit photos go over a separate endpoint because they are large enough
  /// that bundling them into the batch would make a retry expensive.
  Future<void> _pushPhotos() async {
    final rows = await _db.query(
      'pending_photos',
      where: 'syncedAt IS NULL',
      orderBy: 'takenAt ASC',
      limit: 10,
    );

    for (final row in rows) {
      final visitId = row['visitId'] as String;
      // A photo taken against a visit that has not yet synced has no server id
      // to attach to; leave it queued for the next cycle.
      if (visitId.startsWith('local:')) continue;

      try {
        final bytes = await _readAsBase64(row['filePath'] as String);
        if (bytes == null) {
          // The capture file is gone (cache cleared, or the user deleted it).
          // Retrying forever would wedge the queue, so drop the row.
          await _db.delete('pending_photos', where: 'uuid = ?', whereArgs: [row['uuid']]);
          continue;
        }

        await _api.post('/visits/$visitId/photos', {
          'image': bytes,
          'caption': row['caption'],
          'latitude': row['latitude'],
          'longitude': row['longitude'],
          'takenAt': row['takenAt'],
          'clientUuid': row['uuid'],
        });

        await _db.update(
          'pending_photos',
          {'syncedAt': DateTime.now().toIso8601String()},
          where: 'uuid = ?',
          whereArgs: [row['uuid']],
        );
      } on NetworkException {
        rethrow;
      } catch (_) {
        // A single bad photo must not stall the rest of the queue.
        continue;
      }
    }
  }

  /// Reads a captured photo as base64, or null when the file no longer exists.
  Future<String?> _readAsBase64(String path) async {
    try {
      final file = File(path);
      if (!await file.exists()) return null;
      return base64Encode(await file.readAsBytes());
    } catch (_) {
      return null;
    }
  }

  /// Pulls server changes since the last watermark.
  ///
  /// The watermark stored is the server's `syncedAt`, never the handset's
  /// clock: a phone running a few minutes fast would silently skip records
  /// written in that window.
  Future<int> _pull() async {
    final prefs = await SharedPreferences.getInstance();
    final since = prefs.getString(_lastSyncKey);
    final deviceId = await _deviceId();

    final response = await _api.get('/sync/pull', query: {
      if (since != null) 'since': since,
      'deviceId': deviceId,
    });

    final entities = (response['entities'] as Map<String, dynamic>?) ?? const {};
    var received = 0;

    Future<void> mirror(String key, String table, [List<String>? columns]) async {
      final rows = (entities[key] as List?)?.cast<Map<String, dynamic>>() ?? const [];
      if (rows.isEmpty) return;
      final mapped = rows.map((r) => _project(r, columns)).toList();
      await _db.upsertAll(table, mapped);
      received += rows.length;
    }

    await mirror('customers', 'customers', const [
      'id', 'code', 'name', 'type', 'segment', 'phone', 'email', 'address',
      'town', 'latitude', 'longitude', 'geofenceRadiusM', 'creditLimitCents',
      'paymentTermsDays', 'balanceCents', 'status', 'territoryId',
      'assignedRepId', 'notes', 'updatedAt',
    ]);

    await mirror('products', 'products', const [
      'id', 'sku', 'name', 'unit', 'unitsPerPack', 'barcode', 'sellPriceCents',
      'taxRateBp', 'categoryId', 'active', 'updatedAt',
    ]);

    await mirror('variants', 'product_variants', const [
      'id', 'productId', 'name', 'sku', 'barcode', 'unitsPerVariant',
      'sellPriceCents', 'isDefault', 'active', 'updatedAt',
    ]);

    await mirror('territories', 'territories', const [
      'id', 'name', 'code', 'colour', 'boundary', 'centerLat', 'centerLng',
      'radiusM', 'updatedAt',
    ]);

    await mirror('stock', 'stock', const [
      'id', 'productId', 'locationId', 'quantity', 'updatedAt',
    ]);

    await mirror('visits', 'visits', const [
      'id', 'customerId', 'repId', 'routeId', 'status', 'purpose',
      'scheduledAt', 'checkInAt', 'checkInLat', 'checkInLng', 'checkOutAt',
      'geofenceVerified', 'distanceFromCustomerM', 'durationMin', 'outcome',
      'notes', 'updatedAt',
    ]);

    await mirror('invoices', 'invoices', const [
      'id', 'number', 'customerId', 'status', 'issueDate', 'dueDate',
      'subtotalCents', 'discountCents', 'taxCents', 'totalCents', 'paidCents',
      // The result of filing. Mirrored so a receipt prints with the control
      // code and QR on it while the handset is offline, which is the only
      // state a van actually operates in.
      'etimsStatus', 'etimsControlCode', 'etimsInvoiceNumber',
      'etimsSerialNumber', 'etimsQrUrl',
      'updatedAt',
    ]);

    // Lines arrive nested on the invoice rather than as their own entity, so
    // they are flattened here instead of going through `mirror`.
    final invoiceRows =
        (entities['invoices'] as List?)?.cast<Map<String, dynamic>>() ?? const [];
    final lineRows = <Map<String, Object?>>[];
    for (final inv in invoiceRows) {
      for (final l in (inv['lines'] as List?) ?? const []) {
        final line = l as Map<String, dynamic>;
        lineRows.add({
          'id': line['id'],
          'invoiceId': inv['id'],
          'productId': line['productId'],
          'description': line['description'],
          'variantId': line['variantId'],
          'variantName': line['variantName'],
          'quantity': line['quantity'],
          'baseQuantity': line['baseQuantity'],
          'unitPriceCents': line['unitPriceCents'],
          'discountCents': line['discountCents'],
          'taxRateBp': line['taxRateBp'],
          'lineTotalCents': line['lineTotalCents'],
        });
      }
    }
    if (lineRows.isNotEmpty) await _db.upsertAll('invoice_lines', lineRows);

    await mirror('payments', 'payments', const [
      'id', 'number', 'customerId', 'amountCents', 'method', 'reference',
      'paidAt', 'updatedAt', 'clientUuid',
    ]);

    await mirror('expenseCategories', 'expense_categories', const [
      'id', 'name', 'code',
    ]);

    // Routes carry nested stops, so they need shaping rather than projection.
    final routes = (entities['routes'] as List?)?.cast<Map<String, dynamic>>() ?? const [];
    for (final route in routes) {
      await _db.insert('routes', _project(route, const [
        'id', 'repId', 'territoryId', 'name', 'routeDate', 'status',
        'totalDistanceM', 'estimatedMin', 'startLat', 'startLng', 'updatedAt',
      ]));

      final stops = (route['stops'] as List?)?.cast<Map<String, dynamic>>() ?? const [];
      await _db.delete('route_stops', where: 'routeId = ?', whereArgs: [route['id']]);
      await _db.upsertAll(
        'route_stops',
        stops
            .map((s) => _project(s, const [
                  'id', 'routeId', 'customerId', 'sequence', 'status',
                  'plannedAt', 'legDistanceM', 'legMin',
                ]))
            .toList(),
      );
      received++;
    }

    // Orders carry nested lines, kept as JSON for the local history view.
    final orders = (entities['orders'] as List?)?.cast<Map<String, dynamic>>() ?? const [];
    for (final order in orders) {
      await _db.insert('orders', {
        'id': order['id'],
        'number': order['number'],
        'customerId': order['customerId'],
        'status': order['status'],
        'channel': order['channel'],
        'orderDate': order['orderDate'],
        'totalCents': order['totalCents'],
        'linesJson': LocalDb.encode(order['lines']),
        'updatedAt': order['updatedAt'],
        'clientUuid': order['clientUuid'],
      });
      received++;
    }

    return received;
  }

  /// Copies only the columns the local table actually has, converting types
  /// sqflite cannot store (bool, nested objects) on the way through.
  Map<String, Object?> _project(Map<String, dynamic> row, List<String>? columns) {
    final keys = columns ?? row.keys.toList();
    final out = <String, Object?>{};
    for (final key in keys) {
      final value = row[key];
      out[key] = switch (value) {
        bool b => b ? 1 : 0,
        Map _ => LocalDb.encode(value),
        List _ => LocalDb.encode(value),
        _ => value,
      };
    }
    return out;
  }

  Future<String> _deviceId() async {
    final prefs = await SharedPreferences.getInstance();
    var id = prefs.getString(_deviceIdKey);
    if (id == null) {
      id = 'raut-${DateTime.now().millisecondsSinceEpoch}-'
          '${DateTime.now().microsecond}';
      await prefs.setString(_deviceIdKey, id);
    }
    return id;
  }

  Future<void> reset() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(_lastSyncKey);
    _set(const SyncStatus());
  }
  /// Asks the server to file one invoice with KRA now.
  ///
  /// Online-only, and that is not a shortcut: transmission happens on the
  /// server under the company's own Digitax credentials, which the handset
  /// never holds and must never hold. With no signal there is nothing to queue
  /// here — the invoice is already marked for filing server-side and the
  /// scheduled sweep will pick it up.
  Future<void> pushEtims(String invoiceId) async {
    await _api.post('/etims/transmit', {
      'docType': 'SALE',
      'docId': invoiceId,
    });
  }

}
