import 'package:flutter_test/flutter_test.dart';
import 'package:raut_field/core/map_links.dart';

/// Pinned so the links stay in step with `src/lib/maps.ts` on the platform —
/// the console and the handset must send a rep to the same place.
void main() {
  const lat = -1.2864;
  const lng = 36.8172;

  group('MapLinks.normalise', () {
    test('treats anything but GOOGLE as OpenStreetMap', () {
      expect(MapLinks.normalise('GOOGLE'), 'GOOGLE');
      expect(MapLinks.normalise('google'), 'GOOGLE');
      expect(MapLinks.normalise('OSM'), 'OSM');
      expect(MapLinks.normalise(null), 'OSM');
      expect(MapLinks.normalise('mapbox'), 'OSM');
    });
  });

  group('MapLinks.directions', () {
    test('Google uses the universal directions URL', () {
      expect(
        MapLinks.directions('GOOGLE', lat, lng).toString(),
        'https://www.google.com/maps/dir/?api=1&destination=-1.286400%2C36.817200',
      );
    });

    test('OpenStreetMap hands off through a geo: URI any maps app can take', () {
      final uri = MapLinks.directions('OSM', lat, lng);
      expect(uri.scheme, 'geo');
      expect(uri.toString(), 'geo:-1.286400,36.817200?q=-1.286400,36.817200');
    });

    test("web fallbacks match the platform's externalMapUrl / directionsUrl", () {
      expect(
        MapLinks.webFallback('GOOGLE', lat, lng).toString(),
        'https://www.google.com/maps/search/?api=1&query=-1.286400%2C36.817200',
      );
      expect(
        MapLinks.webFallback('OSM', lat, lng).toString(),
        'https://www.openstreetmap.org/directions?to=-1.286400%2C36.817200#map=15/-1.286400/36.817200',
      );
    });
  });
}
