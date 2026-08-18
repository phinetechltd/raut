import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import 'core/api_client.dart';
import 'core/auth_service.dart';
import 'core/local_db.dart';
import 'core/location_service.dart';
import 'core/outbox.dart';
import 'core/sync_service.dart';
import 'data/field_repository.dart';
import 'screens/home_screen.dart';
import 'screens/login_screen.dart';
import 'theme.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(buildRautApp());
}

/// Composes the provider tree over the app.
///
/// Exposed rather than inlined into `main()` so tests can pump the real widget
/// tree — `RautFieldApp` on its own has no providers above it and would throw
/// looking for `AuthService`.
Widget buildRautApp({LocalDb? database, ApiClient? client}) {
  final db = database ?? LocalDb.instance;
  final api = client ?? ApiClient();
  final outbox = Outbox(db);

  return MultiProvider(
    providers: [
      Provider<LocalDb>.value(value: db),
      Provider<ApiClient>.value(value: api),
      Provider<Outbox>.value(value: outbox),
      ChangeNotifierProvider(
        create: (_) => AuthService(api: api, db: db)..restore(),
      ),
      ChangeNotifierProvider(
        create: (_) => SyncService(api: api, db: db, outbox: outbox),
      ),
      ChangeNotifierProvider(
        create: (_) => FieldRepository(db: db, outbox: outbox),
      ),
      ChangeNotifierProvider(create: (_) => LocationService(db)),
    ],
    child: const RautFieldApp(),
  );
}

class RautFieldApp extends StatelessWidget {
  const RautFieldApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Raut Field Sales',
      debugShowCheckedModeBanner: false,
      theme: RautTheme.light(),
      home: const _Root(),
    );
  }
}

/// Decides which screen the app opens on.
///
/// A restored session goes straight to the route: a rep starting their day in
/// an area with no signal must not be blocked by a login form they cannot
/// submit.
class _Root extends StatefulWidget {
  const _Root();

  @override
  State<_Root> createState() => _RootState();
}

class _RootState extends State<_Root> {
  bool _started = false;

  @override
  Widget build(BuildContext context) {
    final auth = context.watch<AuthService>();

    if (auth.isRestoring) {
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }

    if (!auth.isSignedIn) {
      _started = false;
      return const LoginScreen();
    }

    // Start the sync engine once per signed-in session, after the first frame
    // so it cannot interfere with the initial render.
    if (!_started) {
      _started = true;
      WidgetsBinding.instance.addPostFrameCallback((_) async {
        if (!mounted) return;
        final sync = context.read<SyncService>();
        await sync.start();
        await sync.sync(reason: 'startup');
      });
    }

    return const HomeScreen();
  }
}
