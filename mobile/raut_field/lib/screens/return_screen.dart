import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:uuid/uuid.dart';

import '../core/money.dart';
import '../core/sync_service.dart';
import '../data/field_repository.dart';
import '../models/models.dart';
import '../theme.dart';
import 'return_receipt_screen.dart';

/// Taking a sales return in the field.
///
/// The rep standing in the shop is who the goods are handed back to, so this is
/// where a return has to be possible. It raises a credit note against the
/// original invoice, which is the only correct way to reverse a filed sale:
/// the invoice stays exactly as issued, KRA keeps its copy, and the reversal is
/// its own document with its own control code.
///
/// Quantities start at zero rather than the full line. A return is usually
/// partial, and pre-filling the whole quantity makes over-crediting the path of
/// least resistance.
class ReturnScreen extends StatefulWidget {
  const ReturnScreen({
    super.key,
    required this.invoice,
    required this.lines,
    this.customerName,
  });

  final InvoiceSummary invoice;
  final List<InvoiceLine> lines;
  final String? customerName;

  @override
  State<ReturnScreen> createState() => _ReturnScreenState();
}

class _ReturnScreenState extends State<ReturnScreen> {
  static const _uuid = Uuid();

  final _reason = TextEditingController();
  final Map<String, int> _qty = {};

  /// How much of each line earlier returns already took.
  Map<String, int> _credited = const {};
  bool _restock = true;
  bool _loading = true;
  bool _saving = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  @override
  void dispose() {
    _reason.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    final credited =
        await context.read<FieldRepository>().creditedQuantities(widget.invoice.id);
    if (!mounted) return;
    setState(() {
      _credited = credited;
      _loading = false;
    });
  }

  int _remaining(InvoiceLine l) => l.quantity - (_credited[l.id] ?? 0);

  int get _creditCents {
    var total = 0;
    for (final l in widget.lines) {
      final n = _qty[l.id] ?? 0;
      if (n <= 0 || l.quantity == 0) continue;
      // Credit at the price actually charged, apportioned by line — the same
      // arithmetic the server does, so the figure a rep quotes in the shop is
      // the figure that lands.
      total += (l.lineTotalCents / l.quantity).round() * n;
    }
    return total;
  }

  bool get _canSubmit =>
      !_saving && _creditCents > 0 && _reason.text.trim().isNotEmpty;

