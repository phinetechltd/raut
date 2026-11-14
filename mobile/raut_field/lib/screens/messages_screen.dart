import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../core/auth_service.dart';
import '../core/sync_service.dart';
import '../data/field_repository.dart';
import '../models/models.dart';
import '../theme.dart';

const messagesLastReadKey = 'messages_last_read';

/// The rep's conversation with the office. Offline-first: a message shows at
/// once and syncs through the outbox like any other field write.
class MessagesScreen extends StatefulWidget {
  const MessagesScreen({super.key});

  @override
  State<MessagesScreen> createState() => _MessagesScreenState();
}

class _MessagesScreenState extends State<MessagesScreen> {
  final _input = TextEditingController();
  late Future<List<ChatMessage>> _future;
  bool _sending = false;

  @override
  void initState() {
    super.initState();
    _future = _load();
    _markRead();
  }

  @override
  void dispose() {
    _input.dispose();
    super.dispose();
  }

  Future<List<ChatMessage>> _load() => context.read<FieldRepository>().chatMessages();

  Future<void> _markRead() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(messagesLastReadKey, DateTime.now().toUtc().toIso8601String());
  }

  void _reload() => setState(() => _future = _load());

  Future<void> _send() async {
    final body = _input.text.trim();
    if (body.isEmpty) return;
    // Capture providers before the await so no BuildContext is used across it.
    final session = context.read<AuthService>().session!;
    final repo = context.read<FieldRepository>();
    final sync = context.read<SyncService>();
    setState(() => _sending = true);
    await repo.sendChatMessage(senderId: session.userId, body: body);
    _input.clear();
    if (mounted) setState(() => _sending = false);
    _reload();
    // Nudge a sync so the office sees it soon, if there is signal.
    sync.sync(reason: 'message-sent');
  }

  @override
  Widget build(BuildContext context) {
    final session = context.watch<AuthService>().session!;
    return Scaffold(
      appBar: AppBar(title: const Text('Messages')),
      body: Column(
        children: [
          Expanded(
            child: RefreshIndicator(
              onRefresh: () async {
                await context.read<SyncService>().sync(reason: 'messages-pull');
                await _markRead();
                _reload();
              },
              child: FutureBuilder<List<ChatMessage>>(
                future: _future,
                builder: (context, snap) {
                  final msgs = snap.data;
                  if (msgs == null) return const Center(child: CircularProgressIndicator());
                  if (msgs.isEmpty) {
                    return ListView(children: [
                      const SizedBox(height: 120),
                      Center(
                        child: Padding(
                          padding: const EdgeInsets.all(32),
                          child: Text(
                            'No messages yet. Write to the office below; it sends when you have signal.',
                            textAlign: TextAlign.center,
                            style: TextStyle(color: Colors.grey.shade600, height: 1.4),
                          ),
                        ),
                      ),
                    ]);
                  }
                  return ListView.builder(
                    padding: const EdgeInsets.all(12),
                    itemCount: msgs.length,
                    itemBuilder: (context, i) {
                      final m = msgs[i];
                      final mine = m.senderId == session.userId;
                      return Align(
                        alignment: mine ? Alignment.centerRight : Alignment.centerLeft,
                        child: Container(
                          margin: const EdgeInsets.symmetric(vertical: 3),
                          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                          constraints: BoxConstraints(maxWidth: MediaQuery.of(context).size.width * 0.78),
                          decoration: BoxDecoration(
                            color: mine ? RautTheme.brand.withValues(alpha: 0.12) : Colors.grey.shade100,
                            borderRadius: BorderRadius.circular(12),
                          ),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              if (m.isBroadcast)
                                const Padding(
                                  padding: EdgeInsets.only(bottom: 2),
                                  child: Text('Broadcast', style: TextStyle(fontSize: 10, fontWeight: FontWeight.w700, color: RautTheme.brand)),
                                ),
                              Text(m.body),
                              Text(
                                '${DateFormat('d MMM, h:mm a').format(m.createdAt.toLocal())}${m.pending ? ' · sending' : ''}',
                                style: TextStyle(fontSize: 10, color: Colors.grey.shade500),
                              ),
                            ],
                          ),
                        ),
                      );
                    },
                  );
                },
              ),
            ),
          ),
          SafeArea(
            top: false,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(12, 6, 12, 10),
              child: Row(
                children: [
                  Expanded(
                    child: TextField(
                      controller: _input,
                      minLines: 1,
                      maxLines: 4,
                      decoration: const InputDecoration(hintText: 'Message the office…', border: OutlineInputBorder()),
                    ),
                  ),
                  const SizedBox(width: 8),
                  FilledButton(
                    onPressed: _sending ? null : _send,
                    child: const Icon(Icons.send, size: 18),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}
