import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../core/auth_service.dart';
import '../core/money.dart';
import '../core/sync_service.dart';
import '../data/field_repository.dart';
import '../models/models.dart';
import 'receipt_screen.dart';
import 'return_receipt_screen.dart';

/// Sales this handset knows about that KRA has not accepted.
///
/// Built from the rep's own mirrored invoices, not the company transmission
/// log. A rep needs to push a filing that got stuck at their counter; they have
/// no business reading every sale the company has made, and the server refuses
/// them that endpoint anyway.
///
/// Both paths are offered on purpose. "Send all" is what a rep does when the
/// signal comes back at the end of a round; pushing one is what they do when a
/// customer is standing there waiting for a proper tax invoice.
class EtimsQueueScreen extends StatefulWidget {
  const EtimsQueueScreen({super.key});

  @override
  State<EtimsQueueScreen> createState() => _EtimsQueueScreenState();
}

class _EtimsQueueScreenState extends State<EtimsQueueScreen> {
  List<InvoiceSummary> _pending = const [];
  List<CreditNoteSummary> _pendingReturns = const [];

  int get _total => _pending.length + _pendingReturns.length;
  bool _loading = true;
  bool _pushing = false;
  String? _message;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  Future<void> _load() async {
    final repo = context.read<FieldRepository>();
    final rows = await repo.invoicesAwaitingEtims();
    // Returns belong in the same queue. A credit note KRA never accepted is
    // the more urgent of the two: the customer has their goods back and their
    // money credited, and the revenue authority still shows the sale.
    final returns = await repo.returnsAwaitingEtims();
    if (!mounted) return;
    setState(() {
      _pending = rows;
      _pendingReturns = returns;
      _loading = false;
    });
  }

  Future<void> _pushAll() async {
    final sync = context.read<SyncService>();
    setState(() {
      _pushing = true;
      _message = null;
    });

    var sent = 0;
    var failed = 0;
    for (final inv in _pending) {
      try {
        await sync.pushEtims(inv.id);
        sent++;
      } catch (_) {
        // One rejection must not stop the rest. A single invoice KRA will
        // never accept would otherwise block every other filing behind it.
        failed++;
      }
    }

    // Returns after sales, on purpose: a credit note references the KRA sale id
    // of its invoice, so filing the invoice first is what lets the return go
    // through on the same sweep instead of waiting for the next one.
    for (final note in _pendingReturns) {
      try {
        await sync.pushReturn(note.id);
        sent++;
      } catch (_) {
        failed++;
      }
    }

    await sync.sync(reason: 'etims-queue').catchError((_) => false);
    await _load();
    if (!mounted) return;

    setState(() {
      _pushing = false;
      _message = failed == 0
          ? 'Sent $sent to KRA.'
          : 'Sent $sent, $failed still outstanding.';
    });
  }

  @override
  Widget build(BuildContext context) {
    final session = context.watch<AuthService>().session;

    return Scaffold(
      appBar: AppBar(title: const Text('Awaiting KRA')),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _total == 0
              ? const _AllClear()
              : RefreshIndicator(
                  onRefresh: _load,
                  child: ListView(
                    children: [
                      if (_message != null)
                        Padding(
                          padding: const EdgeInsets.all(16),
                          child: Text(_message!),
                        ),
                      Padding(
                        padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
                        child: Text(
                          'These are complete and the customer has been served. '
                          'Until KRA accepts them, the paper they were given is '
                          'a receipt, not a tax invoice or a credit note.',
                          style: TextStyle(
                            fontSize: 12.5,
                            color: Theme.of(context).colorScheme.onSurfaceVariant,
                          ),
                        ),
                      ),
                      const SizedBox(height: 8),
                      ..._pendingReturns.map(
                        (n) => ListTile(
                          leading: Icon(
                            n.etimsStatus == 'REJECTED'
                                ? Icons.error_outline
                                : Icons.assignment_return_outlined,
                            color: n.etimsStatus == 'REJECTED'
                                ? Theme.of(context).colorScheme.error
                                : null,
                          ),
                          title: Text('${n.number} · return'),
                          subtitle: Text(
                            n.etimsStatus == 'REJECTED'
                                ? 'Rejected by KRA'
                                : 'Waiting for a control code',
                          ),
                          trailing: Text(
                            Money.format(n.totalCents),
                            style: const TextStyle(fontWeight: FontWeight.w600),
                          ),
                          onTap: () => Navigator.of(context).push(
                            MaterialPageRoute<void>(
                              builder: (_) => ReturnReceiptScreen(creditNoteId: n.id),
                            ),
                          ),
                        ),
                      ),
                      ..._pending.map(
                        (inv) => ListTile(
                          leading: Icon(
                            inv.etimsStatus == 'REJECTED'
                                ? Icons.error_outline
                                : Icons.schedule_outlined,
                            color: inv.etimsStatus == 'REJECTED'
                                ? Theme.of(context).colorScheme.error
                                : null,
                          ),
                          title: Text(inv.number),
                          subtitle: Text(
                            inv.etimsStatus == 'REJECTED'
                                ? 'Rejected by KRA'
                                : 'Waiting for a control code',
                          ),
                          trailing: Text(
                            Money.format(inv.totalCents),
                            style: const TextStyle(fontWeight: FontWeight.w600),
                          ),
                          onTap: () => Navigator.of(context).push(
                            MaterialPageRoute<void>(
                              builder: (_) => ReceiptScreen(invoiceId: inv.id),
                            ),
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
      bottomNavigationBar: _total == 0 || !(session?.canRetryEtims ?? false)
          ? null
          : SafeArea(
              child: Padding(
                padding: const EdgeInsets.all(12),
                child: FilledButton.icon(
                  onPressed: _pushing ? null : _pushAll,
                  icon: _pushing
                      ? const SizedBox(
                          width: 18,
                          height: 18,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Icon(Icons.cloud_upload_outlined),
                  label: Text(
                    _pushing ? 'Sending...' : 'Send all $_total to KRA',
                  ),
                ),
              ),
            ),
    );
  }
}

class _AllClear extends StatelessWidget {
  const _AllClear();

  @override
  Widget build(BuildContext context) => const Center(
        child: Padding(
          padding: EdgeInsets.all(32),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(Icons.verified_outlined, size: 44),
              SizedBox(height: 12),
              Text(
                'Everything on this handset has been filed with KRA.',
                textAlign: TextAlign.center,
              ),
            ],
          ),
        ),
      );
}
