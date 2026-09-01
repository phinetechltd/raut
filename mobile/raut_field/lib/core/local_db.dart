import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:path/path.dart' as p;
import 'package:sqflite/sqflite.dart';

/// The offline mirror.
///
/// Two kinds of table live here and they must not be confused:
///
///  * **Mirror tables** (customers, products, visits, routes …) are replicas of
///    server state, replaced wholesale on pull. Never edit them expecting the
///    edit to survive — the next pull overwrites.
///  * **The outbox** is locally-authored truth waiting to reach the server.
///    Nothing may delete an outbox row until the server has acknowledged it.
///
/// Server ids and local ids are kept strictly separate. A record the rep
/// created offline has a client UUID and no server id until sync assigns one;
/// treating the two as interchangeable is how offline systems corrupt data.
class LocalDb {
  LocalDb._();

  /// Builds an isolated instance at an explicit path. Tests pass sqflite's
  /// `inMemoryDatabasePath` so each case starts from a clean schema instead of
  /// inheriting whatever the previous one left behind.
  @visibleForTesting
  LocalDb.at(this._overridePath);

  static final LocalDb instance = LocalDb._();

  String? _overridePath;
  Database? _db;

  Future<Database> get database async {
    if (_db != null) return _db!;
    _db = await _open();
    return _db!;
  }

  Future<Database> _open() async {
    final path = _overridePath ?? p.join(await getDatabasesPath(), 'raut_field.db');
    return openDatabase(
      path,
      version: 3,
      onConfigure: (db) async {
        await db.execute('PRAGMA foreign_keys = ON');
      },
      onCreate: _createSchema,
      onUpgrade: _upgradeSchema,
    );
  }

  /// Releases the handle. Only needed by tests — the app holds one connection
  /// for its whole lifetime.
  @visibleForTesting
  Future<void> close() async {
    await _db?.close();
    _db = null;
  }

  /// Migrates in place rather than recreating.
  ///
  /// The obvious shortcut - drop everything and let the next sync refill it -
  /// would take the **outbox** with it, and the outbox holds sales a rep has
  /// made but not yet synced. Those exist nowhere else. Mirrored tables are
  /// disposable; the outbox is not, and one schema change must not be able to
  /// lose a day of field work.
  Future<void> _upgradeSchema(Database db, int from, int to) async {
    if (from < 2) {
      for (final column in const [
        'subtotalCents INTEGER',
        'discountCents INTEGER',
        'taxCents INTEGER',
        'etimsStatus TEXT',
        'etimsControlCode TEXT',
        'etimsInvoiceNumber TEXT',
        'etimsSerialNumber TEXT',
        'etimsQrUrl TEXT',
      ]) {
        // Tolerated one at a time: an upgrade interrupted half way through
        // must not brick the app on the next launch.
        try {
          await db.execute('ALTER TABLE invoices ADD COLUMN $column');
        } catch (_) {}
      }

      await db.execute('''
        CREATE TABLE IF NOT EXISTS invoice_lines (
          id TEXT PRIMARY KEY,
          invoiceId TEXT,
          productId TEXT,
          description TEXT,
          quantity INTEGER,
          unitPriceCents INTEGER,
          discountCents INTEGER,
          taxRateBp INTEGER,
          lineTotalCents INTEGER
        )
      ''');
      await db.execute(
        'CREATE INDEX IF NOT EXISTS idx_invoice_lines ON invoice_lines(invoiceId)',
      );
    }

    if (from < 3) {
      await db.execute('''
        CREATE TABLE IF NOT EXISTS product_variants (
          id TEXT PRIMARY KEY,
          productId TEXT,
          name TEXT,
          sku TEXT,
          barcode TEXT,
          unitsPerVariant INTEGER,
          sellPriceCents INTEGER,
          isDefault INTEGER,
          active INTEGER,
          updatedAt TEXT
        )
      ''');
      await db.execute(
        'CREATE INDEX IF NOT EXISTS idx_variants_product ON product_variants(productId)',
      );
      for (final column in const ['variantId TEXT', 'variantName TEXT', 'baseQuantity INTEGER']) {
        try {
          await db.execute('ALTER TABLE invoice_lines ADD COLUMN $column');
        } catch (_) {}
      }
    }
  }

