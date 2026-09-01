import 'money.dart';
import 'printer_service.dart';
import '../models/models.dart';

/// One line as it appears on paper.
///
/// Invoices and credit notes are mapped into this rather than the receipt
/// knowing about either. Two layouts would drift, and the day they do is the
/// day a return prints differently from the sale it reverses.
class ReceiptLine {
  const ReceiptLine({
    required this.description,
    required this.quantity,
    required this.unitPriceCents,
    required this.lineTotalCents,
    this.variantName,
  });

  final String description;
  final int quantity;
  final int unitPriceCents;
  final int lineTotalCents;
  final String? variantName;

  /// "Detergent 10kg - Dozen", so the customer can see what unit was sold.
  String get label =>
      variantName == null || variantName!.isEmpty ? description : '$description - $variantName';

  factory ReceiptLine.fromInvoice(InvoiceLine l) => ReceiptLine(
        description: l.description,
        quantity: l.quantity,
        unitPriceCents: l.unitPriceCents,
        lineTotalCents: l.lineTotalCents,
        variantName: l.variantName,
      );

  factory ReceiptLine.fromRow(Map<String, Object?> r) => ReceiptLine(
        description: (r['description'] as String?) ?? '',
        quantity: (r['quantity'] as num?)?.toInt() ?? 0,
        unitPriceCents: (r['unitPriceCents'] as num?)?.toInt() ?? 0,
        lineTotalCents: (r['lineTotalCents'] as num?)?.toInt() ?? 0,
        variantName: r['variantName'] as String?,
      );
}

/// What goes on the paper.
///
/// One source for the printed receipt and the on-screen preview, so a rep can
/// see exactly what the customer will get before committing paper to it.
///
/// The distinction this file exists to keep honest: a document is a **tax
/// invoice** only once KRA has accepted it and returned a control code.
/// Anything else is an interim receipt and says so on its face. Printing
/// "TAX INVOICE" over a document that was never filed would be a small lie
/// with a large consequence — it is the buyer who gets refused the input VAT,
/// months later, with our paper in their hand.
///
/// A **sales return** prints through the same builder with its own control
/// code. It is its own document, not an annotation on the invoice: the original
/// sale happened, KRA has it, and it is not being rewritten.
class Receipt {
  /// A sale.
  Receipt({
    required this.company,
    required InvoiceSummary invoice,
    required List<InvoiceLine> lines,
    this.customerName,
    this.customerPin,
    this.servedBy,
    this.copy = false,
  })  : isReturn = false,
        number = invoice.number,
        date = invoice.issueDate,
        subtotalCents = invoice.subtotalCents,
        discountCents = invoice.discountCents,
        taxCents = invoice.taxCents,
        totalCents = invoice.totalCents,
        paidCents = invoice.paidCents,
        outstandingCents = invoice.outstandingCents,
        etimsStatus = invoice.etimsStatus,
        etimsControlCode = invoice.etimsControlCode,
        etimsInvoiceNumber = invoice.etimsInvoiceNumber,
        etimsSerialNumber = invoice.etimsSerialNumber,
        etimsQrUrl = invoice.etimsQrUrl,
        reference = null,
        reason = null,
        lines = lines.map(ReceiptLine.fromInvoice).toList();

  /// A return, credited against an invoice.
  Receipt.forReturn({
    required this.company,
    required CreditNoteSummary note,
    required this.lines,
    required String invoiceNumber,
    this.customerName,
    this.customerPin,
    this.servedBy,
    this.copy = false,
  })  : isReturn = true,
        number = note.number,
        date = note.issueDate,
        subtotalCents = note.subtotalCents,
        discountCents = 0,
        taxCents = note.taxCents,
        totalCents = note.totalCents,
        paidCents = 0,
        outstandingCents = 0,
        etimsStatus = note.etimsStatus,
        etimsControlCode = note.etimsControlCode,
        etimsInvoiceNumber = note.etimsInvoiceNumber,
        etimsSerialNumber = note.etimsSerialNumber,
        etimsQrUrl = note.etimsQrUrl,
        reference = invoiceNumber,
        reason = note.reason;

  final CompanyInfo company;
  final List<ReceiptLine> lines;
  final String? customerName;
  final String? customerPin;
  final String? servedBy;

