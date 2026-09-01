import 'package:flutter/foundation.dart';

import '../core/geo.dart';
import '../core/local_db.dart';
import '../core/outbox.dart';
import '../models/models.dart';

/// All reads and writes the field app performs.
///
/// Every write is **local-first**: it lands in the local mirror and the outbox
/// in the same call, so the UI reflects the rep's action immediately whether or
/// not there is signal. Sync drains the outbox later. Nothing in the UI ever
/// waits on the network to show a result — that is the whole premise of the app.
class FieldRepository extends ChangeNotifier {
  FieldRepository({required LocalDb db, required Outbox outbox})
      : _db = db,
        _outbox = outbox;

  final LocalDb _db;
  final Outbox _outbox;

  // ── customers ────────────────────────────────────────────────────────

  Future<List<Customer>> customers({String? search, bool owingOnly = false}) async {
    final clauses = <String>[];
    final args = <Object?>[];

    if (search != null && search.trim().isNotEmpty) {
      clauses.add('(name LIKE ? OR code LIKE ? OR phone LIKE ? OR town LIKE ?)');
      final term = '%${search.trim()}%';
      args.addAll([term, term, term, term]);
    }
    if (owingOnly) clauses.add('balanceCents > 0');

    final rows = await _db.query(
      'customers',
      where: clauses.isEmpty ? null : clauses.join(' AND '),
      whereArgs: args.isEmpty ? null : args,
      orderBy: 'name ASC',
    );
    return rows.map(Customer.fromRow).toList();
  }

  Future<Customer?> customer(String id) async {
    final rows = await _db.query('customers', where: 'id = ?', whereArgs: [id], limit: 1);
    return rows.isEmpty ? null : Customer.fromRow(rows.first);
  }

  /// Creates a customer offline.
  ///
  /// The row is written with a local id prefixed `local:` so nothing can mistake
  /// it for a server id, and the outbox UUID is stored on the row. When sync
  /// acknowledges it, the next pull brings the real record.
  Future<Customer> createCustomer({
    required String name,
    String? phone,
    String? town,
    String? address,
    double? latitude,
    double? longitude,
    String? territoryId,
    String? notes,
  }) async {
    final uuid = await _outbox.enqueue(OpType.customerCreate, {
      'name': name,
      'phone': phone,
      'town': town,
      'address': address,
      'latitude': latitude,
      'longitude': longitude,
      'territoryId': territoryId,
      'notes': notes,
    });

    final localId = 'local:$uuid';
    await _db.insert('customers', {
      'id': localId,
      'code': 'PENDING',
      'name': name,
      'type': 'RETAIL',
      'segment': 'C',
      'phone': phone,
      'town': town,
      'address': address,
      'latitude': latitude,
      'longitude': longitude,
      'geofenceRadiusM': 150,
      'status': 'ACTIVE',
      'territoryId': territoryId,
      'notes': notes,
      'balanceCents': 0,
      'updatedAt': _utc(DateTime.now()),
      'pendingUuid': uuid,
    });

    notifyListeners();
    return (await customer(localId))!;
  }

  /// Drops or corrects a customer's GPS pin. This is the single most valuable
  /// thing a rep does for the platform — without pins, routing and geofencing
  /// have nothing to work with.
  Future<void> updateCustomerLocation(
    String customerId, {
    required double latitude,
    required double longitude,
  }) async {
    // A customer that has not synced yet cannot be updated by server id; its
    // create payload is amended instead on the next drain.
    if (!customerId.startsWith('local:')) {
      await _outbox.enqueue(OpType.customerUpdate, {
        'id': customerId,
        'latitude': latitude,
        'longitude': longitude,
      });
    }

    await _db.update(
      'customers',
      {'latitude': latitude, 'longitude': longitude},
      where: 'id = ?',
      whereArgs: [customerId],
    );
    notifyListeners();
  }

  Future<void> updateCustomerContact(
    String customerId, {
    String? phone,
    String? email,
    String? address,
    String? town,
    String? notes,
  }) async {
    final payload = <String, dynamic>{'id': customerId};
    if (phone != null) payload['phone'] = phone;
    if (email != null) payload['email'] = email;
    if (address != null) payload['address'] = address;
    if (town != null) payload['town'] = town;
    if (notes != null) payload['notes'] = notes;

    if (!customerId.startsWith('local:')) {
      await _outbox.enqueue(OpType.customerUpdate, payload);
    }

    payload.remove('id');
    await _db.update('customers', payload, where: 'id = ?', whereArgs: [customerId]);
    notifyListeners();
  }

