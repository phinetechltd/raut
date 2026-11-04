import 'dart:async';
import 'dart:io' show Platform;

import 'package:battery_plus/battery_plus.dart';
import 'package:flutter/foundation.dart';
import 'package:geolocator/geolocator.dart';

import 'config.dart';
import 'local_db.dart';

/// GPS acquisition and background breadcrumb capture.
///
/// Two distinct jobs, kept separate because they have different failure modes:
///
///  * `currentPosition()` is a foreground, user-initiated fix for a check-in.
///    It must fail loudly — a rep needs to know why they cannot check in.
///  * The breadcrumb stream is passive telemetry. It must fail silently and
///    never interrupt the rep; a missing trail is an inconvenience, a crash
///    mid-visit is not.
///
/// The trail is what the office's live-tracking map draws, so three things
/// matter for it that did not for check-in alone:
///
///  * **It keeps going with the phone in a pocket.** On Android the stream runs
///    inside a foreground service with a persistent notification, which is the
///    only arrangement the OS lets live past a few minutes in the background.
///  * **A parked van still reports.** The distance filter alone falls silent
///    the moment the van stops, and a rep stuck in traffic for forty minutes
///    looked, to the office, like a phone that had died. A heartbeat re-records
///    the last fix once a minute while stationary.
///  * **The battery level rides along**, so the office can tell a dead handset
///    from a rep who has stopped.
class LocationService extends ChangeNotifier {
  LocationService(this._db, {Battery? battery}) : _battery = battery ?? Battery();

  final LocalDb _db;
  final Battery _battery;

  StreamSubscription<Position>? _stream;
  Timer? _heartbeat;
  Position? _last;
  DateTime? _lastRecordedAt;
  bool _tracking = false;
  String? _error;

  int? _batteryPct;
  DateTime? _batteryReadAt;

  Position? get lastPosition => _last;
  bool get isTracking => _tracking;
  String? get error => _error;

  /// Last battery reading sent with a breadcrumb, for the status screen.
  int? get batteryPct => _batteryPct;

  /// Ensures the app may read location, walking the rep through the OS prompts.
  /// Returns null on success, or a message explaining what to fix.
  ///
  /// With `background: true` it goes on to ask for "allow all the time". The
  /// OS only offers that choice once "while in use" is held, so it is a second
  /// request, never the first — and declining it is genuinely fine: the rep can
  /// still check in, they just produce a trail only while the app is open.
  Future<String?> ensurePermission({bool background = false}) async {
    if (!await Geolocator.isLocationServiceEnabled()) {
      return 'Location is switched off. Turn on GPS to check in to visits.';
    }

    var permission = await Geolocator.checkPermission();
    if (permission == LocationPermission.denied) {
      permission = await Geolocator.requestPermission();
    }

    if (permission == LocationPermission.denied) {
      return 'Location permission is required to verify visits.';
    }
    if (permission == LocationPermission.deniedForever) {
      return 'Location permission was permanently denied. Enable it in system settings.';
    }

    if (background && permission == LocationPermission.whileInUse) {
      try {
        // Android 10+ and iOS show the "always" option on a repeat request
        // once "while in use" is granted. Whatever the answer, tracking starts:
        // the foreground service keeps the trail alive on Android either way.
        await Geolocator.requestPermission();
      } catch (_) {
        // Some OEM builds throw here when the dialog cannot be shown; the
        // trail then runs on the permission already held.
      }
    }
    return null;
  }

  /// A single fix for check-in. Deliberately not cached — an old fix would
  /// verify a visit the rep is not actually at.
  Future<Position> currentPosition({
    LocationAccuracy accuracy = LocationAccuracy.high,
    Duration timeout = const Duration(seconds: 20),
  }) async {
    final problem = await ensurePermission();
    if (problem != null) throw LocationException(problem);

    try {
      final position = await Geolocator.getCurrentPosition(
        locationSettings: LocationSettings(accuracy: accuracy, timeLimit: timeout),
      );
      _last = position;
      notifyListeners();
      return position;
    } on TimeoutException {
      throw LocationException(
        'Could not get a GPS fix. Move outside or away from tall buildings and try again.',
      );
    }
  }