  Future<void> _createSchema(Database db, int version) async {
    // ── mirror tables ──────────────────────────────────────────────────
    await db.execute('''
      CREATE TABLE customers (
        id TEXT PRIMARY KEY,
        code TEXT,
        name TEXT NOT NULL,
        type TEXT,
        segment TEXT,
        phone TEXT,
        email TEXT,
        address TEXT,
        town TEXT,
        latitude REAL,
        longitude REAL,
        geofenceRadiusM INTEGER DEFAULT 150,
        creditLimitCents INTEGER DEFAULT 0,
        paymentTermsDays INTEGER DEFAULT 0,
        balanceCents INTEGER DEFAULT 0,
        status TEXT,
        territoryId TEXT,
        assignedRepId TEXT,
        notes TEXT,
        updatedAt TEXT,
        /* set when the rep created this customer offline and it has not synced */
        pendingUuid TEXT
      )
    ''');

    await db.execute('''
      CREATE TABLE products (
        id TEXT PRIMARY KEY,
        sku TEXT,
        name TEXT NOT NULL,
        unit TEXT,
        unitsPerPack INTEGER DEFAULT 1,
        barcode TEXT,
        sellPriceCents INTEGER DEFAULT 0,
        taxRateBp INTEGER DEFAULT 1600,
        categoryId TEXT,
        active INTEGER DEFAULT 1,
        updatedAt TEXT
      )
    ''');

    await db.execute('''
      CREATE TABLE territories (
        id TEXT PRIMARY KEY,
        name TEXT,
        code TEXT,
        colour TEXT,
        boundary TEXT,
        centerLat REAL,
        centerLng REAL,
        radiusM INTEGER,
        updatedAt TEXT
      )
    ''');

    await db.execute('''
      CREATE TABLE stock (
        id TEXT PRIMARY KEY,
        productId TEXT,
        locationId TEXT,
        quantity INTEGER DEFAULT 0,
        updatedAt TEXT
      )
    ''');

    await db.execute('''
      CREATE TABLE visits (
        id TEXT PRIMARY KEY,
        customerId TEXT,
        repId TEXT,
        routeId TEXT,
        status TEXT,
        purpose TEXT,
        scheduledAt TEXT,
        checkInAt TEXT,
        checkInLat REAL,
        checkInLng REAL,
        checkOutAt TEXT,
        geofenceVerified INTEGER DEFAULT 0,
        distanceFromCustomerM INTEGER,
        durationMin INTEGER,
        outcome TEXT,
        notes TEXT,
        updatedAt TEXT,
        /* true while a check-in/out is queued but not yet acknowledged */
        dirty INTEGER DEFAULT 0
      )
    ''');

    await db.execute('''
      CREATE TABLE routes (
        id TEXT PRIMARY KEY,
        repId TEXT,
        territoryId TEXT,
        name TEXT,
        routeDate TEXT,
        status TEXT,
        totalDistanceM INTEGER,
        estimatedMin INTEGER,
        startLat REAL,
        startLng REAL,
        updatedAt TEXT
      )
    ''');

    await db.execute('''
      CREATE TABLE route_stops (
        id TEXT PRIMARY KEY,
        routeId TEXT,
        customerId TEXT,
        sequence INTEGER,
        status TEXT,
        plannedAt TEXT,
        legDistanceM INTEGER,
        legMin INTEGER
      )
    ''');

    await db.execute('''
      CREATE TABLE orders (
        id TEXT PRIMARY KEY,
        number TEXT,
        customerId TEXT,
        status TEXT,
        channel TEXT,
        orderDate TEXT,
        totalCents INTEGER,
        linesJson TEXT,
        updatedAt TEXT,
        clientUuid TEXT
      )
    ''');

    await db.execute('''
      CREATE TABLE invoices (
        id TEXT PRIMARY KEY,
        number TEXT,
        customerId TEXT,
        status TEXT,
        issueDate TEXT,
        dueDate TEXT,
        subtotalCents INTEGER,
        discountCents INTEGER,
        taxCents INTEGER,
        totalCents INTEGER,
        paidCents INTEGER,
        etimsStatus TEXT,
        etimsControlCode TEXT,
        etimsInvoiceNumber TEXT,
        etimsSerialNumber TEXT,
        etimsQrUrl TEXT,
        updatedAt TEXT
      )
    ''');

    // Selling units. Kept as their own table rather than columns on
    // products, because one product has several and a rep picks between
    // them at the counter.
    await db.execute('''
      CREATE TABLE product_variants (
        id TEXT PRIMARY KEY,
        productId TEXT,
        name TEXT,
        sku TEXT,
        barcode TEXT,
        unitsPerVariant INTEGER,
        sellPriceCents INTEGER,
        isDefault INTEGER,
        active INTEGER,
        updatedAt TEXT
      )
    ''');

    await db.execute('CREATE INDEX idx_variants_product ON product_variants(productId)');

    // Lines are mirrored, not derived: a receipt has to reprint identically
    // days later, on a handset that may never see that invoice again.
    await db.execute('''
      CREATE TABLE invoice_lines (
        id TEXT PRIMARY KEY,
        invoiceId TEXT,
        productId TEXT,
        variantId TEXT,
        variantName TEXT,
        description TEXT,
        quantity INTEGER,
        baseQuantity INTEGER,
        unitPriceCents INTEGER,
        discountCents INTEGER,
        taxRateBp INTEGER,
        lineTotalCents INTEGER
      )
    ''');

    await db.execute('CREATE INDEX idx_invoice_lines ON invoice_lines(invoiceId)');

    await db.execute('''
      CREATE TABLE payments (
        id TEXT PRIMARY KEY,
        number TEXT,
        customerId TEXT,
        amountCents INTEGER,
        method TEXT,
        reference TEXT,
        paidAt TEXT,
        updatedAt TEXT,
        clientUuid TEXT
      )
    ''');

    await db.execute('''
      CREATE TABLE expense_categories (
        id TEXT PRIMARY KEY,
        name TEXT,
        code TEXT
      )
    ''');

    // ── locally-authored truth ─────────────────────────────────────────
    await db.execute('''
      CREATE TABLE outbox (
        uuid TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        attempts INTEGER DEFAULT 0,
        lastError TEXT,
        /* set once the server acknowledges; row is kept briefly for the UI */
        syncedAt TEXT,
        serverId TEXT
      )
    ''');

    await db.execute('''
      CREATE TABLE location_buffer (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        latitude REAL NOT NULL,
        longitude REAL NOT NULL,
        accuracyM REAL,
        speedMps REAL,
        heading REAL,
        batteryPct INTEGER,
        isMoving INTEGER DEFAULT 1,
        recordedAt TEXT NOT NULL
      )
    ''');

    await db.execute('''
      CREATE TABLE pending_photos (
        uuid TEXT PRIMARY KEY,
        visitId TEXT NOT NULL,
        filePath TEXT NOT NULL,
        caption TEXT,
        latitude REAL,
        longitude REAL,
        takenAt TEXT,
        syncedAt TEXT
      )
    ''');

    for (final statement in const [
      'CREATE INDEX idx_visits_scheduled ON visits(scheduledAt)',
      'CREATE INDEX idx_visits_customer ON visits(customerId)',
      'CREATE INDEX idx_stops_route ON route_stops(routeId, sequence)',
      'CREATE INDEX idx_outbox_pending ON outbox(syncedAt)',
      'CREATE INDEX idx_customers_name ON customers(name)',
    ]) {
      await db.execute(statement);
    }
  }

