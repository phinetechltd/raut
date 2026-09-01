import 'money.dart';
import 'printer_service.dart';
import '../models/models.dart';

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
class Receipt {
  const Receipt({
    required this.company,
    required this.invoice,
    required this.lines,
    this.customerName,
    this.customerPin,
    this.servedBy,
    this.copy = false,
  });

  final CompanyInfo company;
  final InvoiceSummary invoice;
  final List<InvoiceLine> lines;
  final String? customerName;
  final String? customerPin;
  final String? servedBy;

  /// A reprint. Marked, because two identical papers for one sale is how a
  /// customer ends up believing they were charged twice.
  final bool copy;

  bool get isTaxInvoice =>
      invoice.etimsStatus == 'ACCEPTED' &&
      (invoice.etimsControlCode?.isNotEmpty ?? false);

  /// 58mm paper at the default font is 32 characters. Everything below is laid
  /// out against that, because a column that overruns wraps and destroys the
  /// alignment of every row after it.
  static const int width = 32;

  String get heading => isTaxInvoice ? 'TAX INVOICE' : 'SALES RECEIPT';

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

    ops.add(Op.columns(['No.', invoice.number], const [10, 22],
        aligns: const [0, 2]));
    ops.add(Op.columns(['Date', _stamp(invoice.issueDate)], const [10, 22],
        aligns: const [0, 2]));
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

    for (final l in lines) {
      // Description on its own line: product names run past 32 characters far
      // more often than they fit, and truncating them to keep a single row
      // makes the receipt useless for identifying what was bought.
      ops.add(Op.text(l.description, size: 22));
      ops.add(Op.columns(
        [
          '${l.quantity} x ${Money.format(l.unitPriceCents, decimals: true)}',
          Money.format(l.lineTotalCents, decimals: true),
        ],
        const [18, 14],
        aligns: const [0, 2],
      ));
    }

    ops.add(Op.text(_rule(), size: 20));

    ops.add(_amount('Subtotal', invoice.subtotalCents));
    if (invoice.discountCents > 0) {
      ops.add(_amount('Discount', -invoice.discountCents));
    }
    ops.add(_amount('VAT', invoice.taxCents));
    ops.add(Op.columns(
      ['TOTAL', Money.format(invoice.totalCents, decimals: true)],
      const [16, 16],
      aligns: const [0, 2],
    ));
    if (invoice.paidCents > 0) {
      ops.add(_amount('Paid', invoice.paidCents));
      ops.add(_amount('Balance', invoice.outstandingCents));
    }

    ops.add(Op.text(_rule(), size: 20));

    if (isTaxInvoice) {
      ops.add(Op.text('CONTROL CODE', align: 'center', size: 20));
      ops.add(Op.text(invoice.etimsControlCode!,
          align: 'center', size: 26, bold: true));
      if (invoice.etimsInvoiceNumber != null) {
        ops.add(Op.text('KRA Invoice No: ${invoice.etimsInvoiceNumber}',
            align: 'center', size: 20));
      }
      if (invoice.etimsSerialNumber != null) {
        ops.add(Op.text(invoice.etimsSerialNumber!, align: 'center', size: 18));
      }
      if (invoice.etimsQrUrl != null && invoice.etimsQrUrl!.isNotEmpty) {
        ops.add(Op.feed());
        ops.add(Op.qr(invoice.etimsQrUrl!));
      }
      ops.add(Op.feed());
      ops.add(Op.text('Scan to verify with KRA', align: 'center', size: 18));
    } else {
      // Said plainly rather than hidden. The customer needs to know this is
      // not yet the document they can claim VAT against, and the rep needs to
      // know a reprint is owed.
      ops.add(Op.text('NOT A TAX INVOICE', align: 'center', size: 24, bold: true));
      ops.add(Op.text(
        invoice.etimsStatus == 'REJECTED'
            ? 'KRA rejected this sale. Ask the office.'
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
