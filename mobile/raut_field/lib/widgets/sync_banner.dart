import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../core/sync_service.dart';
import '../theme.dart';

/// Persistent connection and queue indicator.
///
/// A field rep needs to know, without asking, whether the order they just took
/// has reached the office. Hiding that state is how disputes start — so the
/// banner is always visible when there is anything to say, and silent when
/// everything is genuinely clear.
class SyncBanner extends StatelessWidget {
  const SyncBanner({super.key});

  @override
  Widget build(BuildContext context) {
    final status = context.watch<SyncService>().status;

    // Nothing to report: online, nothing queued, not mid-sync.
    if (status.online && !status.hasPending && !status.isBusy) {
      return const SizedBox.shrink();
    }

    final (Color color, IconData icon, String message) = switch (status) {
      _ when !status.online && status.hasPending => (
          RautTheme.warning,
          Icons.cloud_off,
          'Offline — ${status.pendingCount} item(s) saved on this phone',
        ),
      _ when !status.online => (
          Colors.blueGrey,
          Icons.cloud_off,
          'Offline — you can keep working',
        ),
      _ when status.isBusy => (
          RautTheme.brand,
          Icons.sync,
          status.message ?? 'Syncing…',
        ),
      _ => (
          RautTheme.warning,
          Icons.cloud_upload_outlined,
          '${status.pendingCount} item(s) waiting to sync',
        ),
    };

    return Material(
      color: color.withValues(alpha: 0.12),
      child: InkWell(
        onTap: status.isBusy
            ? null
            : () => context.read<SyncService>().sync(reason: 'banner-tap'),
        child: SafeArea(
          bottom: false,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 9),
            child: Row(
              children: [
                if (status.isBusy)
                  SizedBox(
                    height: 14,
                    width: 14,
                    child: CircularProgressIndicator(strokeWidth: 2, color: color),
                  )
                else
                  Icon(icon, size: 16, color: color),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(
                    message,
                    style: TextStyle(
                      color: color,
                      fontSize: 12.5,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
                if (status.stuckCount > 0)
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                    decoration: BoxDecoration(
                      color: RautTheme.danger.withValues(alpha: 0.15),
                      borderRadius: BorderRadius.circular(10),
                    ),
                    child: Text(
                      '${status.stuckCount} stuck',
                      style: const TextStyle(
                        color: RautTheme.danger,
                        fontSize: 11,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                  )
                else if (!status.isBusy)
                  Text(
                    'Tap to retry',
                    style: TextStyle(
                      color: color,
                      fontSize: 11.5,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

