import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';

import '../core/auth_service.dart';
import '../core/config.dart';
import '../core/location_service.dart';
import '../core/money.dart';
import '../core/outbox.dart';
import '../core/sync_service.dart';
import '../data/field_repository.dart';
import '../theme.dart';

/// Sync queue, expense claims, account and diagnostics.
class MoreScreen extends StatelessWidget {
  const MoreScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final auth = context.watch<AuthService>();
    final sync = context.watch<SyncService>();
    final location = context.watch<LocationService>();
    final session = auth.session!;

    return Scaffold(
      appBar: AppBar(title: const Text('More')),
      body: ListView(
        children: [
          Padding(
            padding: const EdgeInsets.all(16),
            child: Card(
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: Row(
                  children: [
                    CircleAvatar(
                      radius: 24,
                      backgroundColor: RautTheme.brand.withValues(alpha: 0.12),
                      child: Text(
                        session.firstName.characters.first.toUpperCase(),
                        style: const TextStyle(
                          color: RautTheme.brand,
                          fontWeight: FontWeight.w700,
                          fontSize: 18,
                        ),
                      ),
                    ),
                    const SizedBox(width: 14),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            session.name,
                            style: const TextStyle(
                              fontSize: 16,
                              fontWeight: FontWeight.w700,
                            ),
                          ),
                          Text(
                            session.companyName,
                            style: TextStyle(
                              fontSize: 13,
                              color: Colors.grey.shade600,
                            ),
                          ),
                          if (session.branchName != null)
                            Text(
                              session.branchName!,
                              style: TextStyle(
                                fontSize: 12,
                                color: Colors.grey.shade500,
                              ),
                            ),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),

          _SectionLabel('Sync'),
          ListTile(
            leading: Icon(
              sync.status.hasPending
                  ? Icons.cloud_upload_outlined
                  : Icons.cloud_done_outlined,
              color: sync.status.hasPending ? RautTheme.warning : RautTheme.success,
            ),
            title: Text(
              sync.status.hasPending
                  ? '${sync.status.pendingCount} item(s) waiting'
                  : 'Everything synced',
            ),
            subtitle: Text(
              sync.status.lastSyncedAt == null
                  ? 'Never synced on this device'
                  : 'Last sync ${DateFormat('d MMM, h:mm a').format(sync.status.lastSyncedAt!)}',
            ),
            trailing: sync.status.isBusy
                ? const SizedBox(
                    height: 20,
                    width: 20,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : TextButton(
                    onPressed: () => sync.sync(reason: 'more-screen'),
                    child: const Text('Sync now'),
                  ),
          ),
          ListTile(
            leading: const Icon(Icons.list_alt_outlined),
            title: const Text('Sync queue'),
            subtitle: const Text('What is waiting to reach the office'),
            trailing: const Icon(Icons.chevron_right),
            onTap: () => Navigator.of(context).push(
              MaterialPageRoute(builder: (_) => const _SyncQueueScreen()),
            ),
          ),

          const Divider(),
          _SectionLabel('Field'),

          if (session.canRaiseExpenses)
            ListTile(
              leading: const Icon(Icons.receipt_outlined),
              title: const Text('Expense claim'),
              subtitle: const Text('Fuel, airtime, travel'),
              trailing: const Icon(Icons.chevron_right),
              onTap: () => Navigator.of(context).push(
                MaterialPageRoute(builder: (_) => const _ExpenseScreen()),
              ),
            ),

          SwitchListTile(
            secondary: Icon(
              location.isTracking ? Icons.my_location : Icons.location_disabled,
              color: location.isTracking ? RautTheme.success : Colors.grey,
            ),
            title: const Text('Location tracking'),
            subtitle: Text(
              location.isTracking
                  ? 'Recording your route in the background'
                  : location.error ?? 'Not recording',
              style: const TextStyle(fontSize: 12),
            ),
            value: location.isTracking,
            onChanged: (on) =>
                on ? location.startTracking() : location.stopTracking(),
          ),

          const Divider(),
          _SectionLabel('Subscription'),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
            child: Wrap(
              spacing: 6,
              runSpacing: 6,
              children: [
                for (final module in const [
                  ('FIELD_SALES', 'Field Sales'),
                  ('ROUTING', 'Smart Routing'),
                  ('GEOFENCING', 'Geofencing'),
                  ('SALES_POS', 'Sales & POS'),
                  ('INVENTORY', 'Inventory'),
                  ('FINANCE', 'Finance'),
                  ('CRM', 'CRM'),
                ])
                  Chip(
                    avatar: Icon(
                      session.hasModule(module.$1) ? Icons.check_circle : Icons.lock,
                      size: 15,
                      color: session.hasModule(module.$1)
                          ? RautTheme.success
                          : Colors.grey.shade400,
                    ),
                    label: Text(module.$2, style: const TextStyle(fontSize: 12)),
                    backgroundColor: session.hasModule(module.$1)
                        ? RautTheme.success.withValues(alpha: 0.1)
                        : Colors.grey.shade100,
                  ),
              ],
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
            child: Text(
              'Locked features are not part of your company\'s subscription.',
              style: TextStyle(fontSize: 11.5, color: Colors.grey.shade600),
            ),
          ),

          const Divider(),
          _SectionLabel('Account'),
          ListTile(
            leading: const Icon(Icons.dns_outlined),
            title: const Text('Server'),
            subtitle: Text(AppConfig.apiBase, style: const TextStyle(fontSize: 12)),
          ),
          ListTile(
            leading: const Icon(Icons.logout, color: RautTheme.danger),
            title: const Text(
              'Sign out',
              style: TextStyle(color: RautTheme.danger),
            ),
            onTap: () => _signOut(context),
          ),
          const SizedBox(height: 32),
        ],
      ),
    );
  }

  /// Signing out wipes the local store, so unsynced work must be surfaced
  /// before it is destroyed — this is the one place the app can lose data.
  Future<void> _signOut(BuildContext context) async {
    final auth = context.read<AuthService>();
    final sync = context.read<SyncService>();

    final signedOut = await auth.signOut();
    if (signedOut || !context.mounted) return;

    final pending = sync.status.pendingCount;
    final force = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        icon: const Icon(Icons.warning_amber_rounded,
            color: RautTheme.danger, size: 36),
        title: const Text('You have unsynced work'),
        content: Text(
          '$pending item(s) have not reached the office yet. Signing out '
          'deletes them from this phone permanently.\n\n'
          'Sync first if you have any signal.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Cancel'),
          ),
          TextButton(
            onPressed: () {
              Navigator.pop(context, false);
              sync.sync(reason: 'before-signout');
            },
            child: const Text('Try syncing'),
          ),
          TextButton(
            style: TextButton.styleFrom(foregroundColor: RautTheme.danger),
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Sign out anyway'),
          ),
        ],
      ),
    );

    if (force == true) await auth.signOut(force: true);
  }
}