  Future<void> _submit() async {
    final sync = context.read<SyncService>();
    final chosen = widget.lines
        .where((l) => (_qty[l.id] ?? 0) > 0)
        .map((l) => {'invoiceLineId': l.id, 'quantity': _qty[l.id]})
        .toList();

    setState(() {
      _saving = true;
      _error = null;
    });

    try {
      final res = await sync.raiseReturn(
        invoiceId: widget.invoice.id,
        reason: _reason.text.trim(),
        restock: _restock,
        lines: chosen,
        clientUuid: _uuid.v4(),
      );

      // Pull it down so the printed credit note comes from the mirror like
      // every other document, rather than from this one response.
      await sync.sync(reason: 'return').catchError((_) => false);

      final noteId = (res['creditNote'] as Map<String, dynamic>?)?['id'] as String?;
      if (!mounted) return;

      if (noteId == null) {
        setState(() {
          _saving = false;
          _error = 'The return was recorded but its number did not come back.';
        });
        return;
      }

      await Navigator.of(context).pushReplacement(
        MaterialPageRoute<void>(
          builder: (_) => ReturnReceiptScreen(
            creditNoteId: noteId,
            invoiceNumber: widget.invoice.number,
            customerName: widget.customerName,
          ),
        ),
      );
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _saving = false;
        // The server refuses an over-credit, and its reason is more useful than
        // anything this screen could invent.
        _error = '$error';
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final creditable = widget.lines.where((l) => _remaining(l) > 0).toList();

    return Scaffold(
      appBar: AppBar(title: Text('Return · ${widget.invoice.number}')),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : ListView(
              padding: const EdgeInsets.all(16),
              children: [
                if (!widget.invoice.isFiled)
                  Card(
                    color: RautTheme.warningBg,
                    child: const Padding(
                      padding: EdgeInsets.all(12),
                      child: Text(
                        'This invoice has not been accepted by KRA yet. The '
                        'return will be recorded and filed once it is.',
                        style: TextStyle(fontSize: 13),
                      ),
                    ),
                  ),
                if (creditable.isEmpty)
                  const Padding(
                    padding: EdgeInsets.symmetric(vertical: 40),
                    child: Text(
                      'Everything on this invoice has already been credited.',
                      textAlign: TextAlign.center,
                    ),
                  ),
                ...creditable.map(
                  (l) => Card(
                    child: Padding(
                      padding: const EdgeInsets.all(12),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            l.variantName == null
                                ? l.description
                                : '${l.description} · ${l.variantName}',
                            style: const TextStyle(fontWeight: FontWeight.w600),
                          ),
                          const SizedBox(height: 2),
                          Text(
                            '${_remaining(l)} of ${l.quantity} can be returned'
                            '${(_credited[l.id] ?? 0) > 0 ? ' · ${_credited[l.id]} already credited' : ''}',
                            style: TextStyle(fontSize: 12, color: Colors.grey.shade600),
                          ),
                          const SizedBox(height: 8),
                          Row(
                            children: [
                              Text(
                                Money.format(
                                  (l.lineTotalCents / l.quantity).round(),
                                  decimals: true,
                                ),
                                style: const TextStyle(fontSize: 13),
                              ),
                              const Spacer(),
                              IconButton(
                                onPressed: (_qty[l.id] ?? 0) > 0
                                    ? () => setState(
                                        () => _qty[l.id] = (_qty[l.id] ?? 0) - 1)
                                    : null,
                                icon: const Icon(Icons.remove_circle_outline),
                              ),
                              SizedBox(
                                width: 32,
                                child: Text(
                                  '${_qty[l.id] ?? 0}',
                                  textAlign: TextAlign.center,
                                  style: const TextStyle(
                                      fontWeight: FontWeight.w700, fontSize: 16),
                                ),
                              ),
                              IconButton(
                                // Capped at what is left, so the shop cannot be
                                // promised a credit the server will refuse.
                                onPressed: (_qty[l.id] ?? 0) < _remaining(l)
                                    ? () => setState(
                                        () => _qty[l.id] = (_qty[l.id] ?? 0) + 1)
                                    : null,
                                icon: const Icon(Icons.add_circle_outline),
                              ),
                            ],
                          ),
                        ],
                      ),
                    ),
                  ),
                ),
                if (creditable.isNotEmpty) ...[
                  const SizedBox(height: 8),
                  TextField(
                    controller: _reason,
                    decoration: const InputDecoration(
                      labelText: 'Reason for the return',
                      hintText: 'Damaged in transit, wrong item delivered...',
                    ),
                    maxLines: 2,
                    onChanged: (_) => setState(() {}),
                  ),
                  const SizedBox(height: 8),
                  SwitchListTile(
                    contentPadding: EdgeInsets.zero,
                    value: _restock,
                    onChanged: (v) => setState(() => _restock = v),
                    title: const Text('Goods came back in sellable condition'),
                    // Damaged stock is credited but not put back on the shelf,
                    // and assuming otherwise silently inflates the van count.
                    subtitle: Text(
                      _restock
                          ? 'They go back into your stock'
                          : 'Credited, but written off rather than restocked',
                      style: const TextStyle(fontSize: 12),
                    ),
                  ),
                ],
                if (_error != null) ...[
                  const SizedBox(height: 8),
                  Text(_error!, style: const TextStyle(color: RautTheme.danger)),
                ],
              ],
            ),
      bottomNavigationBar: creditable.isEmpty
          ? null
          : SafeArea(
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: FilledButton.icon(
                  onPressed: _canSubmit ? _submit : null,
                  icon: _saving
                      ? const SizedBox(
                          width: 18,
                          height: 18,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Icon(Icons.assignment_return_outlined),
                  label: Text(
                    _saving
                        ? 'Recording...'
                        : _creditCents > 0
                            ? 'Credit ${Money.format(_creditCents)}'
                            : 'Choose what came back',
                  ),
                ),
              ),
            ),
    );
  }
}
