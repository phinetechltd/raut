import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';

import '../core/auth_service.dart';
import '../core/location_service.dart';
import '../core/money.dart';
import '../data/field_repository.dart';
import '../models/models.dart';
import '../theme.dart';
import 'order_screen.dart';
import 'payment_screen.dart';

/// The visit workflow: check in, sell, collect, photograph, check out.
///
/// Check-in is the hinge of the product — it is what turns a claimed visit into
/// an evidenced one — so the GPS verdict is shown before and after, in plain
/// language, rather than buried in a status field the rep never sees.
class VisitScreen extends StatefulWidget {
  const VisitScreen({super.key, required this.visitId});

  final String visitId;

  @override
  State<VisitScreen> createState() => _VisitScreenState();
}

class _VisitScreenState extends State<VisitScreen> {
  Visit? _visit;
  Customer? _customer;
  List<InvoiceSummary> _openInvoices = const [];
  bool _loading = true;
  bool _working = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final repo = context.read<FieldRepository>();
    final visit = await repo.visit(widget.visitId);
    final customer = visit == null ? null : await repo.customer(visit.customerId);
    final invoices =
        customer == null ? <InvoiceSummary>[] : await repo.openInvoices(customer.id);

    if (!mounted) return;
    setState(() {
      _visit = visit;
      _customer = customer;
      _openInvoices = invoices;
      _loading = false;
    });
  }

  void _toast(String message, {bool error = false}) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(message),
        backgroundColor: error ? RautTheme.danger : null,
        behavior: SnackBarBehavior.floating,
      ),
    );
  }

  Future<void> _checkIn() async {
    final session = context.read<AuthService>().session!;
    final location = context.read<LocationService>();
    final repo = context.read<FieldRepository>();

    setState(() => _working = true);
    try {
      final position = await location.currentPosition();

      final verification = await repo.checkIn(
        visitId: widget.visitId,
        latitude: position.latitude,
        longitude: position.longitude,
        accuracyM: position.accuracy,
        geofencingEnabled: session.geofencingEnabled,
      );

      await _load();
      if (!mounted) return;

      // Tell the rep the verdict immediately. Discovering at month-end that a
      // visit did not count is how field teams lose trust in the system.
      if (session.geofencingEnabled && !verification.verified) {
        await showDialog<void>(
          context: context,
          builder: (context) => AlertDialog(
            icon: const Icon(Icons.location_off, color: RautTheme.warning, size: 36),
            title: const Text('Checked in, but not verified'),
            content: Text(
              '${verification.reason}.\n\n'
              'Your check-in has been recorded and will sync, but it will show '
              'as unverified to your manager. If the shop has moved, update the '
              'customer pin from this screen.',
            ),
            actions: [
              TextButton(
                onPressed: () => Navigator.pop(context),
                child: const Text('Understood'),
              ),
            ],
          ),
        );
      } else {
        _toast(verification.reason);
      }
    } on LocationException catch (error) {
      _toast(error.message, error: true);
    } catch (error) {
      _toast('$error', error: true);
    } finally {
      if (mounted) setState(() => _working = false);
    }
  }

  Future<void> _checkOut() async {
    // Providers are resolved before the await, so nothing reaches for a
    // BuildContext that may have been disposed while the sheet was open.
    final location = context.read<LocationService>();
    final repo = context.read<FieldRepository>();

    final outcome = await showModalBottomSheet<Map<String, String?>>(
      context: context,
      isScrollControlled: true,
      builder: (context) => const _CheckOutSheet(),
    );
    if (outcome == null || !mounted) return;

    setState(() => _working = true);
    try {
      double? lat;
      double? lng;
      try {
        final position = await location.currentPosition();
        lat = position.latitude;
        lng = position.longitude;
      } catch (_) {
        // Check-out position is useful but not required — refusing to close a
        // visit because GPS is slow would strand the rep at the shop.
      }

      await repo.checkOut(
        visitId: widget.visitId,
        latitude: lat,
        longitude: lng,
        outcome: outcome['outcome'],
        notes: outcome['notes'],
      );

      await _load();
      _toast('Visit completed');
    } catch (error) {
      _toast('$error', error: true);
    } finally {
      if (mounted) setState(() => _working = false);
    }
  }

  Future<void> _takePhoto() async {
    final location = context.read<LocationService>();
    final repo = context.read<FieldRepository>();

    try {
      final picker = ImagePicker();
      final photo = await picker.pickImage(
        source: ImageSource.camera,
        // Compressed on capture: an uncompressed 12MP shot would sit in the
        // queue for hours on a 3G connection.
        imageQuality: 70,
        maxWidth: 1600,
      );
      if (photo == null) return;

      await repo.attachPhoto(
        visitId: widget.visitId,
        filePath: photo.path,
        latitude: location.lastPosition?.latitude,
        longitude: location.lastPosition?.longitude,
      );

      _toast('Photo saved — it will upload on the next sync');
    } catch (error) {
      _toast('Could not capture photo: $error', error: true);
    }
  }

  Future<void> _updatePin() async {
    final location = context.read<LocationService>();
    final repo = context.read<FieldRepository>();

    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Update customer pin?'),
        content: Text(
          'This sets ${_customer?.name}\'s location to where you are standing '
          'now. Future visits will be verified against this point.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Update pin'),
          ),
        ],
      ),
    );
    if (confirmed != true || _customer == null || !mounted) return;

    setState(() => _working = true);
    try {
      final position = await location.currentPosition();
      await repo.updateCustomerLocation(
        _customer!.id,
        latitude: position.latitude,
        longitude: position.longitude,
      );
      await _load();
      _toast('Pin updated');
    } on LocationException catch (error) {
      _toast(error.message, error: true);
    } finally {
      if (mounted) setState(() => _working = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) {
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }

    final visit = _visit;
    final customer = _customer;
    if (visit == null || customer == null) {
      return Scaffold(
        appBar: AppBar(title: const Text('Visit')),
        body: const Center(child: Text('This visit is not on your device')),
      );
    }

    final session = context.watch<AuthService>().session!;

    return Scaffold(
      appBar: AppBar(
        title: Text(customer.name, overflow: TextOverflow.ellipsis),
        actions: [
          if (visit.isCheckedIn)
            IconButton(
              icon: const Icon(Icons.photo_camera_outlined),
              onPressed: _takePhoto,
              tooltip: 'Take photo',
            ),
        ],
      ),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 120),
        children: [
          _CustomerCard(customer: customer, onUpdatePin: _updatePin),
          const SizedBox(height: 12),
          _VisitStatusCard(visit: visit, session: session),

          if (_openInvoices.isNotEmpty) ...[
            const SizedBox(height: 12),
            Card(
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text(
                      'Outstanding invoices',
                      style: TextStyle(fontWeight: FontWeight.w700),
                    ),
                    const SizedBox(height: 10),
                    ..._openInvoices.map(
                      (inv) => Padding(
                        padding: const EdgeInsets.only(bottom: 8),
                        child: Row(
                          children: [
                            Expanded(
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Text(
                                    inv.number,
                                    style: const TextStyle(
                                      fontWeight: FontWeight.w600,
                                      fontSize: 13,
                                    ),
                                  ),
                                  if (inv.dueDate != null)
                                    Text(
                                      'Due ${DateFormat('d MMM').format(inv.dueDate!)}',
                                      style: TextStyle(
                                        fontSize: 11.5,
                                        color: inv.isOverdue
                                            ? RautTheme.danger
                                            : Colors.grey.shade600,
                                      ),
                                    ),
                                ],
                              ),
                            ),
                            Text(
                              Money.format(inv.outstandingCents),
                              style: const TextStyle(fontWeight: FontWeight.w700),
                            ),
                          ],
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ],
        ],
      ),

      bottomNavigationBar: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: _ActionBar(
            visit: visit,
            working: _working,
            canTakePayments: session.canTakePayments,
            onCheckIn: _checkIn,
            onCheckOut: _checkOut,
            onOrder: () async {
              await Navigator.of(context).push(
                MaterialPageRoute(
                  builder: (_) => OrderScreen(
                    customer: customer,
                    visitId: visit.id,
                  ),
                ),
              );
              await _load();
            },
            onPayment: () async {
              await Navigator.of(context).push(
                MaterialPageRoute(
                  builder: (_) => PaymentScreen(
                    customer: customer,
                    visitId: visit.id,
                  ),
                ),
              );
              await _load();
            },
          ),
        ),
      ),
    );
  }
}

