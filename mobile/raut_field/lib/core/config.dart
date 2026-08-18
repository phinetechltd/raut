/// Build-time configuration.
///
/// The API base is a `--dart-define` so the same binary can point at a local
/// dev server, staging, or production without a code change:
///
///   flutter run --dart-define=RAUT_API_BASE=http://10.0.2.2:3200
///
/// The default is the Android emulator's host loopback (10.0.2.2), because
/// that is where this app is developed against; `localhost` inside the emulator
/// resolves to the emulator itself, which is the single most common cause of
/// "the app can't reach the server" during setup.
class AppConfig {
  const AppConfig._();

  static const String apiBase = String.fromEnvironment(
    'RAUT_API_BASE',
    defaultValue: 'http://10.0.2.2:3200',
  );

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
