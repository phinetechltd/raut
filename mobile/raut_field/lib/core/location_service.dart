import 'dart:async';

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
class LocationService extends ChangeNotifier {
  LocationService(this._db);

  final LocalDb _db;

  StreamSubscription<Position>? _stream;
  Position? _last;
  bool _tracking = false;
  String? _error;

  Position? get lastPosition => _last;
  bool get isTracking => _tracking;
  String? get error => _error;

  /// Ensures the app may read location, walking the rep through the OS prompts.
  /// Returns null on success, or a message explaining what to fix.
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

    // Background is requested separately and is genuinely optional: a rep who
    // declines it can still check in, they just will not produce a trail.
    if (background && permission == LocationPermission.whileInUse) {
      return null;
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

  /// Starts breadcrumb capture for the working day.
  Future<void> startTracking() async {
    if (_tracking) return;

    final problem = await ensurePermission(background: true);
    if (problem != null) {
      _error = problem;
      notifyListeners();
      return;
    }

    _stream = Geolocator.getPositionStream(
      locationSettings: LocationSettings(
        accuracy: LocationAccuracy.high,
        distanceFilter: AppConfig.locationDistanceFilterM,
      ),
    ).listen(
      _record,
      onError: (Object error) {
        _error = error.toString();
        notifyListeners();
      },
      cancelOnError: false,
    );

    _tracking = true;
    _error = null;
    notifyListeners();
  }

  Future<void> stopTracking() async {
    await _stream?.cancel();
    _stream = null;
    _tracking = false;
    notifyListeners();
  }

  Future<void> _record(Position position) async {
    _last = position;
    notifyListeners();

    try {
      await _db.insert('location_buffer', {
        'latitude': position.latitude,
        'longitude': position.longitude,
        'accuracyM': position.accuracy,
        'speedMps': position.speed,
        'heading': position.heading,
        'isMoving': position.speed > 0.5 ? 1 : 0,
        'recordedAt': position.timestamp.toUtc().toIso8601String(),
      });

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

  Future<int> bufferedCount() => _db.count('location_buffer');

  @override
  void dispose() {
    _stream?.cancel();
    super.dispose();
  }
}

class LocationException implements Exception {
  LocationException(this.message);
  final String message;

  @override
  String toString() => message;
}