  // ── products ─────────────────────────────────────────────────────────

  Future<List<Product>> products({String? search, bool vanOnly = false}) async {
    final db = await _db.database;

    // Van stock is joined in so the order screen can warn when a rep is
    // selling something that is not on the vehicle.
    final rows = await db.rawQuery('''
      SELECT p.*, (
        SELECT SUM(s.quantity) FROM stock s WHERE s.productId = p.id
      ) AS vanQuantity
      FROM products p
      WHERE p.active = 1
      ${search != null && search.trim().isNotEmpty ? 'AND (p.name LIKE ? OR p.sku LIKE ?)' : ''}
      ORDER BY p.name ASC
    ''', [
      if (search != null && search.trim().isNotEmpty) ...[
        '%${search.trim()}%',
        '%${search.trim()}%',
      ],
    ]);

    final products = rows.map(Product.fromRow).toList();
    return vanOnly
        ? products.where((p) => (p.vanQuantity ?? 0) > 0).toList()
        : products;
  }

  // ── route & visits ───────────────────────────────────────────────────

  /// The one timestamp format the local store holds: UTC ISO, `Z`-suffixed.
  ///
  /// Dates that arrive from sync are the server's `toISOString()` — always UTC.
  /// Dates written here for offline work used to be naive *local* strings, so
  /// the store held two formats at once and every `>=`/`<` in SQL compared
  /// across them. At UTC+3 that put the day boundary three hours out: a route
  /// stamped local midnight lands at 21:00Z the day before, so `todaysRoute()`
  /// never matched it and the route header fell back to "Unplanned visits".
  ///
  /// Reads are unaffected either way — `_date()` calls `.toLocal()`, and Dart
  /// parses an offsetless string as local. Only the SQL comparison cared.
  static String _utc(DateTime t) => t.toUtc().toIso8601String();

  Future<FieldRoute?> todaysRoute() async {
    final start = DateTime.now();
    final dayStart = DateTime(start.year, start.month, start.day);
    final dayEnd = dayStart.add(const Duration(days: 1));

    final rows = await _db.query(
      'routes',
      where: 'routeDate >= ? AND routeDate < ?',
      // Local midnight, expressed in the store's format. See _utc.
      whereArgs: [_utc(dayStart), _utc(dayEnd)],
      orderBy: 'routeDate DESC',
      limit: 1,
    );
    if (rows.isEmpty) return null;

    final route = rows.first;
    final stopRows = await _db.query(
      'route_stops',
      where: 'routeId = ?',
      whereArgs: [route['id']],
      orderBy: 'sequence ASC',
    );

    return FieldRoute.fromRow(route, stopRows.map(RouteStop.fromRow).toList());
  }

  Future<List<Visit>> visitsForDay([DateTime? day]) async {
    final target = day ?? DateTime.now();
    final dayStart = DateTime(target.year, target.month, target.day);
    final dayEnd = dayStart.add(const Duration(days: 1));

    final rows = await _db.query(
      'visits',
      where: 'scheduledAt >= ? AND scheduledAt < ?',
      whereArgs: [_utc(dayStart), _utc(dayEnd)],
      orderBy: 'scheduledAt ASC',
    );
    return rows.map(Visit.fromRow).toList();
  }

  Future<Visit?> visit(String id) async {
    final rows = await _db.query('visits', where: 'id = ?', whereArgs: [id], limit: 1);
    return rows.isEmpty ? null : Visit.fromRow(rows.first);
  }

  Future<List<Visit>> visitsForCustomer(String customerId, {int limit = 10}) async {
    final rows = await _db.query(
      'visits',
      where: 'customerId = ?',
      whereArgs: [customerId],
      orderBy: 'scheduledAt DESC',
      limit: limit,
    );
    return rows.map(Visit.fromRow).toList();
  }

