import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../core/auth_service.dart';
import '../core/money.dart';
import '../core/printer_service.dart';
import '../core/receipt.dart';
import '../core/sync_service.dart';
import '../data/field_repository.dart';
import '../models/models.dart';

/// The receipt for one sale.
///
/// Two jobs, and the order of them is the whole design:
///
/// 1. If the company files with KRA, **wait for the control code before
///    printing.** A receipt printed without one is not a tax invoice, and a
///    customer who is handed one has to be found again later. So the screen
///    holds, visibly, with a countdown.
///
/// 2. If the wait runs out, do not block the counter. Print an interim receipt
///    that says what it is, and leave the sale in a queue the rep can push by
///    hand — or that the next sync pushes on its own.
///
/// A company that does not file skips all of it and prints immediately.
class ReceiptScreen extends StatefulWidget {
  const ReceiptScreen({
    super.key,
    required this.invoiceId,
    this.customerName,
    this.customerPin,
    this.autoPrint = false,
  });

  final String invoiceId;
  final String? customerName;
  final String? customerPin;

  /// Set when arriving straight from a completed sale, where the rep expects
  /// paper without pressing anything.
  final bool autoPrint;

  @override
  State<ReceiptScreen> createState() => _ReceiptScreenState();
}

class _ReceiptScreenState extends State<ReceiptScreen> {
  /// How long the counter waits for KRA before falling back to an interim
  /// receipt. Long enough for a healthy line, short enough that a queue does
  /// not build behind one customer.
  static const _etimsWait = Duration(seconds: 25);
  static const _pollEvery = Duration(seconds: 3);

  InvoiceSummary? _invoice;
  List<InvoiceLine> _lines = const [];
  bool _loading = true;
  bool _waiting = false;
  int _secondsLeft = 0;
  Timer? _ticker;
  String? _message;
  bool _printedOnce = false;

  @override
  void initState() {
    super.initState();
    unawaited(_start());
  }

  @override
  void dispose() {
    _ticker?.cancel();
    super.dispose();
  }

  Future<void> _start() async {
    await _load();
    if (!mounted) return;

    final session = context.read<AuthService>().session;
    final invoice = _invoice;
    if (invoice == null) return;

    // Nothing to wait for: either the company does not file, or this sale is
    // already filed.
    if (session?.etimsEnabled != true || invoice.isFiled) {
      if (widget.autoPrint) unawaited(_print());
      return;
    }

    await _awaitFiling();
  }

  Future<void> _load() async {
    final repo = context.read<FieldRepository>();
    final found = await repo.invoiceForPrinting(widget.invoiceId);
    if (!mounted) return;
    setState(() {
      _invoice = found?.$1;
      _lines = found?.$2 ?? const [];
      _loading = false;
    });
  }

  /// Polls until KRA answers or the wait runs out.
  ///
  /// Each round trip is a sync, not a bespoke endpoint: the control code
  /// arrives on the invoice mirror like everything else, so there is one path
  /// for the data and no second way for it to be stale.
  Future<void> _awaitFiling() async {
    setState(() {
      _waiting = true;
      _secondsLeft = _etimsWait.inSeconds;
    });

    _ticker = Timer.periodic(const Duration(seconds: 1), (t) {
      if (!mounted) return t.cancel();
      setState(() => _secondsLeft = (_secondsLeft - 1).clamp(0, 999));
    });

    final sync = context.read<SyncService>();
    final deadline = DateTime.now().add(_etimsWait);

    while (mounted && DateTime.now().isBefore(deadline)) {
      await Future<void>.delayed(_pollEvery);
      if (!mounted) return;

      try {
        await sync.sync(reason: 'awaiting-etims');
      } catch (_) {
        // No signal. Keep waiting — the deadline is the backstop, and a van
        // dipping in and out of coverage is the normal case, not a failure.
      }

      await _load();
      if (!mounted) return;

      if (_invoice?.isFiled ?? false) {
        _ticker?.cancel();
        setState(() => _waiting = false);
        if (widget.autoPrint) unawaited(_print());
        return;
      }

      if (_invoice?.etimsStatus == 'REJECTED') break;
    }

    _ticker?.cancel();
    if (!mounted) return;
    setState(() {
      _waiting = false;
      _message = _invoice?.etimsStatus == 'REJECTED'
          ? 'KRA rejected this sale. Print the receipt and tell the office.'
          : 'KRA has not answered yet. Print an interim receipt; the tax '
              'invoice can be reprinted once it lands.';
    });
    if (widget.autoPrint) unawaited(_print());
  }

