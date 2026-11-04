import 'package:url_launcher/url_launcher.dart';

/// Opens a customer's pin in a maps app, on the provider the company's
/// administrator chose.
///
/// Mirrors `src/lib/maps.ts` on the platform. The handset does not embed a
/// map — the rep's own maps app is better at turn-by-turn than anything we
/// would ship — so the provider setting decides which app the Directions
/// button hands off to:
///
///  * **GOOGLE** — the universal Google Maps URL, which Android routes to the
///    Google Maps app when installed and to the website otherwise.
///  * **OSM** — a `geo:` URI, which Android offers to any installed maps app
///    (OsmAnd, Organic Maps, Magic Earth…). Where nothing handles it, the
///    OpenStreetMap website.
class MapLinks {
  const MapLinks._();

  static const String google = 'GOOGLE';
  static const String osm = 'OSM';

  /// Server values arrive upper-case; anything unknown is treated as OSM,
  /// the provider that needs no account.
  static String normalise(String? provider) =>
      provider?.toUpperCase() == google ? google : osm;

  static String label(String? provider) =>
      normalise(provider) == google ? 'Google Maps' : 'OpenStreetMap';

  static String _fix(double n) => n.toStringAsFixed(6);

  /// Turn-by-turn directions to the point from where the device is.
  static Uri directions(String? provider, double lat, double lng) {
    final la = _fix(lat), ln = _fix(lng);
    if (normalise(provider) == google) {
      return Uri.parse(
        'https://www.google.com/maps/dir/?api=1&destination=$la%2C$ln',
      );
    }
    // geo: with a query shows a pin the maps app can route to.
    return Uri.parse('geo:$la,$ln?q=$la,$ln');
  }

  /// Where to go when the device has no app for the primary link.
  static Uri webFallback(String? provider, double lat, double lng) {
    final la = _fix(lat), ln = _fix(lng);
    return normalise(provider) == google
        ? Uri.parse('https://www.google.com/maps/search/?api=1&query=$la%2C$ln')
        : Uri.parse(
            'https://www.openstreetmap.org/directions?to=$la%2C$ln#map=15/$la/$ln',
          );
  }

  /// Hands the point to a maps app. Returns false only when neither the
  /// provider's link nor the web fallback could be opened.
  static Future<bool> openDirections(String? provider, double lat, double lng) async {
    final primary = directions(provider, lat, lng);
    if (await _tryLaunch(primary)) return true;
    return _tryLaunch(webFallback(provider, lat, lng));
  }

  static Future<bool> _tryLaunch(Uri uri) async {
    try {
      // canLaunchUrl is unreliable for https on Android 11+ (package
      // visibility), so attempt the launch and let the result decide.
      return await launchUrl(uri, mode: LaunchMode.externalApplication);
    } catch (_) {
      return false;
    }
  }
}