  /// A reprint. Marked, because two identical papers for one sale is how a
  /// customer ends up believing they were charged twice.
  final bool copy;

  final bool isReturn;
  final String number;
  final DateTime? date;
  final int subtotalCents;
  final int discountCents;
  final int taxCents;
  final int totalCents;
  final int paidCents;
  final int outstandingCents;

  /// The invoice this return credits. Null on a sale.
  final String? reference;
  final String? reason;

  final String? etimsStatus;
  final String? etimsControlCode;
  final String? etimsInvoiceNumber;
  final String? etimsSerialNumber;
  final String? etimsQrUrl;

  bool get isTaxInvoice =>
      etimsStatus == 'ACCEPTED' && (etimsControlCode?.isNotEmpty ?? false);

  /// 58mm paper at the default font is 32 characters. Everything below is laid
  /// out against that, because a column that overruns wraps and destroys the
  /// alignment of every row after it.
  static const int width = 32;

  String get heading {
    if (isReturn) return isTaxInvoice ? 'CREDIT NOTE' : 'RETURN NOTE';
    return isTaxInvoice ? 'TAX INVOICE' : 'SALES RECEIPT';
  }

  List<Map<String, Object?>> build() {
    final ops = <Map<String, Object?>>[];

    ops.add(Op.text(company.name, align: 'center', size: 30, bold: true));
    if (company.taxPin != null && company.taxPin!.isNotEmpty) {
      ops.add(Op.text('PIN: ${company.taxPin}', align: 'center', size: 22));
    }
    if (company.address != null && company.address!.isNotEmpty) {
      ops.add(Op.text(company.address!, align: 'center', size: 20));
    }
    if (company.phone != null && company.phone!.isNotEmpty) {
      ops.add(Op.text(company.phone!, align: 'center', size: 20));
    }

    ops.add(Op.text(_rule(), size: 20));
    ops.add(Op.text(heading, align: 'center', size: 28, bold: true));
    if (copy) {
      ops.add(Op.text('DUPLICATE', align: 'center', size: 22, bold: true));
    }
    ops.add(Op.text(_rule(), size: 20));

    ops.add(Op.columns(['No.', number], const [10, 22], aligns: const [0, 2]));
    ops.add(Op.columns(['Date', _stamp(date)], const [10, 22], aligns: const [0, 2]));

    // A return without the invoice it credits is unusable to anyone: the
    // customer cannot match it, and neither can an auditor.
    if (reference != null && reference!.isNotEmpty) {
      ops.add(Op.columns(['Against', reference!], const [10, 22], aligns: const [0, 2]));
    }

    if (customerName != null && customerName!.isNotEmpty) {
      // A trading name rarely fits the 22 columns left beside the label, and a
      // receipt that reads "Rift Valley Distributo" looks like a fault rather
      // than a layout. Long names get the full width of their own line.
      if (customerName!.length <= 22) {
        ops.add(Op.columns(['Customer', customerName!], const [10, 22],
            aligns: const [0, 2]));
      } else {
        ops.add(Op.text('Customer', size: 22));
        ops.add(Op.text(customerName!, size: 22));
      }
    }
    if (customerPin != null && customerPin!.isNotEmpty) {
      ops.add(Op.columns(['Buyer PIN', customerPin!], const [10, 22],
          aligns: const [0, 2]));
    }
    if (servedBy != null && servedBy!.isNotEmpty) {
      ops.add(Op.columns(['Served by', servedBy!], const [10, 22],
          aligns: const [0, 2]));
    }

    ops.add(Op.text(_rule(), size: 20));

    if (isReturn) {
      ops.add(Op.text('RETURNED', size: 22, bold: true));
    }

    for (final l in lines) {
      // Description on its own line: product names run past 32 characters far
      // more often than they fit, and truncating them to keep a single row
      // makes the receipt useless for identifying what was bought.
      ops.add(Op.text(l.label, size: 22));
      ops.add(Op.columns(
        [
          '${l.quantity} x ${Money.format(l.unitPriceCents, decimals: true)}',
          Money.format(l.lineTotalCents, decimals: true),
        ],
        const [18, 14],
        aligns: const [0, 2],
      ));
    }

    if (isReturn && reason != null && reason!.isNotEmpty) {
      ops.add(Op.text('Reason: $reason', size: 20));
    }

    ops.add(Op.text(_rule(), size: 20));

    ops.add(_amount('Subtotal', subtotalCents));
    if (discountCents > 0) ops.add(_amount('Discount', -discountCents));
    ops.add(_amount('VAT', taxCents));
    ops.add(Op.columns(
      [isReturn ? 'CREDITED' : 'TOTAL', Money.format(totalCents, decimals: true)],
      const [16, 16],
      aligns: const [0, 2],
    ));
    if (!isReturn && paidCents > 0) {
      ops.add(_amount('Paid', paidCents));
      ops.add(_amount('Balance', outstandingCents));
    }

    ops.add(Op.text(_rule(), size: 20));

    if (isTaxInvoice) {
      ops.add(Op.text('CONTROL CODE', align: 'center', size: 20));
      ops.add(Op.text(etimsControlCode!, align: 'center', size: 26, bold: true));
      if (etimsInvoiceNumber != null) {
        ops.add(Op.text('KRA Invoice No: $etimsInvoiceNumber',
            align: 'center', size: 20));
      }
      if (etimsSerialNumber != null) {
        ops.add(Op.text(etimsSerialNumber!, align: 'center', size: 18));
      }
      if (etimsQrUrl != null && etimsQrUrl!.isNotEmpty) {
        ops.add(Op.feed());
        ops.add(Op.qr(etimsQrUrl!));
      }
      ops.add(Op.feed());
      ops.add(Op.text('Scan to verify with KRA', align: 'center', size: 18));
    } else {
      // Said plainly rather than hidden. The customer needs to know this is
      // not yet the document they can claim VAT against, and the rep needs to
      // know a reprint is owed.
      ops.add(Op.text(
        isReturn ? 'NOT A CREDIT NOTE' : 'NOT A TAX INVOICE',
        align: 'center',
        size: 24,
        bold: true,
      ));
      ops.add(Op.text(
        etimsStatus == 'REJECTED'
            ? 'KRA rejected this. Ask the office.'
            : isReturn
                ? 'Awaiting KRA. A credit note follows.'
                : 'Awaiting KRA. A tax invoice follows.',
        align: 'center',
        size: 18,
      ));
    }

    ops.add(Op.feed(2));
    ops.add(Op.text('Powered by Raut', align: 'center', size: 18));
    ops.add(Op.feed(3));

    return ops;
  }

