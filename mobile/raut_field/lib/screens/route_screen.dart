import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';

import '../core/auth_service.dart';
import '../core/sync_service.dart';
import '../data/field_repository.dart';
import '../models/models.dart';
import '../theme.dart';
import 'visit_screen.dart';

/// Today's itinerary — the screen on proposal page 12.
///
/// Stop order comes from the server's optimiser and is never re-sorted here.
/// A route that reshuffles under the rep as they drive is worse than a
/// suboptimal one they can trust.
class RouteScreen extends StatefulWidget {
  const RouteScreen({super.key});

  @override
  State<RouteScreen> createState() => _RouteScreenState();
}

class _RouteScreenState extends State<RouteScreen> {
  late Future<_RouteData> _future;

  /// Watermark of the sync whose results are already on screen.
  ///
  /// A sync writes straight to the local store; the repository never sees those
  /// writes, so nothing notifies this screen. Without tracking the watermark
  /// the route stays empty after the sign-in sync until the rep pulls to
  /// refresh — on the first screen they ever see.
  DateTime? _renderedSyncAt;

  @override
  void initState() {
    super.initState();
    _future = _load();
  }

  Future<_RouteData> _load() async {
    final repo = context.read<FieldRepository>();
    final route = await repo.todaysRoute();
    final visits = await repo.visitsForDay();

    final customers = <String, Customer>{};
    for (final visit in visits) {
      final c = await repo.customer(visit.customerId);
      if (c != null) customers[visit.customerId] = c;
    }

    return _RouteData(route: route, visits: visits, customers: customers);
  }

  /// Block body, not an arrow: `() => _future = _load()` returns the assigned
  /// Future, and setState asserts when its callback returns one. That fired on
  /// pull-to-refresh and the sync button as well as here.
  void _reload() {
    setState(() {
      _future = _load();
    });
  }

  @override
  Widget build(BuildContext context) {
    final session = context.watch<AuthService>().session!;
    final sync = context.watch<SyncService>();

    // Rebuild when local writes land, so a check-in reflects immediately.
    context.watch<FieldRepository>();

    // Reload once per completed sync. Scheduled after the frame because
    // setState during build is illegal.
    final syncedAt = sync.status.lastSyncedAt;
    if (syncedAt != null && syncedAt != _renderedSyncAt) {
      _renderedSyncAt = syncedAt;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) _reload();
      });
    }

    return Scaffold(
      appBar: AppBar(
        title: const Text("Today's Route"),
        actions: [
          IconButton(
            icon: const Icon(Icons.sync),
            onPressed: sync.status.isBusy
                ? null
                : () async {
                    await sync.sync(reason: 'route-refresh');
                    _reload();
                  },
          ),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: () async {
          await sync.sync(reason: 'pull-to-refresh');
          _reload();
        },
        child: FutureBuilder<_RouteData>(
          future: _future,
          builder: (context, snapshot) {
            if (!snapshot.hasData) {
              return const Center(child: CircularProgressIndicator());
            }

            final data = snapshot.data!;

            if (data.visits.isEmpty) {
              return ListView(
                children: [
                  const SizedBox(height: 80),
                  Icon(Icons.map_outlined, size: 56, color: Colors.grey.shade400),
                  const SizedBox(height: 16),
                  Center(
                    child: Text(
                      'No visits scheduled for today',
                      style: TextStyle(
                        fontSize: 16,
                        fontWeight: FontWeight.w600,
                        color: Colors.grey.shade700,
                      ),
                    ),
                  ),
                  const SizedBox(height: 8),
                  Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 40),
                    child: Text(
                      'Pull down to sync, or start an unplanned visit from the '
                      'Customers tab.',
                      textAlign: TextAlign.center,
                      style: TextStyle(color: Colors.grey.shade600, height: 1.4),
                    ),
                  ),
                ],
              );
            }

            final done = data.visits.where((v) => v.isDone).length;

            return ListView(
              padding: const EdgeInsets.fromLTRB(16, 12, 16, 24),
              children: [
                _RouteHeader(
                  route: data.route,
                  total: data.visits.length,
                  done: done,
                  routingEnabled: session.routingEnabled,
                ),
                const SizedBox(height: 16),
                ...data.visits.asMap().entries.map((entry) {
                  final visit = entry.value;
                  final customer = data.customers[visit.customerId];
                  return Padding(
                    padding: const EdgeInsets.only(bottom: 10),
                    child: _StopCard(
                      sequence: entry.key + 1,
                      visit: visit,
                      customer: customer,
                      geofencingEnabled: session.geofencingEnabled,
                      onTap: () async {
                        await Navigator.of(context).push(
                          MaterialPageRoute(
                            builder: (_) => VisitScreen(visitId: visit.id),
                          ),
                        );
                        _reload();
                      },
                    ),
                  );
                }),
              ],
            );
          },
        ),
      ),
    );
  }
}

class _RouteData {
  const _RouteData({
    required this.route,
    required this.visits,
    required this.customers,
  });