  /// Replaces mirror rows in one transaction, so a pull that fails halfway
  /// cannot leave the handset holding a half-updated customer list.
  Future<void> upsertAll(String table, List<Map<String, Object?>> rows) async {
    if (rows.isEmpty) return;
    final db = await database;
    final batch = db.batch();
    for (final row in rows) {
      batch.insert(table, row, conflictAlgorithm: ConflictAlgorithm.replace);
    }
    await batch.commit(noResult: true);
  }

  Future<List<Map<String, Object?>>> query(
    String table, {
    String? where,
    List<Object?>? whereArgs,
    String? orderBy,
    int? limit,
  }) async {
    final db = await database;
    return db.query(
      table,
      where: where,
      whereArgs: whereArgs,
      orderBy: orderBy,
      limit: limit,
    );
  }

  Future<int> count(String table, {String? where, List<Object?>? whereArgs}) async {
    final db = await database;
    final result = await db.rawQuery(
      'SELECT COUNT(*) AS c FROM $table${where != null ? ' WHERE $where' : ''}',
      whereArgs,
    );
    return Sqflite.firstIntValue(result) ?? 0;
  }

  Future<void> update(
    String table,
    Map<String, Object?> values, {
    required String where,
    required List<Object?> whereArgs,
  }) async {
    final db = await database;
    await db.update(table, values, where: where, whereArgs: whereArgs);
  }

  Future<void> insert(String table, Map<String, Object?> values) async {
    final db = await database;
    await db.insert(table, values, conflictAlgorithm: ConflictAlgorithm.replace);
  }

  Future<void> delete(String table, {String? where, List<Object?>? whereArgs}) async {
    final db = await database;
    await db.delete(table, where: where, whereArgs: whereArgs);
  }

  Future<void> execute(String sql, [List<Object?>? args]) async {
    final db = await database;
    await db.execute(sql, args);
  }

  /// Wipes everything on sign-out. A shared handset must not leak one rep's
  /// customer book to the next person who signs in.
  Future<void> wipe() async {
    final db = await database;
    for (final table in const [
      'customers', 'products', 'territories', 'stock', 'visits', 'routes',
      'route_stops', 'orders', 'invoices', 'payments', 'expense_categories',
      'outbox', 'location_buffer', 'pending_photos',
    ]) {
      await db.delete(table);
    }
  }

  static String encode(Object? value) => jsonEncode(value);

  static dynamic decode(String? value) =>
      value == null || value.isEmpty ? null : jsonDecode(value);
}
