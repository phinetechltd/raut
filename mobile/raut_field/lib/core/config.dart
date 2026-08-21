/// Build-time configuration.
///
/// The API base is a `--dart-define` so the same binary can point at a local
/// dev server, staging, or production without a code change:
///
///   flutter run --dart-define=RAUT_API_BASE=http://10.0.2.2:3200
///
/// **The default is production**, deliberately. It used to be the emulator's
/// host loopback (10.0.2.2), which meant a release build made without the flag
/// shipped pointing at a server that exists only on a developer's laptop — the
/// app would install, open, and simply never sign anyone in. Defaulting the
/// other way makes the dangerous case the one you have to ask for: a developer
/// overriding to localhost notices immediately, a rep with a misbuilt APK does
/// not.
///
/// Inside the Android emulator, note that `localhost` resolves to the emulator
/// itself; the host is reachable at 10.0.2.2, which is the single most common
/// cause of "the app can't reach the server" during setup.
class AppConfig {
  const AppConfig._();

  static const String apiBase = String.fromEnvironment(
    'RAUT_API_BASE',
    defaultValue: 'https://raut.co.ke',
  );

  /// True when this build talks to something other than production — surfaced
  /// on the login screen so a tester can tell at a glance which server their
  /// orders are landing in.
  static bool get isProduction => apiBase == 'https://raut.co.ke';

  static String get apiV1 => '$apiBase/api/v1';

  static const String appVersion = '1.0.0';

  /// How often the background location sampler records a fix while a route is
  /// active. Ten metres is fine-grained enough to reconstruct a rep's day
  /// without flattening the battery.
  static const int locationDistanceFilterM = 10;

  /// Cap on breadcrumbs held locally before the oldest are dropped. A day of
  /// tracking is worth keeping offline; a fortnight is not.
  static const int maxBufferedPings = 2000;

  /// Auto-sync debounce after connectivity returns, so a flapping connection
  /// does not trigger a stampede of pushes.
  static const Duration reconnectDebounce = Duration(seconds: 4);

  /// Periodic sync attempt while the app is foregrounded and online.
  static const Duration syncInterval = Duration(minutes: 5);
}
