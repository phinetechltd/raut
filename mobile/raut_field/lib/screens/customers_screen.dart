import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../core/location_service.dart';
import '../core/money.dart';
import '../core/sync_service.dart';
import '../data/field_repository.dart';
import '../models/models.dart';
import '../theme.dart';
import 'visit_screen.dart';

/// The rep's customer book, available in full offline.
class CustomersScreen extends StatefulWidget {
  const CustomersScreen({super.key});

  @override
  State<CustomersScreen> createState() => _CustomersScreenState();
}

class _CustomersScreenState extends State<CustomersScreen> {
  final _search = TextEditingController();
  bool _owingOnly = false;
  List<Customer> _customers = const [];
  bool _loading = true;

  /// Watermark of the sync already reflected in [_customers]. A sync writes
  /// straight to the local store, which the repository does not observe, so
  /// without this the customer book stays empty after the sign-in sync.
  DateTime? _renderedSyncAt;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    final customers = await context.read<FieldRepository>().customers(
          search: _search.text,
          owingOnly: _owingOnly,
        );
    if (!mounted) return;
    setState(() {
      _customers = customers;
      _loading = false;
    });
  }

  /// Starts an unplanned visit — a rep passing a shop that is not on the route.
  Future<void> _startAdHocVisit(Customer customer) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text('Visit ${customer.name}?'),
        content: const Text(
          'This creates an unplanned visit you can check into now. It will '
          'appear on your route and sync to the office.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Start visit'),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;

    final visitId =
        await context.read<FieldRepository>().createAdHocVisit(customerId: customer.id);
    if (!mounted) return;

    await Navigator.of(context).push(
      MaterialPageRoute(builder: (_) => VisitScreen(visitId: visitId)),
    );
    _load();
  }

  Future<void> _newCustomer() async {
    final result = await showModalBottomSheet<Map<String, dynamic>>(
      context: context,
      isScrollControlled: true,
      builder: (_) => const _NewCustomerSheet(),
    );
    if (result == null || !mounted) return;

    // Capture the pin at creation: a customer added without one cannot be
    // routed to or geofenced, and nobody ever goes back to add it later.
    double? lat;
    double? lng;
    if (result['capturePin'] == true) {
      try {
        final position = await context.read<LocationService>().currentPosition();
        lat = position.latitude;
        lng = position.longitude;
      } on LocationException catch (error) {
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text('Saved without a pin: ${error.message}')),
          );
        }
      }
    }

    if (!mounted) return;
    await context.read<FieldRepository>().createCustomer(
          name: result['name'] as String,
          phone: result['phone'] as String?,
          town: result['town'] as String?,
          latitude: lat,
          longitude: lng,
        );

    _load();
    if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('Customer saved — it will sync automatically'),
          behavior: SnackBarBehavior.floating,
        ),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    context.watch<FieldRepository>();

    // Reload once per completed sync — see [_renderedSyncAt].
    final syncedAt = context.watch<SyncService>().status.lastSyncedAt;
    if (syncedAt != null && syncedAt != _renderedSyncAt) {
      _renderedSyncAt = syncedAt;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) _load();
      });
    }

    return Scaffold(
      appBar: AppBar(
        title: const Text('Customers'),
        bottom: PreferredSize(
          preferredSize: const Size.fromHeight(104),
          child: Column(
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
                child: TextField(
                  controller: _search,
                  onChanged: (_) => _load(),
                  decoration: InputDecoration(
                    hintText: 'Search by name, code, phone or town',
                    prefixIcon: const Icon(Icons.search),
                    isDense: true,
                    suffixIcon: _search.text.isEmpty
                        ? null
                        : IconButton(
                            icon: const Icon(Icons.clear),
                            onPressed: () {
                              _search.clear();
                              _load();
                            },
                          ),
                  ),
                ),
              ),
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 0, 16, 10),
                child: Row(
                  children: [
                    FilterChip(
                      label: const Text('Owing money'),
                      selected: _owingOnly,
                      onSelected: (v) {
                        setState(() => _owingOnly = v);
                        _load();
                      },
                    ),
                    const Spacer(),
                    Text(
                      '${_customers.length} customer(s)',
                      style: TextStyle(fontSize: 12, color: Colors.grey.shade600),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),

      floatingActionButton: FloatingActionButton.extended(
        onPressed: _newCustomer,
        icon: const Icon(Icons.add_business_outlined),
        label: const Text('New'),
      ),

      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _customers.isEmpty
              ? Center(
                  child: Padding(
                    padding: const EdgeInsets.all(32),
                    child: Text(
                      _search.text.isEmpty
                          ? 'No customers on this device yet.\nSync to download your customer book.'
                          : 'No customers match "${_search.text}".',
                      textAlign: TextAlign.center,
                      style: TextStyle(color: Colors.grey.shade600, height: 1.4),
                    ),
                  ),
                )
              : ListView.separated(
                  itemCount: _customers.length,
                  separatorBuilder: (_, __) => const Divider(height: 1),
                  itemBuilder: (context, index) {
                    final customer = _customers[index];
                    return ListTile(
                      title: Row(
                        children: [
                          Expanded(
                            child: Text(
                              customer.name,
                              style: const TextStyle(fontWeight: FontWeight.w600),
                            ),
                          ),
                          if (customer.isPending)
                            const Padding(
                              padding: EdgeInsets.only(left: 6),
                              child: Icon(Icons.cloud_upload_outlined,
                                  size: 15, color: Colors.grey),
                            ),
                        ],
                      ),
                      subtitle: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          const SizedBox(height: 2),
                          Text(
                            '${customer.code} · ${customer.town ?? "no town"}'
                            '${customer.phone != null ? " · ${customer.phone}" : ""}',
                            style: const TextStyle(fontSize: 12.5),
                          ),
                          if (customer.owesMoney) ...[
                            const SizedBox(height: 4),
                            Text(
                              'Balance ${Money.format(customer.balanceCents)}',
                              style: TextStyle(
                                fontSize: 12,
                                fontWeight: FontWeight.w700,
                                color: customer.overCreditLimit
                                    ? RautTheme.danger
                                    : RautTheme.warning,
                              ),
                            ),
                          ],
                        ],
                      ),
                      trailing: Column(
                        mainAxisAlignment: MainAxisAlignment.center,
                        children: [
                          Icon(
                            customer.hasPin ? Icons.place : Icons.location_off_outlined,
                            size: 16,
                            color: customer.hasPin
                                ? RautTheme.success
                                : Colors.grey.shade400,
                          ),
                          const SizedBox(height: 2),
                          Text(
                            customer.segment,
                            style: TextStyle(
                              fontSize: 10,
                              fontWeight: FontWeight.w700,
                              color: Colors.grey.shade500,
                            ),
                          ),
                        ],
                      ),
                      onTap: () => _startAdHocVisit(customer),
                    );
                  },
                ),
    );
  }
}