class _CustomerCard extends StatelessWidget {
  const _CustomerCard({required this.customer, required this.onUpdatePin});

  final Customer customer;
  final VoidCallback onUpdatePin;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        customer.name,
                        style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w700),
                      ),
                      Text(
                        '${customer.code} · ${customer.town ?? "no town"}',
                        style: TextStyle(fontSize: 12.5, color: Colors.grey.shade600),
                      ),
                    ],
                  ),
                ),
                if (customer.owesMoney)
                  Column(
                    crossAxisAlignment: CrossAxisAlignment.end,
                    children: [
                      Text(
                        Money.format(customer.balanceCents),
                        style: TextStyle(
                          fontWeight: FontWeight.w700,
                          color: customer.overCreditLimit
                              ? RautTheme.danger
                              : RautTheme.warning,
                        ),
                      ),
                      Text(
                        'balance',
                        style: TextStyle(fontSize: 11, color: Colors.grey.shade600),
                      ),
                    ],
                  ),
              ],
            ),

            if (customer.overCreditLimit) ...[
              const SizedBox(height: 10),
              Container(
                padding: const EdgeInsets.all(10),
                decoration: BoxDecoration(
                  color: RautTheme.danger.withValues(alpha: 0.1),
                  borderRadius: BorderRadius.circular(8),
                ),
                child: Row(
                  children: [
                    const Icon(Icons.warning_amber_rounded,
                        size: 16, color: RautTheme.danger),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        'Over credit limit of ${Money.format(customer.creditLimitCents)}',
                        style: const TextStyle(
                          fontSize: 12,
                          color: RautTheme.danger,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ],

            const SizedBox(height: 12),
            Row(
              children: [
                Icon(
                  customer.hasPin ? Icons.place : Icons.location_off_outlined,
                  size: 15,
                  color: customer.hasPin ? RautTheme.success : RautTheme.warning,
                ),
                const SizedBox(width: 6),
                Expanded(
                  child: Text(
                    customer.hasPin
                        ? 'Pin captured · ${customer.geofenceRadiusM}m check-in range'
                        : 'No GPS pin — visits here cannot be verified',
                    style: TextStyle(
                      fontSize: 12,
                      color: customer.hasPin ? Colors.grey.shade700 : RautTheme.warning,
                    ),
                  ),
                ),
                TextButton(
                  onPressed: onUpdatePin,
                  child: Text(customer.hasPin ? 'Update' : 'Drop pin'),
                ),
              ],
            ),

            if (customer.phone != null) ...[
              const Divider(height: 20),
              Row(
                children: [
                  Icon(Icons.phone_outlined, size: 15, color: Colors.grey.shade600),
                  const SizedBox(width: 6),
                  Text(customer.phone!, style: const TextStyle(fontSize: 13)),
                ],
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class _VisitStatusCard extends StatelessWidget {
  const _VisitStatusCard({required this.visit, required this.session});

  final Visit visit;
  final Session session;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                const Text('Visit', style: TextStyle(fontWeight: FontWeight.w700)),
                const Spacer(),
                StatusChip(visit.status),
              ],
            ),
            const SizedBox(height: 12),

            _Row(
              icon: Icons.schedule,
              label: 'Scheduled',
              value: DateFormat('h:mm a').format(visit.scheduledAt),
            ),
            if (visit.checkInAt != null)
              _Row(
                icon: Icons.login,
                label: 'Checked in',
                value: DateFormat('h:mm a').format(visit.checkInAt!),
              ),
            if (visit.checkOutAt != null)
              _Row(
                icon: Icons.logout,
                label: 'Checked out',
                value:
                    '${DateFormat('h:mm a').format(visit.checkOutAt!)} · ${visit.durationMin} min',
              ),

            if (visit.checkInAt != null && session.geofencingEnabled) ...[
              const Divider(height: 20),
              Row(
                children: [
                  Icon(
                    visit.geofenceVerified
                        ? Icons.verified_outlined
                        : Icons.location_off_outlined,
                    size: 18,
                    color: visit.geofenceVerified
                        ? RautTheme.success
                        : RautTheme.warning,
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      visit.geofenceVerified
                          ? 'GPS verified${visit.distanceFromCustomerM != null ? " — ${visit.distanceFromCustomerM}m from the shop" : ""}'
                          : 'Not verified${visit.distanceFromCustomerM != null ? " — ${visit.distanceFromCustomerM}m away" : ""}',
                      style: TextStyle(
                        fontSize: 12.5,
                        fontWeight: FontWeight.w600,
                        color: visit.geofenceVerified
                            ? RautTheme.success
                            : RautTheme.warning,
                      ),
                    ),
                  ),
                ],
              ),
            ],

            if (visit.outcome != null) ...[
              const Divider(height: 20),
              _Row(icon: Icons.flag_outlined, label: 'Outcome', value: visit.outcome!),
            ],
            if (visit.notes != null && visit.notes!.isNotEmpty) ...[
              const SizedBox(height: 8),
              Text(
                visit.notes!,
                style: TextStyle(fontSize: 13, color: Colors.grey.shade700),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class _Row extends StatelessWidget {
  const _Row({required this.icon, required this.label, required this.value});

  final IconData icon;
  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Row(
        children: [
          Icon(icon, size: 15, color: Colors.grey.shade500),
          const SizedBox(width: 8),
          Text(label, style: TextStyle(fontSize: 13, color: Colors.grey.shade600)),
          const Spacer(),
          Text(value, style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600)),
        ],
      ),
    );
  }
}

class _ActionBar extends StatelessWidget {
  const _ActionBar({
    required this.visit,
    required this.working,
    required this.canTakePayments,
    required this.onCheckIn,
    required this.onCheckOut,
    required this.onOrder,
    required this.onPayment,
  });

  final Visit visit;
  final bool working;
  final bool canTakePayments;
  final VoidCallback onCheckIn;
  final VoidCallback onCheckOut;
  final VoidCallback onOrder;
  final VoidCallback onPayment;

  @override
  Widget build(BuildContext context) {
    if (working) {
      return const FilledButton(
        onPressed: null,
        child: SizedBox(
          height: 20,
          width: 20,
          child: CircularProgressIndicator(strokeWidth: 2),
        ),
      );
    }

    if (visit.canCheckIn) {
      return FilledButton.icon(
        onPressed: onCheckIn,
        icon: const Icon(Icons.login),
        label: const Text('Check in'),
      );
    }

    if (visit.canCheckOut) {
      return Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Row(
            children: [
              Expanded(
                child: OutlinedButton.icon(
                  onPressed: onOrder,
                  icon: const Icon(Icons.add_shopping_cart),
                  label: const Text('Order'),
                ),
              ),
              if (canTakePayments) ...[
                const SizedBox(width: 10),
                Expanded(
                  child: OutlinedButton.icon(
                    onPressed: onPayment,
                    icon: const Icon(Icons.payments_outlined),
                    label: const Text('Payment'),
                  ),
                ),
              ],
            ],
          ),
          const SizedBox(height: 10),
          FilledButton.icon(
            onPressed: onCheckOut,
            icon: const Icon(Icons.logout),
            label: const Text('Check out'),
          ),
        ],
      );
    }

    return OutlinedButton.icon(
      onPressed: null,
      icon: const Icon(Icons.check_circle_outline),
      label: const Text('Visit complete'),
    );
  }
}

class _CheckOutSheet extends StatefulWidget {
  const _CheckOutSheet();

  @override
  State<_CheckOutSheet> createState() => _CheckOutSheetState();
}

class _CheckOutSheetState extends State<_CheckOutSheet> {
  static const _outcomes = [
    'Order placed',
    'Payment collected',
    'No order today',
    'Shop closed',
    'Stock check only',
    'Follow-up needed',
  ];

  String? _selected;
  final _notes = TextEditingController();

  @override
  void dispose() {
    _notes.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.only(
        left: 20,
        right: 20,
        top: 20,
        bottom: MediaQuery.of(context).viewInsets.bottom + 20,
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text(
            'How did the visit go?',
            style: TextStyle(fontSize: 17, fontWeight: FontWeight.w700),
          ),
          const SizedBox(height: 14),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: _outcomes
                .map(
                  (o) => ChoiceChip(
                    label: Text(o),
                    selected: _selected == o,
                    onSelected: (_) => setState(() => _selected = o),
                  ),
                )
                .toList(),
          ),
          const SizedBox(height: 16),
          TextField(
            controller: _notes,
            maxLines: 3,
            decoration: const InputDecoration(
              labelText: 'Notes (optional)',
              alignLabelWithHint: true,
            ),
          ),
          const SizedBox(height: 18),
          FilledButton(
            onPressed: _selected == null
                ? null
                : () => Navigator.pop(context, {
                      'outcome': _selected,
                      'notes': _notes.text.trim().isEmpty ? null : _notes.text.trim(),
                    }),
            child: const Text('Complete visit'),
          ),
        ],
      ),
    );
  }
}

