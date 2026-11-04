import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';
import 'package:url_launcher/url_launcher.dart';

import '../core/money.dart';
import '../core/payments_service.dart';
import '../core/sync_service.dart';
import '../data/field_repository.dart';
import '../models/models.dart';
import '../theme.dart';
import 'receipt_screen.dart';

/// Payment collection, offline and through a gateway.
///
/// Two paths that must not be confused:
///
/// **Recorded** — cash, bank, cheque, or an M-Pesa code the customer already
/// paid. The rep is holding the money, so this must never refuse to record.
/// It works with no signal and queues like every other write.
///
/// **Collected** — an STK push or card charge the platform initiates. This
/// needs a live connection by its nature: it is a conversation with the gateway
/// while the customer holds their phone, and there is nothing meaningful to
/// queue. On success the *server* books the payment, so this screen must not
/// also enqueue one — it syncs instead, or the customer is credited twice.
///
/// A collection the rep stopped watching is not forgotten: the intent is kept
/// on the handset and re-checked the next time this screen opens, and a retry
/// within two minutes reuses the same request rather than pushing a second
/// prompt at the customer.
///
/// Validation is about catching typos: an amount far above the balance is
/// queried, not blocked, because overpayments and prepayments are both real.
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
  final _payer = TextEditingController();
  String _method = 'CASH';
  List<InvoiceSummary> _invoices = const [];
  bool _saving = false;

  /// Collections this handset started for this customer and has not seen end.
  List<OpenIntent> _open = const [];
  bool _checkingOpen = false;

  /// Methods the rep records after the fact. All work with no signal.
  static const _methods = {
    'CASH': 'Cash',
    'MPESA': 'M-Pesa code',
    'BANK': 'Bank transfer',
    'CHEQUE': 'Cheque',
  };

  /// The confirmation code as it appears in the customer's M-Pesa SMS. The
  /// server refuses anything else (and refuses a code recorded before).
  static final _mpesaCode = RegExp(r'^[A-Z0-9]{10}$');

  static const _stillWaiting =
      'Still waiting for the customer — the payment will be recorded '
      'automatically when it completes.';

  /// True when the selected method is a gateway rather than a manual record.
  bool get _isGateway => _method.startsWith('GW:');
  String get _gatewayName => _method.substring(3);

  @override
  void initState() {
    super.initState();
    _load();
    // Fetched once per screen. A failure here just means no gateway chips;
    // cash must never depend on it.
    context.read<PaymentsService>().loadProviders();
    _payer.text = widget.customer.phone ?? '';
    _recheckOpen();
  }

  @override
  void dispose() {
    _amount.dispose();
    _reference.dispose();
    _payer.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    final invoices =
        await context.read<FieldRepository>().openInvoices(widget.customer.id);
    if (mounted) setState(() => _invoices = invoices);
  }

  /// Asks the server about collections started earlier for this customer. One
  /// that finished while the rep was away is announced and dropped; the rest
  /// are shown so they can be checked or re-sent.
  Future<void> _recheckOpen() async {
    final payments = context.read<PaymentsService>();
    final sync = context.read<SyncService>();
    setState(() => _checkingOpen = true);
    final results = await payments.recheckOpen(widget.customer.id);
    if (!mounted) return;
    var landed = 0;
    for (final r in results) {
      final current = r.current;
      if (current == null) continue;
      if (current.status == GatewayStatus.succeeded) {
        landed++;
      } else if (current.isTerminal) {
        _toast(
          '${Money.format(r.open.amountCents)} via ${_label(r.open.provider)} '
          'did not complete: ${current.failureReason ?? current.status.name}',
          error: true,
        );
      }
    }
    _open = await payments.openIntents(widget.customer.id);
    if (!mounted) return;
    setState(() => _checkingOpen = false);
    if (landed > 0) {
      _toast(landed == 1
          ? 'An earlier payment has come through — syncing it now.'
          : '$landed earlier payments have come through — syncing them now.');
      await sync.sync(reason: 'gateway-settled');
    }
  }

  String _label(String provider) =>
      context.read<PaymentsService>().providers
          .where((p) => p.name == provider)
          .map((p) => p.label)
          .firstOrNull ??
      provider;

  int get _amountCents {
    final parsed = double.tryParse(_amount.text.replaceAll(',', '').trim());
    return parsed == null ? 0 : Money.toCents(parsed);
  }

  Future<void> _save() async {
    final cents = _amountCents;
    if (cents <= 0) return;

    // Resolved before the confirmation dialog's await.
    final repo = context.read<FieldRepository>();

    if (_method == 'MPESA') {
      final code = _reference.text.trim().toUpperCase();
      if (!_mpesaCode.hasMatch(code)) {
        _toast(
          "Enter the 10-character M-Pesa confirmation code from the customer's SMS (for example QHX7K2M9PL).",
          error: true,
        );
        return;
      }
      _reference.text = code;
    }

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

    if (_isGateway) {
      await _collect(cents);
      return;
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

  /// Runs a gateway collection and waits on the customer.
  ///
  /// Nothing is written locally. When the gateway confirms, the server books
  /// the Payment; this only triggers a sync so it comes back down. Writing one
  /// here as well would credit the customer twice.
  ///
  /// [resend] forces a fresh request (a second prompt) for a collection the
  /// customer never answered; otherwise a request made in the last two minutes
  /// for the same amount is reused, so a nervous second tap cannot push two
  /// prompts at the customer.
  Future<void> _collect(int cents, {OpenIntent? resend}) async {
    final payments = context.read<PaymentsService>();
    final providerName = resend?.provider ?? _gatewayName;
    final provider = payments.usableNamed(providerName);
    if (provider == null) {
      _toast(
        'That payment method is not available right now. Record the payment '
        'another way or try again later.',
        error: true,
      );
      return;
    }

    final payer = (resend?.payer ?? _payer.text).trim();
    if (payer.isEmpty) {
      _toast(
        provider.needs == 'email'
            ? "Enter the customer's email for a card payment"
            : "Enter the customer's phone number",
        error: true,
      );
      return;
    }

    setState(() => _saving = true);

    // Same request again within the window → the server replays the same
    // intent and no second prompt is sent. A deliberate resend after the
    // window gets a new key, and therefore a new prompt.
    String? reuseKey;
    if (resend == null) {
      final reusable = await payments.reusable(
        customerId: widget.customer.id,
        provider: provider.name,
        amountCents: cents,
      );
      reuseKey = reusable?.clientUuid;
    }

    GatewayIntent intent;
    try {
      intent = await payments.initiate(
        customerId: widget.customer.id,
        provider: provider.name,
        amountCents: cents,
        payerPhone: provider.needs == 'phone' ? payer : null,
        payerEmail: provider.needs == 'email' ? payer : null,
        visitId: widget.visitId,
        clientUuid: reuseKey,
      );
    } catch (error) {
      if (!mounted) return;
      setState(() => _saving = false);
      _toast('$error', error: true);
      return;
    }

    if (intent.status == GatewayStatus.failed) {
      if (!mounted) return;
      setState(() => _saving = false);
      _toast(intent.failureReason ?? 'The gateway refused the request', error: true);
      await _refreshOpen();
      return;
    }

    if (!mounted) return;
    if (reuseKey != null) {
      _toast('The customer should already have the prompt — waiting on it rather than sending another.');
    }
    await _watch(intent, provider, cents);
  }

  /// Shows the waiting dialog and acts on how it ended.
  Future<void> _watch(GatewayIntent intent, GatewayProvider provider, int cents) async {
    final payments = context.read<PaymentsService>();
    final sync = context.read<SyncService>();

    final outcome = await showDialog<GatewayIntent>(
      context: context,
      barrierDismissible: false,
      builder: (_) => _AwaitingPaymentDialog(
        intent: intent,
        provider: provider,
        amountCents: cents,
      ),
    );

    if (!mounted) return;
    setState(() => _saving = false);

    if (outcome?.status == GatewayStatus.succeeded) {
      // The payment exists on the server; pull it down so the balance and the
      // day's totals are right before the rep walks away.
      await payments.forgetOpen(intent.id, customerId: widget.customer.id);
      await sync.sync(reason: 'gateway-settled');
      if (!mounted) return;
      Navigator.pop(context);
      _toast(
        '${Money.format(outcome!.amountCents)} received'
        '${outcome.receiptRef == null ? '' : ' · ${outcome.receiptRef}'}',
      );
      return;
    }

    if (outcome == null || outcome.isOpen) {
      // Closed by the rep, or the two-minute watch ran out. Neither is a
      // failure: the prompt may still be answered, and the intent stays on
      // the handset to be checked the next time this screen opens.
      _toast(_stillWaiting);
      await _refreshOpen();
      return;
    }

    await payments.forgetOpen(intent.id, customerId: widget.customer.id);
    _toast(outcome.failureReason ?? 'The payment did not complete', error: true);
    await _refreshOpen();
  }

  Future<void> _refreshOpen() async {
    final open = await context.read<PaymentsService>().openIntents(widget.customer.id);
    if (mounted) setState(() => _open = open);
  }

  /// Re-asks the server about one open collection, right now.
  Future<void> _checkOne(OpenIntent open) async {
    final payments = context.read<PaymentsService>();
    final sync = context.read<SyncService>();
    final provider = payments.usableNamed(open.provider) ??
        GatewayProvider(name: open.provider, label: _label(open.provider), needs: 'phone', configured: true);
    GatewayIntent current;
    try {
      current = await payments.status(open.id);
    } catch (error) {
      _toast('$error', error: true);
      return;
    }
    if (!mounted) return;
    if (current.isOpen) {
      setState(() => _saving = true);
      await _watch(current, provider, open.amountCents);
      return;
    }
    await payments.forgetOpen(open.id, customerId: widget.customer.id);
    if (current.status == GatewayStatus.succeeded) {
      await sync.sync(reason: 'gateway-settled');
      if (!mounted) return;
      _toast('${Money.format(current.amountCents)} received${current.receiptRef == null ? '' : ' · ${current.receiptRef}'}');
    } else {
      _toast(current.failureReason ?? 'The payment did not complete', error: true);
    }
    await _refreshOpen();
  }

  void _toast(String message, {bool error = false}) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(message),
        behavior: SnackBarBehavior.floating,
        backgroundColor: error ? RautTheme.danger : null,
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final remaining = widget.customer.balanceCents - _amountCents;

    // Watched, not read: a connection returning mid-visit should light the
    // gateway options up without the rep backing out and coming in again.
    final online = context.watch<SyncService>().status.online;
    final payments = context.watch<PaymentsService>();
    final gateways = payments.usable;
    final gatewayNeedsEmail = _isGateway &&
        gateways.any((g) => g.name == _gatewayName && g.needs == 'email');

    return Scaffold(
      appBar: AppBar(
        title: Text(_isGateway ? 'Collect payment' : 'Record payment'),
      ),
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

          if (_open.isNotEmpty || _checkingOpen) ...[
            const SizedBox(height: 12),
            _OpenIntentsCard(
              open: _open,
              checking: _checkingOpen,
              label: _label,
              canResend: payments.canResend,
              busy: _saving,
              onCheck: _checkOne,
              onResend: (o) => _collect(o.amountCents, resend: o),
            ),
          ],

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
            runSpacing: 8,
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

          // Gateways are only offered when this deployment has credentials for
          // them AND the device is online. Showing a button that cannot work is
          // how a payments feature loses a field team on its first day.
          if (gateways.isNotEmpty) ...[
            const SizedBox(height: 16),
            Row(
              children: [
                Text(
                  'Collect now',
                  style: TextStyle(
                    fontSize: 12,
                    fontWeight: FontWeight.w600,
                    color: Colors.grey.shade600,
                  ),
                ),
                const SizedBox(width: 8),
                if (!online)
                  Text(
                    '· needs a connection',
                    style: TextStyle(fontSize: 12, color: RautTheme.warning),
                  ),
              ],
            ),
            const SizedBox(height: 8),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: gateways
                  .map(
                    (g) => ChoiceChip(
                      label: Text(g.label),
                      selected: _method == 'GW:${g.name}',
                      onSelected: online
                          ? (_) => setState(() => _method = 'GW:${g.name}')
                          : null,
                    ),
                  )
                  .toList(),
            ),
          ],

          const SizedBox(height: 16),
          if (_isGateway)
            TextField(
              controller: _payer,
              keyboardType: gatewayNeedsEmail
                  ? TextInputType.emailAddress
                  : TextInputType.phone,
              decoration: InputDecoration(
                labelText: gatewayNeedsEmail
                    ? "Customer's email"
                    : "Customer's M-Pesa number",
                helperText: gatewayNeedsEmail
                    ? 'A payment link is created for them'
                    : 'The prompt goes to this handset · whole shillings only',
                prefixIcon: Icon(
                  gatewayNeedsEmail ? Icons.alternate_email : Icons.phone_android,
                ),
              ),
            )
          else
            TextField(
              controller: _reference,
              textCapitalization: _method == 'MPESA'
                  ? TextCapitalization.characters
                  : TextCapitalization.none,
              maxLength: _method == 'MPESA' ? 10 : null,
              decoration: InputDecoration(
                labelText: _method == 'MPESA'
                    ? 'M-Pesa confirmation code'
                    : _method == 'CHEQUE'
                        ? 'Cheque number'
                        : 'Reference (optional)',
                helperText: _method == 'MPESA'
                    ? "10 characters from the customer's SMS, e.g. QHX7K2M9PL"
                    : null,
                counterText: '',
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
                        trailing: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Text(
                              Money.format(inv.outstandingCents),
                              style: const TextStyle(fontWeight: FontWeight.w700),
                            ),
                            // The receipt is reachable from wherever the
                            // invoice is, because a rep asked for one is
                            // standing at the counter, not navigating a menu.
                            IconButton(
                              tooltip: 'Receipt',
                              icon: Icon(
                                inv.isFiled
                                    ? Icons.receipt_long_outlined
                                    : Icons.print_outlined,
                                size: 20,
                              ),
                              onPressed: () => Navigator.of(context).push(
                                MaterialPageRoute<void>(
                                  builder: (_) => ReceiptScreen(
                                    invoiceId: inv.id,
                                    customerName: widget.customer.name,
                                  ),
                                ),
                              ),
                            ),
                          ],
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
                : Icon(_isGateway ? Icons.smartphone : Icons.check),
            // "Request" not "Record": with a gateway the rep is asking the
            // customer to pay, and the money is not theirs until the provider
            // says so. Labelling it the same as cash would promise too much.
            label: Text(
              _amountCents <= 0
                  ? 'Enter an amount'
                  : _isGateway
                      ? 'Request ${Money.format(_amountCents)}'
                      : 'Record ${Money.format(_amountCents)}',
            ),
          ),
        ),
      ),
    );
  }
}

