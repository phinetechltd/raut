import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';

import '../data/field_repository.dart';
import '../models/models.dart';
import '../theme.dart';

/// The rep's CRM tasks: follow-ups assigned from the office or raised in the
/// field. Completing one is an offline write like any other — it syncs later.
class TasksScreen extends StatefulWidget {
  const TasksScreen({super.key});

  @override
  State<TasksScreen> createState() => _TasksScreenState();
}

class _TasksScreenState extends State<TasksScreen> {
  bool _openOnly = true;
  late Future<List<Task>> _future;

  @override
  void initState() {
    super.initState();
    _future = _load();
  }

  Future<List<Task>> _load() => context.read<FieldRepository>().tasks(openOnly: _openOnly);

  void _reload() => setState(() => _future = _load());

  Future<void> _toggle(Task t) async {
    await context.read<FieldRepository>().setTaskStatus(t.id, t.isDone ? 'OPEN' : 'DONE');
    _reload();
  }

  Future<void> _add() async {
    final created = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      builder: (_) => const _NewTaskSheet(),
    );
    if (created == true) _reload();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Tasks'),
        actions: [
          TextButton(
            onPressed: () => setState(() {
              _openOnly = !_openOnly;
              _future = _load();
            }),
            child: Text(_openOnly ? 'Show all' : 'Open only'),
          ),
        ],
      ),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: _add,
        icon: const Icon(Icons.add),
        label: const Text('New task'),
      ),
      body: RefreshIndicator(
        onRefresh: () async => _reload(),
        child: FutureBuilder<List<Task>>(
          future: _future,
          builder: (context, snap) {
            final tasks = snap.data;
            if (tasks == null) {
              return const Center(child: CircularProgressIndicator());
            }
            if (tasks.isEmpty) {
              return ListView(
                children: [
                  const SizedBox(height: 80),
                  EmptyState(
                    icon: Icons.checklist_rounded,
                    title: _openOnly ? 'No open tasks' : 'No tasks yet',
                    message: _openOnly ? 'New follow-ups appear here after a sync.' : null,
                  ),
                ],
              );
            }
            return ListView.separated(
              itemCount: tasks.length,
              separatorBuilder: (_, _) => const Divider(height: 1),
              itemBuilder: (context, i) {
                final t = tasks[i];
                return CheckboxListTile(
                  value: t.isDone,
                  onChanged: (_) => _toggle(t),
                  controlAffinity: ListTileControlAffinity.leading,
                  title: Text(
                    t.title,
                    style: TextStyle(
                      decoration: t.isDone ? TextDecoration.lineThrough : null,
                      color: t.isDone ? Colors.grey : null,
                    ),
                  ),
                  subtitle: _subtitle(t),
                  secondary: t.priority == 'HIGH'
                      ? const Icon(Icons.flag, color: RautTheme.danger, size: 18)
                      : null,
                );
              },
            );
          },
        ),
      ),
    );
  }

  Widget? _subtitle(Task t) {
    final bits = <Widget>[];
    if (t.dueAt != null) {
      bits.add(Text(
        'Due ${DateFormat('d MMM').format(t.dueAt!.toLocal())}',
        style: TextStyle(
          fontSize: 12,
          color: t.isOverdue ? RautTheme.danger : RautTheme.textMuted,
          fontWeight: t.isOverdue ? FontWeight.w600 : FontWeight.normal,
        ),
      ));
    }
    if (t.description != null && t.description!.isNotEmpty) {
      bits.add(Text(t.description!, style: const TextStyle(fontSize: 12), maxLines: 1, overflow: TextOverflow.ellipsis));
    }
    if (bits.isEmpty) return null;
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: bits);
  }
}

class _NewTaskSheet extends StatefulWidget {
  const _NewTaskSheet();

  @override
  State<_NewTaskSheet> createState() => _NewTaskSheetState();
}

class _NewTaskSheetState extends State<_NewTaskSheet> {
  final _title = TextEditingController();
  String _priority = 'NORMAL';
  DateTime? _due;
  bool _saving = false;

  @override
  void dispose() {
    _title.dispose();
    super.dispose();
  }

  Future<void> _pickDue() async {
    final now = DateTime.now();
    final picked = await showDatePicker(
      context: context,
      initialDate: _due ?? now,
      firstDate: now.subtract(const Duration(days: 1)),
      lastDate: now.add(const Duration(days: 365)),
    );
    if (picked != null) setState(() => _due = picked);
  }

  Future<void> _save() async {
    if (_title.text.trim().isEmpty) return;
    setState(() => _saving = true);
    await context.read<FieldRepository>().createTask(
          title: _title.text.trim(),
          dueAt: _due,
          priority: _priority,
        );
    if (!mounted) return;
    Navigator.pop(context, true);
  }

  @override
  Widget build(BuildContext context) {
    final bottom = MediaQuery.of(context).viewInsets.bottom;
    return Padding(
      padding: EdgeInsets.fromLTRB(16, 16, 16, 16 + bottom),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text('New task', style: TextStyle(fontSize: 16, fontWeight: FontWeight.w700)),
          const SizedBox(height: 12),
          TextField(
            controller: _title,
            autofocus: true,
            decoration: const InputDecoration(labelText: 'What needs doing? *'),
          ),
          const SizedBox(height: 12),
          Row(
            children: [
              Expanded(
                child: OutlinedButton.icon(
                  onPressed: _pickDue,
                  icon: const Icon(Icons.event, size: 18),
                  label: Text(_due == null ? 'Set due date' : DateFormat('d MMM').format(_due!)),
                ),
              ),
              const SizedBox(width: 8),
              DropdownButton<String>(
                value: _priority,
                items: const [
                  DropdownMenuItem(value: 'LOW', child: Text('Low')),
                  DropdownMenuItem(value: 'NORMAL', child: Text('Normal')),
                  DropdownMenuItem(value: 'HIGH', child: Text('High')),
                ],
                onChanged: (v) => setState(() => _priority = v ?? 'NORMAL'),
              ),
            ],
          ),
          const SizedBox(height: 16),
          FilledButton(
            onPressed: _saving ? null : _save,
            child: Text(_saving ? 'Saving…' : 'Add task'),
          ),
        ],
      ),
    );
  }
}