class _SectionLabel extends StatelessWidget {
  const _SectionLabel(this.text);
  final String text;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
      child: Text(
        text.toUpperCase(),
        style: TextStyle(
          fontSize: 11,
          letterSpacing: 1,
          fontWeight: FontWeight.w700,
          color: Colors.grey.shade500,
        ),
      ),
    );
  }
}

/// The queue, made visible. A rep who cannot see what is outstanding has no
/// way to tell the office what did and did not go through.
class _SyncQueueScreen extends StatefulWidget {
  const _SyncQueueScreen();

  @override
  State<_SyncQueueScreen> createState() => _SyncQueueScreenState();
}

class _SyncQueueScreenState extends State<_SyncQueueScreen> {
  late Future<List<OutboxEntry>> _future;

  @override
  void initState() {
    super.initState();
    _future = context.read<Outbox>().recent();
  }

  /// Block body, not an arrow — an arrow returns the assigned Future and
  /// setState asserts when its callback returns one.
  void _reload() {
    final next = context.read<Outbox>().recent();
    setState(() {
      _future = next;
    });
  }

  @override
  Widget build(BuildContext context) {
    final sync = context.watch<SyncService>();

    return Scaffold(
      appBar: AppBar(
        title: const Text('Sync queue'),
        actions: [
          IconButton(
            icon: const Icon(Icons.sync),
            onPressed: sync.status.isBusy
                ? null
                : () async {
                    await sync.sync(reason: 'queue-screen');
                    _reload();
                  },
          ),
        ],
      ),
      body: FutureBuilder<List<OutboxEntry>>(
        future: _future,
        builder: (context, snapshot) {
          final entries = snapshot.data;
          if (entries == null) {
            return const Center(child: CircularProgressIndicator());
          }
          if (entries.isEmpty) {
            return Center(
              child: Padding(
                padding: const EdgeInsets.all(32),
                child: Text(
                  'Nothing in the queue. Everything you have done has reached '
                  'the office.',
                  textAlign: TextAlign.center,
                  style: TextStyle(color: Colors.grey.shade600, height: 1.4),
                ),
              ),
            );
          }

          return ListView.separated(
            itemCount: entries.length,
            separatorBuilder: (_, __) => const Divider(height: 1),
            itemBuilder: (context, index) {
              final entry = entries[index];
              return ListTile(
                leading: Icon(
                  entry.isPending
                      ? (entry.isStuck ? Icons.error_outline : Icons.schedule)
                      : Icons.check_circle_outline,
                  color: entry.isPending
                      ? (entry.isStuck ? RautTheme.danger : RautTheme.warning)
                      : RautTheme.success,
                ),
                title: Text(entry.label),
                subtitle: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      DateFormat('d MMM, h:mm a').format(entry.createdAt),
                      style: const TextStyle(fontSize: 12),
                    ),
                    if (entry.lastError != null)
                      Text(
                        entry.lastError!,
                        style: const TextStyle(
                          fontSize: 11.5,
                          color: RautTheme.danger,
                        ),
                      ),
                  ],
                ),
                trailing: entry.isStuck
                    ? TextButton(
                        onPressed: () async {
                          await context.read<Outbox>().discard(entry.uuid);
                          await sync.refreshCounts();
                          _reload();
                        },
                        child: const Text('Discard'),
                      )
                    : null,
              );
            },
          );
        },
      ),
    );
  }
}