  /// Platform settings for the breadcrumb stream.
  ///
  /// Android gets the foreground-service notification and the interval
  /// heartbeat; iOS gets the blue background indicator and is told not to pause
  /// updates on its own. Anything else runs the plain stream (tests, desktop).
  static LocationSettings trackingSettings() {
    if (!kIsWeb && Platform.isAndroid) {
      return AndroidSettings(
        accuracy: LocationAccuracy.high,
        distanceFilter: AppConfig.locationDistanceFilterM,
        intervalDuration: AppConfig.locationHeartbeat,
        forceLocationManager: false,
        foregroundNotificationConfig: const ForegroundNotificationConfig(
          notificationTitle: 'Raut Field Sales',
          notificationText: 'Recording your route for today',
          notificationChannelName: 'Route tracking',
          enableWakeLock: true,
          setOngoing: true,
        ),
      );
    }
    if (!kIsWeb && Platform.isIOS) {
      return AppleSettings(
        accuracy: LocationAccuracy.high,
        distanceFilter: AppConfig.locationDistanceFilterM,
        pauseLocationUpdatesAutomatically: false,
        showBackgroundLocationIndicator: true,
        activityType: ActivityType.automotiveNavigation,
      );
    }
    return LocationSettings(
      accuracy: LocationAccuracy.high,
      distanceFilter: AppConfig.locationDistanceFilterM,
    );
  }

  /// Starts breadcrumb capture for the working day.
  Future<void> startTracking() async {
    if (_tracking) return;

    final problem = await ensurePermission(background: true);
    if (problem != null) {
      _error = problem;
      notifyListeners();
      return;
    }

    _stream = Geolocator.getPositionStream(locationSettings: trackingSettings()).listen(
      _record,
      onError: (Object error) {
        _error = error.toString();
        notifyListeners();
      },
      cancelOnError: false,
    );

    // The heartbeat: if the stream has gone quiet for a whole interval, the
    // van is standing still and the last fix is re-recorded as "still here".
    _heartbeat?.cancel();
    _heartbeat = Timer.periodic(AppConfig.locationHeartbeat, (_) => _pulse());

    _tracking = true;
    _error = null;
    notifyListeners();
  }

  Future<void> stopTracking() async {
    await _stream?.cancel();
    _stream = null;
    _heartbeat?.cancel();
    _heartbeat = null;
    _tracking = false;
    notifyListeners();
  }

  Future<void> _pulse() async {
    final last = _last;
    final at = _lastRecordedAt;
    if (last == null || at == null) return;
    if (DateTime.now().difference(at) < AppConfig.locationHeartbeat) return;
    await _store(
      latitude: last.latitude,
      longitude: last.longitude,
      accuracyM: last.accuracy,
      speedMps: 0,
      heading: last.heading,
      isMoving: false,
      recordedAt: DateTime.now().toUtc(),
    );
  }

  Future<void> _record(Position position) async {
    _last = position;
    notifyListeners();
    await _store(
      latitude: position.latitude,
      longitude: position.longitude,
      accuracyM: position.accuracy,
      speedMps: position.speed,
      heading: position.heading,
      isMoving: position.speed > 0.5,
      recordedAt: position.timestamp.toUtc(),
    );
  }

  Future<void> _store({
    required double latitude,
    required double longitude,
    required double accuracyM,
    required double speedMps,
    required double heading,
    required bool isMoving,
    required DateTime recordedAt,
  }) async {
    try {
      await _db.insert('location_buffer', {
        'latitude': latitude,
        'longitude': longitude,
        'accuracyM': accuracyM,
        'speedMps': speedMps,
        'heading': heading,
        'batteryPct': await _readBattery(),
        'isMoving': isMoving ? 1 : 0,
        'recordedAt': recordedAt.toIso8601String(),
      });
      _lastRecordedAt = DateTime.now();

      // Trim the oldest rather than letting a long offline stretch grow the
      // database without bound.
      final buffered = await _db.count('location_buffer');
      if (buffered > AppConfig.maxBufferedPings) {
        await _db.execute(
          'DELETE FROM location_buffer WHERE id IN '
          '(SELECT id FROM location_buffer ORDER BY recordedAt ASC LIMIT ?)',
          [buffered - AppConfig.maxBufferedPings],
        );
      }
    } catch (_) {
      // Telemetry must never break the rep's session.
    }
  }

  /// Battery level, read at most once a minute — the platform call is not
  /// free and the level does not move faster than that.
  Future<int?> _readBattery() async {
    final now = DateTime.now();
    final readAt = _batteryReadAt;
    if (readAt != null && now.difference(readAt) < AppConfig.locationHeartbeat) {
      return _batteryPct;
    }
    try {
      _batteryPct = await _battery.batteryLevel;
      _batteryReadAt = now;
    } catch (_) {
      // No battery API (desktop, emulator quirks): the field stays empty.
      _batteryReadAt = now;
    }
    return _batteryPct;
  }

  Future<int> bufferedCount() => _db.count('location_buffer');

  @override
  void dispose() {
    _stream?.cancel();
    _heartbeat?.cancel();
    super.dispose();
  }
}

class LocationException implements Exception {
  LocationException(this.message);
  final String message;

  @override
  String toString() => message;
}