  /// Records a check-in locally and queues it.
  ///
  /// Verification is computed here with the same rules the server uses, so the
  /// rep sees the verdict instantly. The server recomputes on receipt and its
  /// answer wins — this is a preview, not the decision.
  Future<VisitVerification> checkIn({
    required String visitId,
    required double latitude,
    required double longitude,
    double? accuracyM,
    required bool geofencingEnabled,
  }) async {
    final visit = await this.visit(visitId);
    if (visit == null) throw StateError('Visit not found on this device');
    if (visit.checkInAt != null) throw StateError('You have already checked in here');

    final customer = await this.customer(visit.customerId);
    final verification = verifyVisitLocation(
      checkInLat: latitude,
      checkInLng: longitude,
      customerLat: customer?.latitude,
      customerLng: customer?.longitude,
      geofenceRadiusM: customer?.geofenceRadiusM ?? 150,
      accuracyM: accuracyM,
    );

    final now = DateTime.now();

    await _outbox.enqueue(
      OpType.visitCheckIn,
      {
        'visitId': visitId,
        'latitude': latitude,
        'longitude': longitude,
        'accuracyM': accuracyM,
      },
      at: now,
    );

    await _db.update(
      'visits',
      {
        'status': 'IN_PROGRESS',
        'checkInAt': _utc(now),
        'checkInLat': latitude,
        'checkInLng': longitude,
        // Only claim verification when the module is licensed, matching the
        // server — otherwise the app would show a green tick the back office
        // does not agree with.
        'geofenceVerified': geofencingEnabled && verification.verified ? 1 : 0,
        'distanceFromCustomerM': verification.distanceM,
        'dirty': 1,
      },
      where: 'id = ?',
      whereArgs: [visitId],
    );

    await _db.update(
      'route_stops',
      {'status': 'ARRIVED'},
      where: 'customerId = ? AND routeId = ?',
      whereArgs: [visit.customerId, visit.routeId ?? ''],
    );

    notifyListeners();
    return verification;
  }

  Future<void> checkOut({
    required String visitId,
    double? latitude,
    double? longitude,
    String? outcome,
    String? notes,
  }) async {
    final visit = await this.visit(visitId);
    if (visit == null) throw StateError('Visit not found on this device');
    if (visit.checkInAt == null) throw StateError('Check in before checking out');
    if (visit.checkOutAt != null) throw StateError('You have already checked out');

    final now = DateTime.now();
    final duration = now.difference(visit.checkInAt!).inMinutes;

    await _outbox.enqueue(
      OpType.visitCheckOut,
      {
        'visitId': visitId,
        'latitude': latitude,
        'longitude': longitude,
        'outcome': outcome,
        'notes': notes,
      },
      at: now,
    );

    await _db.update(
      'visits',
      {
        'status': 'COMPLETED',
        'checkOutAt': _utc(now),
        'durationMin': duration < 0 ? 0 : duration,
        'outcome': outcome,
        'notes': notes,
        'dirty': 1,
      },
      where: 'id = ?',
      whereArgs: [visitId],
    );

    await _db.update(
      'route_stops',
      {'status': 'DONE'},
      where: 'customerId = ? AND routeId = ?',
      whereArgs: [visit.customerId, visit.routeId ?? ''],
    );

    notifyListeners();
  }

  /// An unplanned visit — a rep passing a shop that is not on today's route.
  Future<String> createAdHocVisit({
    required String customerId,
    String purpose = 'SALES',
    String? notes,
  }) async {
    final now = DateTime.now();
    final uuid = await _outbox.enqueue(OpType.visitCreate, {
      'customerId': customerId,
      'purpose': purpose,
      'scheduledAt': _utc(now),
      'notes': notes,
    }, at: now);

    final localId = 'local:$uuid';
    await _db.insert('visits', {
      'id': localId,
      'customerId': customerId,
      'status': 'SCHEDULED',
      'purpose': purpose,
      'scheduledAt': _utc(now),
      'notes': notes,
      'geofenceVerified': 0,
      'dirty': 1,
      'updatedAt': _utc(now),
    });

    notifyListeners();
    return localId;
  }

  // ── selling ──────────────────────────────────────────────────────────

