import 'dart:convert';
import 'dart:math' as math;

/// Geo helpers mirroring the server's `src/lib/geo.ts`.
///
/// The check-in screen needs to tell the rep *before* they submit whether they
/// are inside the fence. Duplicating the maths here is deliberate: the server
/// remains the authority and recomputes on receipt, but the rep should not have
/// to wait for a round trip — and often has no signal to make one.
class Geo {
  const Geo._();

  static const double earthRadiusM = 6371000;

  static double _toRad(double deg) => deg * math.pi / 180;

  /// Great-circle distance in metres.
  static int distanceM(double lat1, double lng1, double lat2, double lng2) {
    final dLat = _toRad(lat2 - lat1);
    final dLng = _toRad(lng2 - lng1);
    final a = math.sin(dLat / 2) * math.sin(dLat / 2) +
        math.cos(_toRad(lat1)) *
            math.cos(_toRad(lat2)) *
            math.sin(dLng / 2) *
            math.sin(dLng / 2);
    return (2 * earthRadiusM * math.asin(math.min(1, math.sqrt(a)))).round();
  }

  /// Server's planning assumptions, kept in step so the app's ETAs match the
  /// itinerary the back office issued.
  static const double roadWindingFactor = 1.35;
  static const double planningSpeedKmh = 26;

  static int roadDistanceM(double lat1, double lng1, double lat2, double lng2) =>
      (distanceM(lat1, lng1, lat2, lng2) * roadWindingFactor).round();

  static int travelMinutes(int distanceM) =>
      (distanceM / 1000 / planningSpeedKmh * 60).round();

  /// Ray-casting point-in-polygon over a `[[lat, lng], …]` ring.
  static bool insidePolygon(double lat, double lng, List<List<double>> polygon) {
    if (polygon.length < 3) return false;

    var inside = false;
    for (var i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      final yi = polygon[i][0], xi = polygon[i][1];
      final yj = polygon[j][0], xj = polygon[j][1];

      final intersects = (yi > lat) != (yj > lat) &&
          lng < (xj - xi) * (lat - yi) / (yj - yi) + xi;
      if (intersects) inside = !inside;
    }
    return inside;
  }

  static List<List<double>> parseBoundary(String? raw) {
    if (raw == null || raw.isEmpty) return const [];
    try {
      final parsed = jsonDecode(raw);
      if (parsed is! List) return const [];
      return parsed
          .whereType<List>()
          .where((p) => p.length >= 2)
          .map((p) => [(p[0] as num).toDouble(), (p[1] as num).toDouble()])
          .toList();
    } catch (_) {
      return const [];
    }
  }
}

/// The local preview of what the server will decide about a check-in.
class VisitVerification {
  const VisitVerification({
    required this.verified,
    required this.distanceM,
    required this.reason,
  });

  final bool verified;
  final int? distanceM;
  final String reason;

  static const VisitVerification noPin = VisitVerification(
    verified: false,
    distanceM: null,
    reason: 'This customer has no GPS pin captured yet',
  );
}

/// Mirrors the server's `verifyVisitLocation`, including the accuracy
/// allowance — a rep standing in the shop doorway with a 60 m fix must not be
/// told they are absent by their own handset.
VisitVerification verifyVisitLocation({
  required double checkInLat,
  required double checkInLng,
  required double? customerLat,
  required double? customerLng,
  required int geofenceRadiusM,
  double? accuracyM,
}) {
  if (customerLat == null || customerLng == null) return VisitVerification.noPin;

  final distance = Geo.distanceM(checkInLat, checkInLng, customerLat, customerLng);
  final allowance = geofenceRadiusM + math.min(accuracyM ?? 0, 100).round();

  return distance <= allowance
      ? VisitVerification(
          verified: true,
          distanceM: distance,
          reason: 'You are ${distance}m from the customer',
        )
      : VisitVerification(
          verified: false,
          distanceM: distance,
          reason: 'You are ${distance}m away — outside the ${allowance}m check-in range',
        );
}
