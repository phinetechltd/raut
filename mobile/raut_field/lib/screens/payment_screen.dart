import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';

import '../core/money.dart';
import '../data/field_repository.dart';
import '../models/models.dart';
import '../theme.dart';

/// Offline payment collection.
///
/// The rep is holding the customer's cash when they use this screen, so it must
/// never refuse to record. Validation is about catching typos — an amount far
/// above the balance is queried, not blocked, because overpayments and
/// prepayments are both real.
class PaymentScreen extends StatefulWidget {
  const PaymentScreen({super.key, required this.customer, this.visitId});

  final Customer customer;
  final String? visitId;

  @override
  State<PaymentScreen> createState() => _PaymentScreenState();
}

class _PaymentScreenState extends State<PaymentScreen> {
  final _amount = TextEditingController();
  final _reference = TextEditingController();
  String _method = 'CASH';
  List<InvoiceSummary> _invoices = const [];
  bool _saving = false;

  static const _methods = {
    'CASH': 'Cash',
    'MPESA': 'M-Pesa',
    'BANK': 'Bank transfer',
    'CHEQUE': 'Cheque',
  };

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _amount.dispose();
    _reference.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    final invoices =
        await context.read<FieldRepository>().openInvoices(widget.customer.id);
    if (mounted) setState(() => _invoices = invoices);
  }

  int get _amountCents {
    final parsed = double.tryParse(_amount.text.replaceAll(',', '').trim());
    return parsed == null ? 0 : Money.toCents(parsed);
  }

  Future<void> _save() async {
    final cents = _amountCents;
    if (cents <= 0) return;

    // Resolved before the confirmation dialog's await.
    final repo = context.read<FieldRepository>();

    if (cents > widget.customer.balanceCents && widget.customer.balanceCents > 0) {
      final proceed = await showDialog<bool>(
        context: context,
        builder: (context) => AlertDialog(
          title: const Text('More than the balance'),
          content: Text(
            'You are recording ${Money.format(cents)} against a balance of '
            '${Money.format(widget.customer.balanceCents)}.\n\n'
            'The extra will sit as a credit on the account. Is the amount correct?',
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: const Text('Check again'),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(context, true),
              child: const Text('Yes, record it'),
            ),
          ],
        ),
      );
      if (proceed != true || !mounted) return;
    }

    setState(() => _saving = true);
    try {
      await repo.recordPayment(
        customerId: widget.customer.id,
        amountCents: cents,
        method: _method,
        reference: _reference.text.trim().isEmpty ? null : _reference.text.trim(),
        visitId: widget.visitId,
      );

      if (!mounted) return;
      Navigator.pop(context);
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text('${Money.format(cents)} recorded — it will sync automatically.'),
          behavior: SnackBarBehavior.floating,
        ),
      );
    } catch (error) {
      if (mounted) {
        setState(() => _saving = false);
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('$error'), backgroundColor: RautTheme.danger),
        );
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final remaining = widget.customer.balanceCents - _amountCents;

    return Scaffold(
      appBar: AppBar(title: const Text('Record payment')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Card(
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    widget.customer.name,
                    style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w700),
                  ),
                  const SizedBox(height: 8),
                  Row(
                    children: [
                      Text(
                        'Current balance',
                        style: TextStyle(color: Colors.grey.shade600, fontSize: 13),
                      ),
                      const Spacer(),
                      Text(
                        Money.format(widget.customer.balanceCents),
                        style: const TextStyle(
                          fontWeight: FontWeight.w700,
                          fontSize: 16,
                        ),
                      ),
                    ],
                  ),
                  if (_amountCents > 0) ...[
                    const Divider(height: 20),
                    Row(
                      children: [
                        Text(
                          'After this payment',
                          style: TextStyle(color: Colors.grey.shade600, fontSize: 13),
                        ),
                        const Spacer(),
                        Text(
                          Money.format(remaining),
                          style: TextStyle(
                            fontWeight: FontWeight.w700,
                            fontSize: 16,
                            color: remaining <= 0
                                ? RautTheme.success
                                : RautTheme.warning,
                          ),
                        ),
                      ],
                    ),
                  ],
                ],
              ),
            ),
          ),

          const SizedBox(height: 16),
          TextField(
            controller: _amount,
            keyboardType: const TextInputType.numberWithOptions(decimal: true),
            autofocus: true,
            style: const TextStyle(fontSize: 24, fontWeight: FontWeight.w700),
            onChanged: (_) => setState(() {}),
            decoration: const InputDecoration(
              labelText: 'Amount received',
              prefixText: 'KES  ',
              prefixStyle: TextStyle(fontSize: 18, fontWeight: FontWeight.w600),
            ),
          ),

          if (widget.customer.balanceCents > 0) ...[
            const SizedBox(height: 10),
            Align(
              alignment: Alignment.centerLeft,
              child: OutlinedButton(
                style: OutlinedButton.styleFrom(
                  minimumSize: const Size(0, 38),
                  padding: const EdgeInsets.symmetric(horizontal: 14),
                ),
                onPressed: () {
                  _amount.text =
                      (widget.customer.balanceCents / 100).toStringAsFixed(0);
                  setState(() {});
                },
                child: Text('Pay full balance · ${Money.format(widget.customer.balanceCents)}'),
              ),
            ),
          ],

          const SizedBox(height: 20),
          Text(
            'Payment method',
            style: TextStyle(
              fontSize: 12,
              fontWeight: FontWeight.w600,
              color: Colors.grey.shade600,
            ),
          ),
          const SizedBox(height: 8),
          Wrap(
            spacing: 8,
            children: _methods.entries
                .map(
                  (e) => ChoiceChip(
                    label: Text(e.value),
                    selected: _method == e.key,
                    onSelected: (_) => setState(() => _method = e.key),
                  ),
                )
                .toList(),
          ),

          const SizedBox(height: 16),
          TextField(
            controller: _reference,
            decoration: InputDecoration(
              labelText: _method == 'MPESA'
                  ? 'M-Pesa code'
                  : _method == 'CHEQUE'
                      ? 'Cheque number'
                      : 'Reference (optional)',
              prefixIcon: const Icon(Icons.tag),
            ),
          ),

          if (_invoices.isNotEmpty) ...[
            const SizedBox(height: 24),
            Text(
              'This payment will be applied to the oldest invoices first',
              style: TextStyle(fontSize: 12, color: Colors.grey.shade600),
            ),
            const SizedBox(height: 8),
            Card(
              child: Column(
                children: _invoices
                    .map(
                      (inv) => ListTile(
                        dense: true,
                        title: Text(
                          inv.number,
                          style: const TextStyle(
                            fontSize: 13,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                        subtitle: inv.dueDate == null
                            ? null
                            : Text(
                                'Due ${DateFormat('d MMM yyyy').format(inv.dueDate!)}',
                                style: TextStyle(
                                  fontSize: 11.5,
                                  color: inv.isOverdue
                                      ? RautTheme.danger
                                      : Colors.grey.shade600,
                                ),
                              ),
                        trailing: Text(
                          Money.format(inv.outstandingCents),
                          style: const TextStyle(fontWeight: FontWeight.w700),
                        ),
                      ),
                    )
                    .toList(),
              ),
            ),
          ],
        ],
      ),

      bottomNavigationBar: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: FilledButton.icon(
            onPressed: _amountCents <= 0 || _saving ? null : _save,
            icon: _saving
                ? const SizedBox(
                    height: 18,
                    width: 18,
                    child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
                  )
                : const Icon(Icons.check),
            label: Text(
              _amountCents <= 0
                  ? 'Enter an amount'
                  : 'Record ${Money.format(_amountCents)}',
            ),
          ),
        ),
      ),
    );
  }
}