  final FieldRoute? route;
  final List<Visit> visits;
  final Map<String, Customer> customers;
}

class _RouteHeader extends StatelessWidget {
  const _RouteHeader({
    required this.route,
    required this.total,
    required this.done,
    required this.routingEnabled,
  });

  final FieldRoute? route;
  final int total;
  final int done;
  final bool routingEnabled;

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
                  child: Text(
                    route?.name ?? 'Unplanned visits',
                    style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w700),
                  ),
                ),
                if (route != null) StatusChip(route!.status),
              ],
            ),
            const SizedBox(height: 4),
            Text(
              DateFormat('EEEE, d MMMM').format(DateTime.now()),
              style: TextStyle(color: Colors.grey.shade600, fontSize: 13),
            ),
            const SizedBox(height: 16),

            ClipRRect(
              borderRadius: BorderRadius.circular(8),
              child: LinearProgressIndicator(
                value: total == 0 ? 0 : done / total,
                minHeight: 8,
                backgroundColor: Colors.grey.shade200,
                valueColor: const AlwaysStoppedAnimation(RautTheme.success),
              ),
            ),
            const SizedBox(height: 8),
            Row(
              children: [
                Text(
                  '$done of $total stops complete',
                  style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600),
                ),
                const Spacer(),
                if (route != null && routingEnabled)
                  Text(
                    '${route!.distanceKm.toStringAsFixed(1)} km · ~${route!.estimatedMin} min',
                    style: TextStyle(fontSize: 12, color: Colors.grey.shade600),
                  ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _StopCard extends StatelessWidget {
  const _StopCard({
    required this.sequence,
    required this.visit,
    required this.customer,
    required this.geofencingEnabled,
    required this.onTap,
  });

  final int sequence;
  final Visit visit;
  final Customer? customer;
  final bool geofencingEnabled;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final color = RautTheme.statusColor(visit.status);

    return Card(
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(14),
        child: Padding(
          padding: const EdgeInsets.all(14),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Container(
                height: 34,
                width: 34,
                decoration: BoxDecoration(
                  color: color.withValues(alpha: 0.15),
                  shape: BoxShape.circle,
                ),
                alignment: Alignment.center,
                child: visit.isDone
                    ? Icon(Icons.check, size: 18, color: color)
                    : Text(
                        '$sequence',
                        style: TextStyle(
                          color: color,
                          fontWeight: FontWeight.w700,
                        ),
                      ),
              ),
              const SizedBox(width: 12),

              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      customer?.name ?? 'Unknown customer',
                      style: const TextStyle(
                        fontSize: 15,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    const SizedBox(height: 2),
                    Row(
                      children: [
                        Icon(Icons.schedule, size: 13, color: Colors.grey.shade500),
                        const SizedBox(width: 4),
                        Text(
                          DateFormat('h:mm a').format(visit.scheduledAt),
                          style: TextStyle(fontSize: 12.5, color: Colors.grey.shade600),
                        ),
                        if (customer?.town != null) ...[
                          Text(
                            '  ·  ${customer!.town}',
                            style: TextStyle(fontSize: 12.5, color: Colors.grey.shade600),
                          ),
                        ],
                      ],
                    ),

                    if (customer != null && customer!.owesMoney) ...[
                      const SizedBox(height: 6),
                      Row(
                        children: [
                          Icon(
                            Icons.account_balance_wallet_outlined,
                            size: 13,
                            color: customer!.overCreditLimit
                                ? RautTheme.danger
                                : RautTheme.warning,
                          ),
                          const SizedBox(width: 4),
                          Text(
                            'Owes ${_money(customer!.balanceCents)}'
                            '${customer!.overCreditLimit ? ' — over limit' : ''}',
                            style: TextStyle(
                              fontSize: 12,
                              fontWeight: FontWeight.w600,
                              color: customer!.overCreditLimit
                                  ? RautTheme.danger
                                  : RautTheme.warning,
                            ),
                          ),
                        ],
                      ),
                    ],

                    const SizedBox(height: 8),
                    Row(
                      children: [
                        StatusChip(visit.status),
                        if (geofencingEnabled && visit.checkInAt != null) ...[
                          const SizedBox(width: 6),
                          StatusChip(
                            visit.geofenceVerified ? 'VERIFIED' : 'UNVERIFIED',
                            icon: visit.geofenceVerified
                                ? Icons.verified_outlined
                                : Icons.location_off_outlined,
                          ),
                        ],
                        if (visit.dirty) ...[
                          const SizedBox(width: 6),
                          Icon(
                            Icons.cloud_upload_outlined,
                            size: 15,
                            color: Colors.grey.shade500,
                          ),
                        ],
                      ],
                    ),
                  ],
                ),
              ),

              Icon(Icons.chevron_right, color: Colors.grey.shade400),
            ],
          ),
        ),
      ),
    );
  }

  static String _money(int cents) =>
      'KES ${(cents / 100).toStringAsFixed(0)}';
}

