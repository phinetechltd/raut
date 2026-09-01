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

/// The credit note for a return.
///
/// Same shape as the sale receipt and for the same reason: if the company files
/// with KRA, the customer should walk away holding a credit note with a control
/// code on it, not a promise of one. So this holds for the code, then falls back
/// to an interim return note rather than keeping the shop waiting.
///
/// A return is its own KRA document. The original invoice is untouched — it was
/// filed, KRA has it, and rewriting it is neither possible nor honest.
class ReturnReceiptScreen extends StatefulWidget {
  const ReturnReceiptScreen({
    super.key,
    required this.creditNoteId,
    this.invoiceNumber,
    this.customerName,
    this.customerPin,
  });

  final String creditNoteId;

  /// The sale being credited. Resolved from the mirror when a caller does not
  /// have it — passing an empty string would print "Against" with nothing after
  /// it, which is worse than not printing the line at all.
  final String? invoiceNumber;
  final String? customerName;
  final String? customerPin;

  @override
  State<ReturnReceiptScreen> createState() => _ReturnReceiptScreenState();
}

class _ReturnReceiptScreenState extends State<ReturnReceiptScreen> {
  static const _etimsWait = Duration(seconds: 25);
  static const _pollEvery = Duration(seconds: 3);

  CreditNoteSummary? _note;
  List<ReceiptLine> _lines = const [];
  bool _loading = true;
  bool _waiting = false;
  int _secondsLeft = 0;
  Timer? _ticker;
  String? _message;
  bool _printedOnce = false;
  String _against = '';

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
    if (_note == null) return;