  /// Queues an order. Returns the outbox UUID, which is also the server's
  /// idempotency key for this write.
  Future<String> createOrder({
    required String customerId,
    required List<CartLine> lines,
    String? visitId,
    String? note,
  }) async {
    if (lines.isEmpty) throw StateError('Add at least one product');

    final uuid = await _outbox.enqueue(OpType.orderCreate, {
      'customerId': customerId,
      'lines': lines.map((l) => l.toPayload()).toList(),
      // A local visit id is meaningless to the server; omit it and let the
      // order stand on its own rather than sending a reference that will fail.
      if (visitId != null && !visitId.startsWith('local:')) 'visitId': visitId,
      'note': note,
    });

    final total = lines.fold<int>(0, (sum, l) => sum + l.totalCents);
    await _db.insert('orders', {
      'id': 'local:$uuid',
      'number': 'PENDING',
      'customerId': customerId,
      'status': 'CONFIRMED',
      'channel': 'FIELD',
      'orderDate': _utc(DateTime.now()),
      'totalCents': total,
      'linesJson': LocalDb.encode(lines.map((l) => l.toPayload()).toList()),
      'updatedAt': _utc(DateTime.now()),
      'clientUuid': uuid,
    });

    notifyListeners();
    return uuid;
  }

  /// Queues a payment and optimistically reduces the customer's balance, so the
  /// rep sees the effect of the cash they just took.
  Future<String> recordPayment({
    required String customerId,
    required int amountCents,
    String method = 'CASH',
    String? reference,
    String? visitId,
    String? note,
  }) async {
    if (amountCents <= 0) throw StateError('Enter an amount greater than zero');

    final now = DateTime.now();
    final uuid = await _outbox.enqueue(OpType.paymentCreate, {
      'customerId': customerId,
      'amountCents': amountCents,
      'method': method,
      'reference': reference,
      if (visitId != null && !visitId.startsWith('local:')) 'visitId': visitId,
      'note': note,
    }, at: now);

    await _db.insert('payments', {
      'id': 'local:$uuid',
      'number': 'PENDING',
      'customerId': customerId,
      'amountCents': amountCents,
      'method': method,
      'reference': reference,
      'paidAt': _utc(now),
      'updatedAt': _utc(now),
      'clientUuid': uuid,
    });

    await _db.execute(
      'UPDATE customers SET balanceCents = balanceCents - ? WHERE id = ?',
      [amountCents, customerId],
    );

    notifyListeners();
    return uuid;
  }

  Future<void> addNote({
    required String customerId,
    required String subject,
    String? body,
    String type = 'NOTE',
  }) async {
    await _outbox.enqueue(OpType.activityCreate, {
      'customerId': customerId,
      'subject': subject,
      'body': body,
      'type': type,
    });
    notifyListeners();
  }

  Future<void> createExpense({
    required String description,
    required int amountCents,
    String? categoryId,
    String paymentMethod = 'CASH',
    double? latitude,
    double? longitude,
  }) async {
    await _outbox.enqueue(OpType.expenseCreate, {
      'description': description,
      'amountCents': amountCents,
      'categoryId': categoryId,
      'paymentMethod': paymentMethod,
      'latitude': latitude,
      'longitude': longitude,
    });
    notifyListeners();
  }

  Future<List<Map<String, Object?>>> expenseCategories() =>
      _db.query('expense_categories', orderBy: 'name ASC');

  /// Queues a visit photo. The file stays on disk until sync uploads it —
  /// base64ing it into the outbox would bloat the queue for no benefit.
  Future<void> attachPhoto({
    required String visitId,
    required String filePath,
    String? caption,
    double? latitude,
    double? longitude,
  }) async {
    await _db.insert('pending_photos', {
      'uuid': 'photo-${DateTime.now().microsecondsSinceEpoch}',
      'visitId': visitId,
      'filePath': filePath,
      'caption': caption,
      'latitude': latitude,
      'longitude': longitude,
      'takenAt': _utc(DateTime.now()),
    });
    notifyListeners();
  }

  Future<int> pendingPhotoCount() =>
      _db.count('pending_photos', where: 'syncedAt IS NULL');