class _NewCustomerSheet extends StatefulWidget {
  const _NewCustomerSheet();

  @override
  State<_NewCustomerSheet> createState() => _NewCustomerSheetState();
}

class _NewCustomerSheetState extends State<_NewCustomerSheet> {
  final _name = TextEditingController();
  final _phone = TextEditingController();
  final _town = TextEditingController();
  bool _capturePin = true;

  @override
  void dispose() {
    _name.dispose();
    _phone.dispose();
    _town.dispose();
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
            'New customer',
            style: TextStyle(fontSize: 17, fontWeight: FontWeight.w700),
          ),
          const SizedBox(height: 4),
          Text(
            'Saved on this phone and synced when you have signal.',
            style: TextStyle(fontSize: 13, color: Colors.grey.shade600),
          ),
          const SizedBox(height: 16),
          TextField(
            controller: _name,
            autofocus: true,
            textCapitalization: TextCapitalization.words,
            decoration: const InputDecoration(labelText: 'Business name *'),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _phone,
            keyboardType: TextInputType.phone,
            decoration: const InputDecoration(labelText: 'Phone'),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _town,
            textCapitalization: TextCapitalization.words,
            decoration: const InputDecoration(labelText: 'Town / area'),
          ),
          const SizedBox(height: 8),
          SwitchListTile(
            contentPadding: EdgeInsets.zero,
            value: _capturePin,
            onChanged: (v) => setState(() => _capturePin = v),
            title: const Text('Capture GPS pin here', style: TextStyle(fontSize: 14)),
            subtitle: Text(
              'Uses your current position. Without a pin this customer cannot '
              'be routed to or geofenced.',
              style: TextStyle(fontSize: 12, color: Colors.grey.shade600),
            ),
          ),
          const SizedBox(height: 12),
          FilledButton(
            onPressed: () {
              if (_name.text.trim().length < 2) return;
              Navigator.pop(context, {
                'name': _name.text.trim(),
                'phone': _phone.text.trim().isEmpty ? null : _phone.text.trim(),
                'town': _town.text.trim().isEmpty ? null : _town.text.trim(),
                'capturePin': _capturePin,
              });
            },
            child: const Text('Save customer'),
          ),
        ],
      ),
    );
  }
}