    if (session?.etimsEnabled != true || (_note?.isFiled ?? false)) {
      return;
    }
    await _awaitFiling();
  }

  Future<void> _load() async {
    final repo = context.read<FieldRepository>();
    final found = await repo.creditNoteForPrinting(widget.creditNoteId);
    final against = widget.invoiceNumber?.isNotEmpty == true
        ? widget.invoiceNumber!
        : (found == null ? '' : await repo.invoiceNumberFor(found.$1.invoiceId) ?? '');
    if (!mounted) return;
    setState(() {
      _note = found?.$1;
      _lines = (found?.$2 ?? const []).map(ReceiptLine.fromRow).toList();
      _against = against;
      _loading = false;
    });
  }

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
        await sync.sync(reason: 'awaiting-credit-note');
      } catch (_) {
        // No signal. The deadline is the backstop.
      }

      await _load();
      if (!mounted) return;

      if (_note?.isFiled ?? false) {
        _ticker?.cancel();
        setState(() => _waiting = false);
        return;
      }
      if (_note?.etimsStatus == 'REJECTED') break;
    }

    _ticker?.cancel();
    if (!mounted) return;
    setState(() {
      _waiting = false;
      _message = _note?.etimsStatus == 'REJECTED'
          ? 'KRA rejected this return. Print it and tell the office.'
          : 'KRA has not answered yet. Print an interim note; the credit note '
              'can be reprinted once it lands.';
    });
  }

  Future<void> _print() async {
    final printer = context.read<PrinterService>();
    final session = context.read<AuthService>().session;
    final note = _note;
    final company = session?.company;
    if (note == null || company == null) return;

    final receipt = Receipt.forReturn(
      company: company,
      note: note,
      lines: _lines,
      invoiceNumber: _against,
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
        SnackBar(
          content: Text(receipt.isTaxInvoice ? 'Credit note printed' : 'Return note printed'),
        ),
      );
    }
  }

  Future<void> _retryFiling() async {
    final sync = context.read<SyncService>();
    setState(() => _message = 'Sending to KRA...');

    try {
      await sync.pushReturn(widget.creditNoteId);
    } catch (error) {
      if (!mounted) return;
      setState(() => _message = '$error');
      return;
    }

    await sync.sync(reason: 'credit-note-retry').catchError((_) => false);
    await _load();
    if (!mounted) return;

    setState(() {
      _message = (_note?.isFiled ?? false)
          ? null
          : 'Still not filed. It stays queued and will be retried.';
    });
  }

  @override
  Widget build(BuildContext context) {
    final printer = context.watch<PrinterService>();
    final session = context.watch<AuthService>().session;
    final note = _note;
    final scheme = Theme.of(context).colorScheme;

    return Scaffold(
      appBar: AppBar(title: Text(note?.number ?? 'Return')),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : note == null
              ? const Center(
                  child: Padding(
                    padding: EdgeInsets.all(24),
                    child: Text(
                      'This return has not reached the handset yet. Sync and try again.',
                      textAlign: TextAlign.center,
                    ),
                  ),
                )
              : ListView(
                  padding: const EdgeInsets.all(16),
                  children: [
                    if (_waiting)
                      Card(
                        color: scheme.secondaryContainer,
                        child: ListTile(
                          leading: const SizedBox(
                            width: 24,
                            height: 24,
                            child: CircularProgressIndicator(strokeWidth: 2.5),
                          ),
                          title: const Text('Filing the return with KRA'),
                          subtitle: Text('Holding for the control code — ${_secondsLeft}s'),
                        ),
                      )
                    else
                      Card(
                        color: note.isFiled
                            ? scheme.primaryContainer
                            : (session?.etimsEnabled ?? false)
                                ? scheme.errorContainer
                                : null,
                        child: ListTile(
                          leading: Icon(
                            note.isFiled
                                ? Icons.verified_outlined
                                : Icons.assignment_return_outlined,
                          ),
                          title: Text(
                            note.isFiled
                                ? 'Credited and filed with KRA'
                                : 'Credited ${Money.format(note.totalCents)}',
                          ),
                          subtitle: Text(
                            note.isFiled
                                ? 'Control code ${note.etimsControlCode}'
                                : 'Against $_against',
                          ),
                        ),
                      ),
                    if (_message != null) ...[
                      const SizedBox(height: 12),
                      Card(
                        color: scheme.surfaceContainerHighest,
                        child: Padding(
                          padding: const EdgeInsets.all(12),
                          child: Text(_message!),
                        ),
                      ),
                    ],
                    const SizedBox(height: 16),
                    Card(
                      child: Padding(
                        padding: const EdgeInsets.all(12),
                        child: SingleChildScrollView(
                          scrollDirection: Axis.horizontal,
                          child: Text(
                            Receipt.forReturn(
                              company: session!.company!,
                              note: note,
                              lines: _lines,
                              invoiceNumber: _against,
                              customerName: widget.customerName,
                              customerPin: widget.customerPin,
                              servedBy: session.name,
                            ).asText(),
                            style: const TextStyle(
                              fontFamily: 'monospace',
                              fontSize: 12,
                              height: 1.35,
                            ),
                          ),
                        ),
                      ),
                    ),
                    const SizedBox(height: 16),
                    if (!note.restock)
                      const Card(
                        child: ListTile(
                          leading: Icon(Icons.report_gmailerrorred_outlined),
                          title: Text('Not restocked'),
                          subtitle: Text(
                            'Credited to the customer but written off, so it is '
                            'not back on your van.',
                          ),
                        ),
                      ),
                    if (!printer.available && printer.checked)
                      const Card(
                        child: ListTile(
                          leading: Icon(Icons.print_disabled_outlined),
                          title: Text('No printer on this device'),
                          subtitle: Text(
                            'The note is shown above. Printing needs POS hardware.',
                          ),
                        ),
                      ),
                  ],
                ),
      bottomNavigationBar: note == null
          ? null
          : SafeArea(
              child: Padding(
                padding: const EdgeInsets.all(12),
                child: Row(
                  children: [
                    if (note.needsFiling && (session?.canRetryEtims ?? false)) ...[
                      Expanded(
                        child: OutlinedButton.icon(
                          onPressed: _waiting ? null : _retryFiling,
                          icon: const Icon(Icons.cloud_upload_outlined),
                          label: const Text('Send to KRA'),
                        ),
                      ),
                      const SizedBox(width: 12),
                    ],
                    Expanded(
                      child: FilledButton.icon(
                        onPressed: printer.available && !printer.printing && !_waiting
                            ? _print
                            : null,
                        icon: const Icon(Icons.print_outlined),
                        label: Text(_printedOnce ? 'Print again' : 'Print note'),
                      ),
                    ),
                  ],
                ),
              ),
            ),
    );
  }
}