  /// Selling units, grouped by product.
  ///
  /// Read in one query rather than per product: a catalogue screen renders
  /// several hundred rows and a query each would make scrolling stutter on the
  /// low-end hardware these run on.
  Future<Map<String, List<ProductVariant>>> variantsByProduct() async {
    final rows = await _db.query(
      'product_variants',
      where: 'active = 1',
      orderBy: 'unitsPerVariant ASC',
    );

    final out = <String, List<ProductVariant>>{};
    for (final r in rows) {
      final v = ProductVariant.fromRow(r);
      (out[v.productId] ??= []).add(v);
    }
    return out;
  }

  // ── receivables ──────────────────────────────────────────────────────

  Future<List<InvoiceSummary>> openInvoices(String customerId) async {
    final rows = await _db.query(
      'invoices',
      where: "customerId = ? AND status IN ('ISSUED','PARTIALLY_PAID','OVERDUE')",
      whereArgs: [customerId],
      orderBy: 'dueDate ASC',
    );
    return rows.map(InvoiceSummary.fromRow).toList();
  }

  /// One invoice with its lines, for printing.
  ///
  /// Reads the mirror, not the network. A receipt has to reprint at a roadside
  /// stop with no signal, days after the sale.
  Future<(InvoiceSummary, List<InvoiceLine>)?> invoiceForPrinting(
    String invoiceId,
  ) async {
    final rows = await _db.query('invoices', where: 'id = ?', whereArgs: [invoiceId]);
    if (rows.isEmpty) return null;

    final lines = await _db.query(
      'invoice_lines',
      where: 'invoiceId = ?',
      whereArgs: [invoiceId],
      orderBy: 'id ASC',
    );

    return (
      InvoiceSummary.fromRow(rows.first),
      lines.map(InvoiceLine.fromRow).toList(),
    );
  }

  /// Invoices this handset knows about that KRA has not accepted.
  ///
  /// Deliberately built from the rep's own mirrored invoices rather than the
  /// company-wide transmission log: a rep can push a stuck filing but has no
  /// business reading every sale the company has made.
  Future<List<InvoiceSummary>> invoicesAwaitingEtims() async {
    final rows = await _db.query(
      'invoices',
      where: "etimsStatus IN ('QUEUED','REJECTED','SUBMITTED')",
      orderBy: 'issueDate DESC',
      limit: 50,
    );
    return rows.map(InvoiceSummary.fromRow).toList();
  }

  /// The most recent invoice for a customer, which is what a rep reaches for
  /// straight after a sale.
  Future<InvoiceSummary?> latestInvoiceFor(String customerId) async {
    final rows = await _db.query(
      'invoices',
      where: 'customerId = ?',
      whereArgs: [customerId],
      orderBy: 'issueDate DESC',
      limit: 1,
    );
    return rows.isEmpty ? null : InvoiceSummary.fromRow(rows.first);
  }

  // ── day summary ──────────────────────────────────────────────────────

  Future<DaySummary> todaySummary() async {
    final visits = await visitsForDay();
    final dayStart = DateTime.now();
    final start = DateTime(dayStart.year, dayStart.month, dayStart.day);

    final orders = await _db.query(
      'orders',
      where: 'orderDate >= ?',
      whereArgs: [_utc(start)],
    );
    final payments = await _db.query(
      'payments',
      where: 'paidAt >= ?',
      whereArgs: [_utc(start)],
    );

    return DaySummary(
      visitsPlanned: visits.length,
      visitsDone: visits.where((v) => v.isDone).length,
      visitsVerified: visits.where((v) => v.geofenceVerified).length,
      ordersCount: orders.length,
      salesCents: orders.fold<int>(0, (s, o) => s + ((o['totalCents'] as int?) ?? 0)),
      collectionsCents:
          payments.fold<int>(0, (s, p) => s + ((p['amountCents'] as int?) ?? 0)),
    );
  }
}

class DaySummary {
  const DaySummary({
    required this.visitsPlanned,
    required this.visitsDone,
    required this.visitsVerified,
    required this.ordersCount,
    required this.salesCents,
    required this.collectionsCents,
  });

  final int visitsPlanned;
  final int visitsDone;
  final int visitsVerified;
  final int ordersCount;
  final int salesCents;
  final int collectionsCents;

  int get visitsRemaining => visitsPlanned - visitsDone;
}