/// Collections started earlier for this customer that have not finished.
class _OpenIntentsCard extends StatelessWidget {
  const _OpenIntentsCard({
    required this.open,
    required this.checking,
    required this.label,
    required this.canResend,
    required this.busy,
    required this.onCheck,
    required this.onResend,
  });

  final List<OpenIntent> open;
  final bool checking;
  final String Function(String provider) label;
  final bool Function(OpenIntent) canResend;
  final bool busy;
  final void Function(OpenIntent) onCheck;
  final void Function(OpenIntent) onResend;

  @override
  Widget build(BuildContext context) {
    return Card(
      color: RautTheme.warning.withValues(alpha: 0.08),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 8),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(Icons.hourglass_top, size: 18, color: RautTheme.warning),
                const SizedBox(width: 8),
                const Expanded(
                  child: Text(
                    'Waiting on the customer',
                    style: TextStyle(fontWeight: FontWeight.w700),
                  ),
                ),
                if (checking)
                  const SizedBox(
                    height: 14,
                    width: 14,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  ),
              ],
            ),
            for (final o in open) ...[
              const SizedBox(height: 8),
              Text(
                '${Money.format(o.amountCents)} via ${label(o.provider)} · '
                'requested ${_ago(o.createdAt)}',
                style: const TextStyle(fontSize: 13),
              ),
              if (o.redirectUrl != null) ...[
                const SizedBox(height: 4),
                SelectableText(
                  o.redirectUrl!,
                  style: TextStyle(fontSize: 11.5, color: Colors.grey.shade700),
                ),
              ],
              Wrap(
                spacing: 4,
                children: [
                  TextButton(
                    onPressed: busy ? null : () => onCheck(o),
                    child: const Text('Check now'),
                  ),
                  if (o.redirectUrl != null) ...[
                    TextButton(
                      onPressed: () => launchUrl(Uri.parse(o.redirectUrl!), mode: LaunchMode.externalApplication),
                      child: const Text('Open link'),
                    ),
                    TextButton(
                      onPressed: () async {
                        await Clipboard.setData(ClipboardData(text: o.redirectUrl!));
                        if (context.mounted) {
                          ScaffoldMessenger.of(context).showSnackBar(
                            const SnackBar(content: Text('Payment link copied'), behavior: SnackBarBehavior.floating),
                          );
                        }
                      },
                      child: const Text('Copy link'),
                    ),
                  ] else
                    TextButton(
                      // Only after the first prompt has had its two minutes:
                      // a second prompt on top of a live one confuses the
                      // customer and can charge them twice.
                      onPressed: busy || !canResend(o) ? null : () => onResend(o),
                      child: Text(canResend(o) ? 'Resend prompt' : 'Resend available in 2 min'),
                    ),
                ],
              ),
            ],
          ],
        ),
      ),
    );
  }

  static String _ago(DateTime at) {
    final d = DateTime.now().difference(at);
    if (d.inMinutes < 1) return 'just now';
    if (d.inMinutes < 60) return '${d.inMinutes} min ago';
    if (d.inHours < 24) return '${d.inHours} h ago';
    return DateFormat('d MMM, HH:mm').format(at);
  }
}

