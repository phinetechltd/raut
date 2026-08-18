import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../core/auth_service.dart';
import '../core/location_service.dart';
import '../core/sync_service.dart';
import '../data/field_repository.dart';
import '../widgets/sync_banner.dart';
import 'customers_screen.dart';
import 'more_screen.dart';
import 'route_screen.dart';

/// The app's four destinations. Deliberately few: a rep working one-handed on
/// a doorstep should never have to hunt for the thing they need next.
class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  int _index = 0;

  @override
  void initState() {
    super.initState();
    // Start breadcrumb capture once the rep is signed in. Failure is silent —
    // a declined permission must not block the day's work.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) context.read<LocationService>().startTracking();
    });
  }

  @override
  Widget build(BuildContext context) {
    final auth = context.watch<AuthService>();
    final session = auth.session;
    if (session == null) return const SizedBox.shrink();

    final pages = [
      const RouteScreen(),
      const CustomersScreen(),
      const _TodayScreen(),
      const MoreScreen(),
    ];

    return Scaffold(
      body: Column(
        children: [
          const SyncBanner(),
          Expanded(child: pages[_index]),
        ],
      ),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _index,
        onDestinationSelected: (i) => setState(() => _index = i),
        destinations: const [
          NavigationDestination(
            icon: Icon(Icons.route_outlined),
            selectedIcon: Icon(Icons.route),
            label: 'Route',
          ),
          NavigationDestination(
            icon: Icon(Icons.storefront_outlined),
            selectedIcon: Icon(Icons.storefront),
            label: 'Customers',
          ),
          NavigationDestination(
            icon: Icon(Icons.insights_outlined),
            selectedIcon: Icon(Icons.insights),
            label: 'Today',
          ),
          NavigationDestination(
            icon: Icon(Icons.more_horiz),
            label: 'More',
          ),
        ],
      ),
    );
  }
}

/// The rep's own scorecard for the day.
class _TodayScreen extends StatelessWidget {
  const _TodayScreen();

  @override
  Widget build(BuildContext context) {
    final repo = context.watch<FieldRepository>();
    final sync = context.watch<SyncService>();
    final session = context.watch<AuthService>().session!;

    return Scaffold(
      appBar: AppBar(title: const Text('Today')),
      body: RefreshIndicator(
        onRefresh: () => sync.sync(reason: 'pull-to-refresh'),
        child: FutureBuilder<DaySummary>(
          future: repo.todaySummary(),
          builder: (context, snapshot) {
            final s = snapshot.data;
            if (s == null) {
              return const Center(child: CircularProgressIndicator());
            }

            return ListView(
              padding: const EdgeInsets.all(16),
              children: [
                Text(
                  'Good work, ${session.firstName}',
                  style: const TextStyle(fontSize: 22, fontWeight: FontWeight.w700),
                ),
                Text(
                  session.companyName,
                  style: TextStyle(color: Colors.grey.shade600),
                ),
                const SizedBox(height: 20),

                Row(
                  children: [
                    Expanded(
                      child: _Metric(
                        label: 'Visits done',
                        value: '${s.visitsDone}/${s.visitsPlanned}',
                        icon: Icons.check_circle_outline,
                      ),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: _Metric(
                        label: session.geofencingEnabled ? 'GPS verified' : 'Remaining',
                        value: session.geofencingEnabled
                            ? '${s.visitsVerified}'
                            : '${s.visitsRemaining}',
                        icon: session.geofencingEnabled
                            ? Icons.verified_outlined
                            : Icons.pending_outlined,
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 12),
                Row(
                  children: [
                    Expanded(
                      child: _Metric(
                        label: 'Orders',
                        value: '${s.ordersCount}',
                        icon: Icons.receipt_long_outlined,
                      ),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: _Metric(
                        label: 'Collected',
                        value: _short(s.collectionsCents),
                        icon: Icons.payments_outlined,
                      ),
                    ),
                  ],
                ),

                const SizedBox(height: 20),
                Card(
                  child: Padding(
                    padding: const EdgeInsets.all(16),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(
                          children: [
                            Icon(
                              sync.status.hasPending
                                  ? Icons.cloud_upload_outlined
                                  : Icons.cloud_done_outlined,
                              color: sync.status.hasPending
                                  ? Colors.orange
                                  : Colors.green,
                            ),
                            const SizedBox(width: 10),
                            Expanded(
                              child: Text(
                                sync.status.hasPending
                                    ? '${sync.status.pendingCount} item(s) waiting to sync'
                                    : 'All your work has been sent',
                                style: const TextStyle(fontWeight: FontWeight.w600),
                              ),
                            ),
                          ],
                        ),
                        if (sync.status.lastSyncedAt != null) ...[
                          const SizedBox(height: 6),
                          Text(
                            'Last synced ${_ago(sync.status.lastSyncedAt!)}',
                            style: TextStyle(
                              fontSize: 12,
                              color: Colors.grey.shade600,
                            ),
                          ),
                        ],
                        const SizedBox(height: 12),
                        OutlinedButton.icon(
                          onPressed: sync.status.isBusy
                              ? null
                              : () => sync.sync(reason: 'manual'),
                          icon: const Icon(Icons.sync),
                          label: Text(sync.status.isBusy ? 'Syncing…' : 'Sync now'),
                        ),
                      ],
                    ),
                  ),
                ),
              ],
            );
          },
        ),
      ),
    );
  }

  static String _short(int cents) {
    final v = cents / 100;
    if (v >= 1000000) return 'KES ${(v / 1000000).toStringAsFixed(1)}M';
    if (v >= 1000) return 'KES ${(v / 1000).toStringAsFixed(1)}K';
    return 'KES ${v.toStringAsFixed(0)}';
  }

  static String _ago(DateTime time) {
    final diff = DateTime.now().difference(time);
    if (diff.inMinutes < 1) return 'just now';
    if (diff.inMinutes < 60) return '${diff.inMinutes} min ago';
    if (diff.inHours < 24) return '${diff.inHours} h ago';
    return '${diff.inDays} d ago';
  }
}

class _Metric extends StatelessWidget {
  const _Metric({required this.label, required this.value, required this.icon});

  final String label;
  final String value;
  final IconData icon;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(icon, size: 20, color: Colors.grey.shade500),
            const SizedBox(height: 10),
            Text(
              value,
              style: const TextStyle(fontSize: 22, fontWeight: FontWeight.w700),
            ),
            Text(
              label,
              style: TextStyle(fontSize: 12, color: Colors.grey.shade600),
            ),
          ],
        ),
      ),
    );
  }
}