  Map<String, Object?> _amount(String label, int cents) => Op.columns(
        [label, Money.format(cents, decimals: true)],
        const [16, 16],
        aligns: const [0, 2],
      );

  static String _rule() => '-' * width;

  static String _stamp(DateTime? d) {
    if (d == null) return '';
    final local = d.toLocal();
    String two(int n) => n.toString().padLeft(2, '0');
    return '${two(local.day)}/${two(local.month)}/${local.year} '
        '${two(local.hour)}:${two(local.minute)}';
  }

  /// The same receipt as plain text, for the on-screen preview.
  String asText() {
    final out = StringBuffer();
    for (final op in build()) {
      switch (op['type']) {
        case 'text':
          final value = op['text'] as String;
          out.writeln(op['align'] == 'center' ? _centre(value) : value);
          break;
        case 'columns':
          final cols = (op['columns'] as List).cast<String>();
          final widths = (op['widths'] as List).cast<int>();
          final aligns = (op['aligns'] as List).cast<int>();
          final row = StringBuffer();
          for (var i = 0; i < cols.length; i++) {
            final cell = cols[i].length > widths[i]
                ? cols[i].substring(0, widths[i])
                : cols[i];
            row.write(aligns[i] == 2
                ? cell.padLeft(widths[i])
                : cell.padRight(widths[i]));
          }
          out.writeln(row.toString().trimRight());
          break;
        case 'qr':
          out.writeln(_centre('[ QR CODE ]'));
          break;
        case 'feed':
          out.write('\n' * ((op['lines'] as int?) ?? 1));
          break;
      }
    }
    return out.toString();
  }

  static String _centre(String value) {
    if (value.length >= width) return value;
    return ' ' * ((width - value.length) ~/ 2) + value;
  }
}