/// Waits on the customer while the gateway does its work.
///
/// Deliberately dismissible. An STK prompt can sit unanswered while a customer
/// hunts for their phone, and trapping a rep behind a modal they cannot escape
/// is worse than letting them carry on — the collection keeps running server
/// side either way, and the next sync picks it up. When the two-minute watch
/// runs out the dialog hands back the last *open* state; the screen reads that
/// as "still waiting", never as a failure.
class _AwaitingPaymentDialog extends StatefulWidget {
  const _AwaitingPaymentDialog({
    required this.intent,
    required this.provider,
    required this.amountCents,
  });

  final GatewayIntent intent;
  final GatewayProvider provider;
  final int amountCents;

  @override
  State<_AwaitingPaymentDialog> createState() => _AwaitingPaymentDialogState();
}

class _AwaitingPaymentDialogState extends State<_AwaitingPaymentDialog> {
  late GatewayIntent _current = widget.intent;

  @override
  void initState() {
    super.initState();
    _watch();
  }

  Future<void> _watch() async {
    final payments = context.read<PaymentsService>();
    await for (final update in payments.watch(widget.intent.id)) {
      if (!mounted) return;
      setState(() => _current = update);
      if (update.isTerminal) {
        Navigator.of(context).pop(update);
        return;
      }
    }
    // Timed out rather than resolved. Hand back what we last knew — an open
    // intent, which the screen reports as still waiting.
    if (mounted) Navigator.of(context).pop(_current);
  }

