import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:path/path.dart' as p;
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

import 'package:raut_field/core/local_db.dart';
import 'package:raut_field/core/receipt.dart';
import 'package:raut_field/models/models.dart';

/// What a customer is handed, and what stock a sale takes.
///
/// The two things here that are worth a test rather than a read-through: a
/// receipt must never claim to be a tax invoice it is not, and a carton must
/// take a carton's worth off the shelf. Both are silent when wrong — the paper
/// looks right, the sale completes — and both are expensive months later.
void main() {
  sqfliteFfiInit();
  databaseFactory = databaseFactoryFfi;

  const company = CompanyInfo(
    id: 'c1',
    name: 'Zamar Solutions Limited',
    taxPin: 'P051234567X',
    address: 'Industrial Area, Nairobi',
    phone: '+254711000000',
  );

  InvoiceSummary invoice({
    String? etimsStatus,
    String? controlCode,
    String? qrUrl,
  }) =>
      InvoiceSummary(
        id: 'inv1',
        number: 'INV-0001',
        customerId: 'cus1',
        status: 'ISSUED',
        subtotalCents: 250000,
        taxCents: 40000,
        totalCents: 290000,
        paidCents: 0,
        issueDate: DateTime.utc(2026, 9, 1, 10, 30),
        etimsStatus: etimsStatus,
        etimsControlCode: controlCode,
        etimsQrUrl: qrUrl,
      );

  final lines = [
    InvoiceLine(
      id: 'l1',
      invoiceId: 'inv1',
      productId: 'p1',
      description: 'Detergent 10kg',
      quantity: 1,
      unitPriceCents: 250000,
      lineTotalCents: 290000,
    ),
  ];

  group('A receipt only claims what KRA has confirmed', () {
    test('an accepted sale prints as a tax invoice, with its control code', () {
      final r = Receipt(
        company: company,
        invoice: invoice(
          etimsStatus: 'ACCEPTED',
          controlCode: '3JYZVPTPMYBGHG4A',
          qrUrl: 'https://etims.kra.go.ke/receipt/abc',
        ),
        lines: lines,
      );

      expect(r.isTaxInvoice, isTrue);
      expect(r.heading, 'TAX INVOICE');

      final text = r.asText();
      expect(text, contains('3JYZVPTPMYBGHG4A'));
      expect(text, contains('P051234567X'));
      expect(text, contains('[ QR CODE ]'));
      expect(text, isNot(contains('NOT A TAX INVOICE')));
    });

    test('a queued sale does not, and says so on its face', () {
      final r = Receipt(
        company: company,
        invoice: invoice(etimsStatus: 'QUEUED'),
        lines: lines,
      );

      expect(r.isTaxInvoice, isFalse);
      expect(r.heading, 'SALES RECEIPT');
      expect(r.asText(), contains('NOT A TAX INVOICE'));
    });

    test(
      'a status of ACCEPTED with no control code is still not a tax invoice',
      () {
        // This state should not exist. If it ever does, printing it as valid
        // would put a document in a customer's hands that KRA cannot verify,
        // so the control code is checked as well as the status.
        final r = Receipt(
          company: company,
          invoice: invoice(etimsStatus: 'ACCEPTED'),
          lines: lines,
        );

        expect(r.isTaxInvoice, isFalse);
        expect(r.asText(), contains('NOT A TAX INVOICE'));
      },
    );

    test('a company that does not file still gets a clean receipt', () {
      final r = Receipt(
        company: company,
        invoice: invoice(etimsStatus: 'NOT_APPLICABLE'),
        lines: lines,
      );

      final text = r.asText();
      expect(text, contains('Detergent 10kg'));
      expect(text, contains('TOTAL'));
      // Honest rather than alarming: they are not waiting for anything.
      expect(r.heading, 'SALES RECEIPT');
    });

    test('a reprint is marked, so two papers are not read as two charges', () {
      final r = Receipt(
        company: company,
        invoice: invoice(etimsStatus: 'ACCEPTED', controlCode: 'ABC123'),
        lines: lines,
        copy: true,
      );

      expect(r.asText(), contains('DUPLICATE'));
    });

    test('no row overruns the paper width', () {
      final r = Receipt(
        company: company,
        invoice: invoice(etimsStatus: 'ACCEPTED', controlCode: 'ABC123'),
        lines: [
          InvoiceLine(
            id: 'l1',
            invoiceId: 'inv1',
            productId: 'p1',
            // Longer than the roll is wide, which is the normal case for a
            // real product name.
            description: 'Premium Concentrated Laundry Detergent 10kg Carton',
            quantity: 3,
            unitPriceCents: 250000,
            lineTotalCents: 870000,
          ),
        ],
      );

      // Column rows are what wrap and destroy alignment; a long description is
      // deliberately given a line of its own, so only the columns are checked.
      for (final op in r.build()) {
        if (op['type'] != 'columns') continue;
        final widths = (op['widths'] as List).cast<int>();
        expect(
          widths.reduce((a, b) => a + b),
          lessThanOrEqualTo(Receipt.width),
          reason: 'a column row is wider than the paper',
        );
      }
    });
  });

  group('A return prints as its own document', () {
    CreditNoteSummary note({String? etimsStatus, String? controlCode}) =>
        CreditNoteSummary(
          id: 'cn1',
          number: 'CRN-0001',
          invoiceId: 'inv1',
          customerId: 'cus1',
          status: 'ISSUED',
          reason: 'Damaged in transit',
          subtotalCents: 125000,
          taxCents: 20000,
          totalCents: 145000,
          issueDate: DateTime.utc(2026, 9, 2, 9, 15),
          etimsStatus: etimsStatus,
          etimsControlCode: controlCode,
        );

    final returnedLines = [
      const ReceiptLine(
        description: 'Detergent 10kg',
        quantity: 1,
        unitPriceCents: 125000,
        lineTotalCents: 145000,
        variantName: 'Dozen',
      ),
    ];

    test('an accepted return prints as a credit note with its own code', () {
      final r = Receipt.forReturn(
        company: company,
        note: note(etimsStatus: 'ACCEPTED', controlCode: 'RETURNCODE123456'),
        lines: returnedLines,
        invoiceNumber: 'INV-0001',
      );

      expect(r.isTaxInvoice, isTrue);
      expect(r.heading, 'CREDIT NOTE');

      final text = r.asText();
      expect(text, contains('RETURNCODE123456'));
      // Naming the sale is what lets a customer and an auditor match the two.
      expect(text, contains('INV-0001'));
      expect(text, contains('Damaged in transit'));
      expect(text, contains('CREDITED'));
      expect(text, contains('Detergent 10kg - Dozen'));
    });

    test('an unfiled return says it is not a credit note yet', () {
      final r = Receipt.forReturn(
        company: company,
        note: note(etimsStatus: 'QUEUED'),
        lines: returnedLines,
        invoiceNumber: 'INV-0001',
      );

      expect(r.isTaxInvoice, isFalse);
      expect(r.heading, 'RETURN NOTE');
      final text = r.asText();
      expect(text, contains('NOT A CREDIT NOTE'));
      // Not the sale's wording: a customer holding this is owed a credit note,
      // not a tax invoice.
      expect(text, isNot(contains('NOT A TAX INVOICE')));
    });

    test('a return never shows a balance owed', () {
      // It reverses a debt rather than creating one, and printing "Balance"
      // under a credit reads as though the customer still owes it.
      final r = Receipt.forReturn(
        company: company,
        note: note(etimsStatus: 'ACCEPTED', controlCode: 'ABC'),
        lines: returnedLines,
        invoiceNumber: 'INV-0001',
      );
      expect(r.asText(), isNot(contains('Balance')));
    });

    test('the "Against" line is dropped rather than printed empty', () {
      final r = Receipt.forReturn(
        company: company,
        note: note(etimsStatus: 'QUEUED'),
        lines: returnedLines,
        invoiceNumber: '',
      );
      expect(r.asText(), isNot(contains('Against')));
    });
  });

  group('Selling units take the right stock', () {
    final product = Product(
      id: 'p1',
      sku: 'DET-10',
      name: 'Detergent 10kg',
      unit: 'PC',
      sellPriceCents: 250000,
      taxRateBp: 1600,
    );

    test('a base-unit line takes one unit each', () {
      final line = CartLine(product: product, quantity: 3);
      expect(line.baseQuantity, 3);
      expect(line.unitPriceCents, 250000);
      expect(line.label, 'Detergent 10kg');
    });

    test('a dozen takes twelve, and is priced as a dozen', () {
      const dozen = ProductVariant(
        id: 'v1',
        productId: 'p1',
        name: 'Dozen',
        sku: 'DET-10-12',
        unitsPerVariant: 12,
        sellPriceCents: 2880000,
      );

      final line = CartLine(product: product, variant: dozen, quantity: 2);

      // The point of the whole feature: two dozen is twenty-four off the shelf.
      expect(line.baseQuantity, 24);
      // And priced by the dozen, not twelve times the single price — a carton
      // is cheaper, which is why anyone buys one.
      expect(line.unitPriceCents, 2880000);
      expect(line.grossCents, 5760000);
      expect(line.label, 'Detergent 10kg - Dozen');
      expect(line.toPayload()['variantId'], 'v1');
      // Quantity crosses the wire in the unit sold; the server multiplies.
      expect(line.toPayload()['quantity'], 2);
    });

    test('per-base-unit price is shown so the discount is checkable', () {
      const dozen = ProductVariant(
        id: 'v1',
        productId: 'p1',
        name: 'Dozen',
        sku: 'DET-10-12',
        unitsPerVariant: 12,
        sellPriceCents: 2880000,
      );

      expect(dozen.perBaseUnitCents, 240000);
      expect(dozen.perBaseUnitCents, lessThan(product.sellPriceCents));
    });
  });

  group('Upgrading the local store', () {
    test('an upgrade keeps the outbox and adds the new tables', () async {
      // The one thing a migration must never lose. Mirrored rows come back on
      // the next sync; a queued sale exists nowhere else in the world, so a
      // schema change that drops and recreates would take a day of field work
      // with it.
      final dir = await Directory.systemTemp.createTemp('raut_migrate');
      final path = p.join(dir.path, 'legacy.db');

      // A version-1 store, as an installed handset would have it.
      final legacy = await databaseFactory.openDatabase(
        path,
        options: OpenDatabaseOptions(version: 1),
      );
      await legacy.execute('''
        CREATE TABLE outbox (
          uuid TEXT PRIMARY KEY,
          type TEXT NOT NULL,
          payload TEXT NOT NULL,
          createdAt TEXT NOT NULL,
          attempts INTEGER DEFAULT 0,
          lastError TEXT,
          syncedAt TEXT,
          serverId TEXT
        )
      ''');
      await legacy.execute('''
        CREATE TABLE invoices (
          id TEXT PRIMARY KEY,
          number TEXT,
          customerId TEXT,
          status TEXT,
          issueDate TEXT,
          dueDate TEXT,
          totalCents INTEGER,
          paidCents INTEGER,
          updatedAt TEXT
        )
      ''');
      await legacy.insert('outbox', {
        'uuid': 'u1',
        'type': 'order',
        'payload': '{"customerId":"c1"}',
        'createdAt': DateTime.now().toUtc().toIso8601String(),
      });
      await legacy.insert('invoices', {
        'id': 'inv-old',
        'number': 'INV-0001',
        'customerId': 'c1',
        'status': 'ISSUED',
        'totalCents': 1000,
        'paidCents': 0,
      });
      await legacy.close();

      // Opening through LocalDb runs onUpgrade all the way to the current
      // version.
      final db = LocalDb.at(path);

      expect(await db.count('outbox'), 1, reason: 'the unsynced sale survived');
      expect(await db.count('invoices'), 1, reason: 'mirrored rows survived');

      // And the new shape is usable, not merely present.
      await db.upsertAll('invoice_lines', [
        {
          'id': 'l1',
          'invoiceId': 'inv-old',
          'productId': 'p1',
          'description': 'Detergent 10kg',
          'quantity': 1,
          'baseQuantity': 12,
          'variantName': 'Dozen',
          'unitPriceCents': 250000,
          'lineTotalCents': 290000,
        }
      ]);
      await db.upsertAll('product_variants', [
        {
          'id': 'v1',
          'productId': 'p1',
          'name': 'Dozen',
          'sku': 'DET-12',
          'unitsPerVariant': 12,
          'sellPriceCents': 2880000,
          'isDefault': 0,
          'active': 1,
        }
      ]);

      expect(await db.count('invoice_lines'), 1);
      expect(await db.count('product_variants'), 1);

      await db.close();
      await dir.delete(recursive: true);
    });
  });
}