  Future<void> _print() async {
    final printer = context.read<PrinterService>();
    final session = context.read<AuthService>().session;
    final invoice = _invoice;
    final company = session?.company;

    if (invoice == null || company == null) return;

    final receipt = Receipt(
      company: company,
      invoice: invoice,
      lines: _lines,
      customerName: widget.customerName,
      customerPin: widget.customerPin,
      servedBy: session?.name,
      copy: _printedOnce,
    );

    final error = await printer.print(receipt.build());
    if (!mounted) return;

    setState(() {
      _printedOnce = error == null || _printedOnce;
      _message = error;
    });

    if (error == null) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(receipt.isTaxInvoice ? 'Tax invoice printed' : 'Receipt printed')),
      );
    }
  }

  /// Pushes this one sale at KRA now, rather than waiting for the sweep.
  Future<void> _retryFiling() async {
    final sync = context.read<SyncService>();
    setState(() => _message = 'Sending to KRA...');

    try {
      await sync.pushEtims(widget.invoiceId);
    } catch (error) {
      if (!mounted) return;
      setState(() => _message = '$error');
      return;
    }

    await sync.sync(reason: 'etims-retry').catchError((_) => false);
    await _load();
    if (!mounted) return;

    setState(() {
      _message = (_invoice?.isFiled ?? false)
          ? null
          : 'Still not filed. It stays queued and will be retried.';
    });
  }

  @override
  Widget build(BuildContext context) {
    final printer = context.watch<PrinterService>();
    final session = context.watch<AuthService>().session;
    final invoice = _invoice;

    return Scaffold(
      appBar: AppBar(title: Text(invoice == null ? 'Receipt' : invoice.number)),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : invoice == null
              ? const _Missing()
              : ListView(
                  padding: const EdgeInsets.all(16),
                  children: [
                    _StatusCard(
                      invoice: invoice,
                      waiting: _waiting,
                      secondsLeft: _secondsLeft,
                      etimsOn: session?.etimsEnabled ?? false,
                    ),
                    if (_message != null) ...[
                      const SizedBox(height: 12),
                      Card(
                        color: Theme.of(context).colorScheme.surfaceContainerHighest,
                        child: Padding(
                          padding: const EdgeInsets.all(12),
                          child: Text(_message!),
                        ),
                      ),
                    ],
                    const SizedBox(height: 16),
                    _Preview(
                      receipt: Receipt(
                        company: session!.company!,
                        invoice: invoice,
                        lines: _lines,
                        customerName: widget.customerName,
                        customerPin: widget.customerPin,
                        servedBy: session.name,
                      ),
                    ),
                    const SizedBox(height: 16),
                    if (!printer.available && printer.checked)
                      const Card(
                        child: ListTile(
                          leading: Icon(Icons.print_disabled_outlined),
                          title: Text('No printer on this device'),
                          subtitle: Text(
                            'The receipt is shown above. Printing needs POS hardware.',
                          ),
                        ),
                      ),
                  ],
                ),
      bottomNavigationBar: invoice == null
          ? null
          : SafeArea(
              child: Padding(
                padding: const EdgeInsets.all(12),
                child: Row(
                  children: [
                    if (invoice.needsFiling && (session?.canRetryEtims ?? false))
                      Expanded(
                        child: OutlinedButton.icon(
                          onPressed: _waiting ? null : _retryFiling,
                          icon: const Icon(Icons.cloud_upload_outlined),
                          label: const Text('Send to KRA'),
                        ),
                      ),
                    if (invoice.needsFiling && (session?.canRetryEtims ?? false))
                      const SizedBox(width: 12),
                    Expanded(
                      child: FilledButton.icon(
                        onPressed: printer.available && !printer.printing && !_waiting
                            ? _print
                            : null,
                        icon: const Icon(Icons.print_outlined),
                        label: Text(
                          _printedOnce ? 'Print again' : 'Print receipt',
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ),
    );
  }
}

class _StatusCard extends StatelessWidget {
  const _StatusCard({
    required this.invoice,
    required this.waiting,
    required this.secondsLeft,
    required this.etimsOn,
  });

  final InvoiceSummary invoice;
  final bool waiting;
  final int secondsLeft;
  final bool etimsOn;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;

    if (waiting) {
      return Card(
        color: scheme.secondaryContainer,
        child: ListTile(
          leading: const SizedBox(
            width: 24,
            height: 24,
            child: CircularProgressIndicator(strokeWidth: 2.5),
          ),
          title: const Text('Filing with KRA'),
          subtitle: Text('Holding for the control code — ${secondsLeft}s'),
        ),
      );
    }

    if (!etimsOn) {
      return Card(
        child: ListTile(
          leading: const Icon(Icons.receipt_long_outlined),
          title: Text(Money.format(invoice.totalCents)),
          subtitle: const Text('Sales receipt'),
        ),
      );
    }

    if (invoice.isFiled) {
      return Card(
        color: scheme.primaryContainer,
        child: ListTile(
          leading: const Icon(Icons.verified_outlined),
          title: const Text('Filed with KRA'),
          subtitle: Text('Control code ${invoice.etimsControlCode}'),
        ),
      );
    }

    return Card(
      color: scheme.errorContainer,
      child: ListTile(
        leading: const Icon(Icons.pending_outlined),
        title: Text(
          invoice.etimsStatus == 'REJECTED' ? 'Rejected by KRA' : 'Not yet filed',
        ),
        subtitle: const Text('Anything printed now is an interim receipt.'),
      ),
    );
  }
}

/// The receipt as it will come off the roll.
///
/// Monospaced and 32 columns wide, matching the paper. A preview that reflows
/// to the screen looks fine and tells you nothing about whether a column will
/// overrun in the shop.
class _Preview extends StatelessWidget {
  const _Preview({required this.receipt});

  final Receipt receipt;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          child: Text(
            receipt.asText(),
            style: const TextStyle(fontFamily: 'monospace', fontSize: 12, height: 1.35),
          ),
        ),
      ),
    );
  }
}

class _Missing extends StatelessWidget {
  const _Missing();

  @override
  Widget build(BuildContext context) => const Center(
        child: Padding(
          padding: EdgeInsets.all(24),
          child: Text(
            'This invoice has not reached the handset yet. Sync and try again.',
            textAlign: TextAlign.center,
          ),
        ),
      );
}