class _ExpenseScreen extends StatefulWidget {
  const _ExpenseScreen();

  @override
  State<_ExpenseScreen> createState() => _ExpenseScreenState();
}

class _ExpenseScreenState extends State<_ExpenseScreen> {
  final _description = TextEditingController();
  final _amount = TextEditingController();
  String? _categoryId;
  String _method = 'CASH';
  List<Map<String, Object?>> _categories = const [];
  bool _saving = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _description.dispose();
    _amount.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    final categories = await context.read<FieldRepository>().expenseCategories();
    if (mounted) setState(() => _categories = categories);
  }

  Future<void> _save() async {
    final parsed = double.tryParse(_amount.text.trim());
    if (parsed == null || parsed <= 0 || _description.text.trim().isEmpty) return;

    setState(() => _saving = true);
    final location = context.read<LocationService>();

    await context.read<FieldRepository>().createExpense(
          description: _description.text.trim(),
          amountCents: Money.toCents(parsed),
          categoryId: _categoryId,
          paymentMethod: _method,
          latitude: location.lastPosition?.latitude,
          longitude: location.lastPosition?.longitude,
        );

    if (!mounted) return;
    Navigator.pop(context);
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(
        content: Text('Claim submitted for approval'),
        behavior: SnackBarBehavior.floating,
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Expense claim')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          TextField(
            controller: _description,
            autofocus: true,
            decoration: const InputDecoration(labelText: 'What was it for? *'),
          ),
          const SizedBox(height: 14),
          TextField(
            controller: _amount,
            keyboardType: const TextInputType.numberWithOptions(decimal: true),
            decoration: const InputDecoration(
              labelText: 'Amount *',
              prefixText: 'KES  ',
            ),
          ),
          const SizedBox(height: 14),
          if (_categories.isNotEmpty)
            DropdownButtonFormField<String>(
              initialValue: _categoryId,
              decoration: const InputDecoration(labelText: 'Category'),
              items: _categories
                  .map(
                    (c) => DropdownMenuItem(
                      value: c['id'] as String,
                      child: Text(c['name'] as String),
                    ),
                  )
                  .toList(),
              onChanged: (v) => setState(() => _categoryId = v),
            ),
          const SizedBox(height: 14),
          Wrap(
            spacing: 8,
            children: const {'CASH': 'Cash', 'MPESA': 'M-Pesa', 'PETTY_CASH': 'Petty cash'}
                .entries
                .map(
                  (e) => ChoiceChip(
                    label: Text(e.value),
                    selected: _method == e.key,
                    onSelected: (_) => setState(() => _method = e.key),
                  ),
                )
                .toList(),
          ),
          const SizedBox(height: 24),
          FilledButton(
            onPressed: _saving ? null : _save,
            child: Text(_saving ? 'Saving…' : 'Submit claim'),
          ),
          const SizedBox(height: 12),
          Text(
            'Your current location is attached to the claim, and it will sync '
            'for your manager to approve.',
            style: TextStyle(fontSize: 12, color: Colors.grey.shade600),
          ),
        ],
      ),
    );
  }
}