  @override
  Widget build(BuildContext context) {
    final phone = widget.provider.needs == 'phone';
    final link = _current.redirectUrl ?? widget.intent.redirectUrl;
    return AlertDialog(
      title: Text('Waiting for ${Money.format(widget.amountCents)}'),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const LinearProgressIndicator(),
          const SizedBox(height: 16),
          Text(
            phone
                ? 'Ask the customer to check their phone and enter their '
                  'M-Pesa PIN on the prompt.'
                : 'The customer completes the card payment on the link below. '
                  'Open it on this phone for them, or share it.',
            style: const TextStyle(height: 1.4),
          ),
          if (!phone && link != null) ...[
            const SizedBox(height: 12),
            SelectableText(
              link,
              style: TextStyle(fontSize: 12, color: Colors.grey.shade700),
            ),
            const SizedBox(height: 8),
            Wrap(
              spacing: 8,
              children: [
                FilledButton.tonalIcon(
                  onPressed: () => launchUrl(Uri.parse(link), mode: LaunchMode.externalApplication),
                  icon: const Icon(Icons.open_in_new, size: 18),
                  label: const Text('Open payment link'),
                ),
                OutlinedButton.icon(
                  onPressed: () async {
                    await Clipboard.setData(ClipboardData(text: link));
                    if (context.mounted) {
                      ScaffoldMessenger.of(context).showSnackBar(
                        const SnackBar(content: Text('Payment link copied'), behavior: SnackBarBehavior.floating),
                      );
                    }
                  },
                  icon: const Icon(Icons.copy, size: 18),
                  label: const Text('Copy link'),
                ),
              ],
            ),
          ],
          const SizedBox(height: 12),
          Text(
            'This screen updates on its own. You can close it and keep '
            'working — the payment will still come through and is checked '
            'again the next time you open this customer.',
            style: TextStyle(fontSize: 12, color: Colors.grey.shade600, height: 1.35),
          ),
        ],
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(null),
          child: const Text('Close'),
        ),
      ],
    );
  }
}
